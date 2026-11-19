"""Offline comparison of v2 lyric marks; never calls an aligner or a provider.

Run with the existing backend environment. This measures one prepared case,
not engine readiness. Missing/invalid marks remain in the reference denominator.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import statistics
import sys

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.schemas.karaoke import Lyrics, MAX_AUDIO_BYTES, MAX_DURATION_MS
from app.services.karaoke_lyrics import timing_issues
from app.services.karaoke_media_service import inspect_audio

MAX_JSON_BYTES = 2 * 1024 * 1024


def _shape(lyrics):
    """Compare stable IDs and ordered text, including repeated lines."""
    return [
        (line.id, " ".join(line.text.split()), [
            (unit.id, " ".join(unit.text.split())) for unit in line.syllables
        ])
        for line in lyrics.lines
    ]


def _p95(values):
    """Nearest rank, with no invented value when coverage is empty."""
    return sorted(values)[math.ceil(len(values) * 0.95) - 1] if values else None


def evaluate(reference, prediction, duration_ms, tolerance_ms=250):
    """Return all-unit rates and matched-only errors for one annotated case.

    Omitted/reordered IDs fail input validation. Unaligned units must be kept
    with null marks. Invalid prediction spans cannot contribute successful hits.
    """
    if type(duration_ms) is not int or not 1 <= duration_ms <= MAX_DURATION_MS:
        raise ValueError("Invalid duration")
    if type(tolerance_ms) is not int or not 0 <= tolerance_ms <= MAX_DURATION_MS:
        raise ValueError("Invalid tolerance")
    ref = Lyrics.model_validate(reference)
    pred = Lyrics.model_validate(prediction)
    if ref.format_version != 2 or pred.format_version != 2 or not ref.lines:
        raise ValueError("Nonempty v2 lyrics required")
    if timing_issues(ref, duration_ms):
        raise ValueError("Reference must have complete, valid marks")
    if _shape(ref) != _shape(pred):
        raise ValueError("Ordered lyric identities/text must match reference")

    issues = timing_issues(pred, duration_ms)
    invalid_lines = {issue.line_id for issue in issues if issue.syllable_id is None}
    invalid_units = {issue.syllable_id for issue in issues if issue.syllable_id}
    onset_errors, end_errors = [], []
    total = onset_hits = end_hits = correction_lines = 0
    for ref_line, pred_line in zip(ref.lines, pred.lines):
        line_needs_correction = False
        for ref_unit, pred_unit in zip(ref_line.syllables, pred_line.syllables):
            total += 1
            valid = (
                pred_line.id not in invalid_lines
                and pred_unit.id not in invalid_units
                and pred_unit.start_ms is not None
                and pred_unit.end_ms is not None
            )
            if not valid:
                line_needs_correction = True
                continue
            onset = abs(pred_unit.start_ms - ref_unit.start_ms)
            end = abs(pred_unit.end_ms - ref_unit.end_ms)
            onset_errors.append(onset)
            end_errors.append(end)
            onset_hits += onset <= tolerance_ms
            end_hits += end <= tolerance_ms
            line_needs_correction |= onset > tolerance_ms or end > tolerance_ms
        correction_lines += line_needs_correction

    return {
        "reference_syllables": total,
        "valid_predicted_syllables": len(onset_errors),
        "missing_or_invalid_syllables": total - len(onset_errors),
        "coverage": len(onset_errors) / total,
        "tolerance_ms": tolerance_ms,
        "onset_hits": onset_hits,
        "onset_hit_rate_all_reference": onset_hits / total,
        "end_hits": end_hits,
        "end_hit_rate_all_reference": end_hits / total,
        "onset_median_ms_matched_only": statistics.median(onset_errors) if onset_errors else None,
        "onset_p95_ms_matched_only": _p95(onset_errors),
        "end_median_ms_matched_only": statistics.median(end_errors) if end_errors else None,
        "end_p95_ms_matched_only": _p95(end_errors),
        "lines_needing_correction": correction_lines,
        "structural_issue_count": len(issues),
        "onset_target_met_this_case": onset_hits / total >= 0.90,
        "quality_gate_status": "NOT_EVALUATED",
    }


def _read_bounded(path, limit):
    with Path(path).open("rb") as stream:
        content = stream.read(limit + 1)
    if len(content) > limit:
        raise ValueError("Input exceeds limit")
    return content


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("Non-finite JSON value")


def _load_json(content):
    return json.loads(content.decode("utf-8-sig"), object_pairs_hook=_unique_object,
                      parse_constant=_invalid_constant)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--prediction", type=Path, required=True)
    parser.add_argument("--evidence-kind", choices=("synthetic", "manual", "engine"), required=True)
    parser.add_argument("--engine-id", help="Pinned run label; required for engine evidence")
    args = parser.parse_args(argv)
    try:
        if args.engine_id and not re.fullmatch(r"[A-Za-z0-9._:/@+-]{1,128}", args.engine_id):
            raise ValueError("Invalid engine label")
        if args.evidence_kind == "engine" and not args.engine_id:
            raise ValueError("Engine identity required")
        audio = _read_bounded(args.audio, MAX_AUDIO_BYTES)
        media = inspect_audio(audio)
        reference_bytes = _read_bounded(args.reference, MAX_JSON_BYTES)
        prediction_bytes = _read_bounded(args.prediction, MAX_JSON_BYTES)
        report = evaluate(_load_json(reference_bytes), _load_json(prediction_bytes), media.duration_ms)
        report.update({
            "schema_version": 1,
            "evidence_kind": args.evidence_kind,
            "engine_id": args.engine_id,
            "provenance_verified": False,
            "audio_sha256": media.sha256,
            "duration_ms": media.duration_ms,
            "reference_sha256": hashlib.sha256(reference_bytes).hexdigest(),
            "prediction_sha256": hashlib.sha256(prediction_bytes).hexdigest(),
        })
        print(json.dumps(report, sort_keys=True, allow_nan=False))
        return 0
    except (ValueError, OSError, TypeError, KeyError, RecursionError, HTTPException):
        # Avoid echoing input lyrics, paths or diagnostics from media libraries.
        print(json.dumps({"status": "INVALID_INPUT", "quality_gate_status": "NOT_EVALUATED"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
