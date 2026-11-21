"""Reference-blind Vietnamese tone selection experiments.

Pure offline hypotheses on existing OCR engine evidence. These proposals
MUST NOT be used for production words, reading colors, or ground-truth labels.
No reference text is accessible to propose_text() or choose_word().
"""
from __future__ import annotations

import unicodedata
from collections import Counter

from scripts.ocr_real_photo_benchmark import normalize
from scripts.ocr_word_error_diagnostics import analyze_word_errors
from scripts.ocr_vietnamese_artifact_ab import (
    _base_letters, _core, _word_surface_sequence, score_pair,
)

RULES = (
    "line_majority_2",
    "vietocr_line_priority",
    "paddleocr_line_priority",
    "paddle_line_vietocr_crop_agreement",
)
ENGINES = ("paddleocr", "vietocr", "tesseract")


def _surface_parts(value: str) -> tuple[str, str, str]:
    """Preserve punctuation instead of replacing quoted/apostrophized words."""
    start = 0
    end = len(value)
    while start < end and unicodedata.category(value[start]).startswith(("P", "S")):
        start += 1
    while end > start and unicodedata.category(value[end - 1]).startswith(("P", "S")):
        end -= 1
    return value[:start], value[start:end], value[end:]


def _case_like(reading: str, original: str) -> str | None:
    if original.isupper():
        return reading.upper()
    if original.islower():
        return reading.lower()
    if original.istitle():
        return reading.title()
    # Do not change mixed-case words to make a candidate fit.
    return reading if reading == original else None


def _engine_readings(word: dict[str, object]) -> dict[str, str]:
    current_core = _core(word.get("text"))
    evidence = word.get("ocr_evidence")
    if not current_core or not isinstance(evidence, dict):
        return {}
    outputs = evidence.get("engine_outputs")
    statuses = evidence.get("engine_statuses")
    if not isinstance(outputs, dict) or not isinstance(statuses, dict):
        return {}
    result: dict[str, str] = {}
    for name in ENGINES:
        if statuses.get(name) != "success":
            continue
        reading = _core(outputs.get(name))
        if not reading or _base_letters(reading) != _base_letters(current_core):
            continue
        result[name] = reading
    return result


def choose_word(word: dict[str, object], rule: str) -> str | None:
    """Offer a full word surface using engine outputs, not reference text."""
    if rule not in RULES:
        raise ValueError("Unknown policy")
    original = word.get("text")
    if not isinstance(original, str):
        return None
    leading, core, trailing = _surface_parts(original)
    if not core or _core(original) != core:
        return None
    readings = _engine_readings(word)
    if not readings:
        return None

    choice: str | None = None
    if rule == "vietocr_line_priority":
        choice = readings.get("vietocr")
    elif rule == "paddleocr_line_priority":
        # High-risk A/B CONTROL: measures both gains and regressions from
        # blindly trusting the PaddleOCR line instead of the chosen token.
        choice = readings.get("paddleocr")
    elif rule == "paddle_line_vietocr_crop_agreement":
        # Two distinct recognizers must support the SAME reading. A repeated
        # Paddle crop does NOT count as another independent engine.
        evidence = word.get("ocr_evidence")
        crop = evidence.get("crop_evidence") if isinstance(evidence, dict) else None
        statuses = evidence.get("engine_statuses") if isinstance(evidence, dict) else None
        paddle = readings.get("paddleocr")
        viet_crop = _core(crop.get("vietocr_candidate")) if isinstance(crop, dict) else ""
        if (
            paddle
            and isinstance(crop, dict)
            and crop.get("status") == "completed"
            and crop.get("vietocr_error") is None
            and isinstance(statuses, dict)
            and statuses.get("vietocr") == "success"
            and viet_crop
            and viet_crop.casefold() == paddle.casefold()
        ):
            choice = paddle
    else:
        counts = Counter(value.casefold() for value in readings.values())
        eligible = [
            key for key, votes in counts.items()
            if votes >= 2 and all(
                votes > competitor_votes
                for competitor_key, competitor_votes in counts.items()
                if competitor_key != key
            )
        ]
        if len(eligible) == 1:
            selected_key = eligible[0]
            choice = next(
                value for value in readings.values()
                if value.casefold() == selected_key
            )
    if choice is None or choice.casefold() == core.casefold():
        return None
    surfaced = _case_like(choice, core)
    if surfaced is None or _base_letters(surfaced) != _base_letters(core):
        return None
    if surfaced == core:
        return None
    return leading + surfaced + trailing


def propose_text(output: dict[str, object], rule: str) -> dict[str, object]:
    """Apply a predefined blind rule only when word/text mapping is exact."""
    if rule not in RULES:
        raise ValueError("Unknown policy")
    alignment = _word_surface_sequence(output)
    if alignment is None:
        return {"status": "not_evaluable", "candidate_text": None,
                "flip_indices": []}
    words, tokens = alignment
    proposed: list[str] = list(tokens)
    changed: list[int] = []
    for index, word in enumerate(words):
        replacement = choose_word(word, rule)
        if replacement is not None and replacement != tokens[index]:
            proposed[index] = replacement
            changed.append(index)
    return {
        "status": "proposed_review_only" if changed else "no_proposal",
        "candidate_text": " ".join(proposed),
        "flip_indices": changed,
    }


def _evidence_source_sets(word: dict[str, object]) -> tuple[set[str], set[str], set[str]]:
    """Return different-tone readings by source, never using the reference."""
    selected = _core(word.get("text"))
    evidence = word.get("ocr_evidence")
    if not selected or not isinstance(evidence, dict):
        return set(), set(), set()
    outputs = evidence.get("engine_outputs")
    statuses = evidence.get("engine_statuses")
    crops = evidence.get("crop_evidence")
    raw_line, verified_line, crop = set(), set(), set()
    if isinstance(outputs, dict):
        for engine in ENGINES:
            reading = _core(outputs.get(engine))
            if (
                reading and reading.casefold() != selected.casefold()
                and _base_letters(reading) == _base_letters(selected)
            ):
                raw_line.add(reading)
                if isinstance(statuses, dict) and statuses.get(engine) == "success":
                    verified_line.add(reading)
    if isinstance(crops, dict):
        for key in ("paddleocr_candidate", "vietocr_candidate", "tesseract_candidate"):
            reading = _core(crops.get(key))
            if (
                reading and reading.casefold() != selected.casefold()
                and _base_letters(reading) == _base_letters(selected)
            ):
                crop.add(reading)
    return raw_line, verified_line, crop


def audit_evidence_sources(output: dict[str, object]) -> dict[str, int]:
    """Count candidate provenance without emitting text, paths or bbox data."""
    names = (
        "audited_pages", "unaligned_pages", "word_positions",
        "positions_with_any_alternative",
        "positions_with_raw_line_alternative",
        "positions_with_verified_line_alternative",
        "positions_with_crop_alternative",
        "positions_with_crop_only_alternative",
        "positions_with_raw_line_but_no_verified_line_alternative",
        "positions_with_vietocr_line_alternative",
    )
    stats = {key: 0 for key in names}
    aligned = _word_surface_sequence(output)
    if aligned is None:
        stats["unaligned_pages"] = 1
        return stats
    stats["audited_pages"] = 1
    words, _ = aligned
    stats["word_positions"] = len(words)
    for word in words:
        raw_line, verified_line, crop = _evidence_source_sets(word)
        stats["positions_with_any_alternative"] += bool(raw_line or crop)
        stats["positions_with_raw_line_alternative"] += bool(raw_line)
        stats["positions_with_verified_line_alternative"] += bool(verified_line)
        stats["positions_with_crop_alternative"] += bool(crop)
        stats["positions_with_crop_only_alternative"] += bool(crop and not raw_line)
        stats["positions_with_raw_line_but_no_verified_line_alternative"] += bool(
            raw_line and not verified_line
        )
        evidence = word.get("ocr_evidence")
        outputs = evidence.get("engine_outputs") if isinstance(evidence, dict) else None
        statuses = evidence.get("engine_statuses") if isinstance(evidence, dict) else None
        selected = _core(word.get("text"))
        reading = _core(outputs.get("vietocr")) if isinstance(outputs, dict) else ""
        stats["positions_with_vietocr_line_alternative"] += bool(
            reading and selected and reading.casefold() != selected.casefold()
            and _base_letters(reading) == _base_letters(selected)
            and isinstance(statuses, dict) and statuses.get("vietocr") == "success"
        )
    return stats


def audit_tone_error_sources(expected: str, output: dict[str, object]) -> dict[str, int]:
    """Oracle source coverage for scoring AFTER blind-policy proposals only."""
    names = (
        "audited_tone_errors", "errors_with_correct_raw_line_reading",
        "errors_with_correct_verified_line_reading",
        "errors_with_correct_crop_reading",
        "errors_with_correct_crop_only_reading",
        "errors_with_no_correct_recorded_alternative",
        "uncertain_alignment_pages",
    )
    stats = {key: 0 for key in names}
    aligned = _word_surface_sequence(output)
    observed = output.get("text")
    if aligned is None or not isinstance(observed, str):
        stats["uncertain_alignment_pages"] = 1
        return stats
    errors = analyze_word_errors(normalize(expected), normalize(observed))
    if errors.get("status") != "complete":
        stats["uncertain_alignment_pages"] = 1
        return stats
    words, _ = aligned
    for error in errors["errors"]:
        if error.get("kind") != "diacritic_or_d_stroke":
            continue
        index = error.get("observed_position")
        if not isinstance(index, int) or not 1 <= index <= len(words):
            continue
        correct = _core(error.get("expected"))
        if not correct:
            continue
        raw_line, verified_line, crop = _evidence_source_sets(words[index - 1])
        stats["audited_tone_errors"] += 1
        got_raw = correct in raw_line
        got_verified = correct in verified_line
        got_crop = correct in crop
        stats["errors_with_correct_raw_line_reading"] += got_raw
        stats["errors_with_correct_verified_line_reading"] += got_verified
        stats["errors_with_correct_crop_reading"] += got_crop
        stats["errors_with_correct_crop_only_reading"] += got_crop and not got_raw
        stats["errors_with_no_correct_recorded_alternative"] += not (got_raw or got_crop)
    return stats


def evaluate_case(expected: str, output: dict[str, object]) -> dict[str, object]:
    """Reference is *only* used for scoring AFTER independent proposals."""
    observed = output.get("text")
    if not isinstance(observed, str):
        raise ValueError("Expected OCR output text")
    baseline = score_pair(expected, observed)
    choices = {rule: propose_text(output, rule) for rule in RULES}
    results: dict[str, object] = {}
    reference_words = normalize(expected).split()
    observed_words = normalize(observed).split()
    for rule, proposal in choices.items():
        text = proposal["candidate_text"]
        candidate = (
            score_pair(expected, text) if isinstance(text, str)
            else baseline.copy()
        )
        indices = proposal["flip_indices"]
        target_words = normalize(text).split() if isinstance(text, str) else observed_words
        positional_valid = (
            len(reference_words) == len(observed_words) == len(target_words)
        )
        corrected = regressed = neither = 0
        if positional_valid:
            for index in indices:
                before = observed_words[index] == reference_words[index]
                after = target_words[index] == reference_words[index]
                if before and not after:
                    regressed += 1
                elif not before and after:
                    corrected += 1
                else:
                    neither += 1
        results[rule] = {
            "quality": candidate,
            "status": proposal["status"],
            "flipped_words": len(indices),
            "corrected_words": corrected,
            "regressed_words": regressed,
            "other_changed_words": neither,
            "flips_without_positional_truth": 0 if positional_valid else len(indices),
            "page_cer_direction": (
                "improved" if candidate["character_edits"] < baseline["character_edits"]
                else "worsened" if candidate["character_edits"] > baseline["character_edits"]
                else "unchanged"
            ),
            "page_wer_direction": (
                "improved" if candidate["word_edits"] < baseline["word_edits"]
                else "worsened" if candidate["word_edits"] > baseline["word_edits"]
                else "unchanged"
            ),
        }
    return {
        "baseline": baseline, "rules": results,
        "evidence_source_audit": audit_evidence_sources(output),
        "tone_error_source_audit": audit_tone_error_sources(expected, output),
    }


def _sum_quality(values: list[dict[str, int]]) -> dict[str, object]:
    counts: Counter[str] = Counter()
    for value in values:
        counts.update(value)
    total_chars = counts["reference_characters"]
    total_words = counts["reference_words"]
    return {
        "character_edits": counts["character_edits"],
        "reference_characters": total_chars,
        "micro_cer": round(counts["character_edits"] / total_chars, 6) if total_chars else None,
        "word_edits": counts["word_edits"],
        "reference_words": total_words,
        "micro_wer": round(counts["word_edits"] / total_words, 6) if total_words else None,
        "exact_pages": counts["exact_pages"],
        "pages": counts["pages"],
    }


def summarize_cases(cases: list[dict[str, object]]) -> dict[str, object]:
    if not cases:
        raise ValueError("No successful cases")
    baseline = _sum_quality([case["baseline"] for case in cases])
    result: dict[str, object] = {}
    for rule in RULES:
        rows = [case["rules"][rule] for case in cases]
        totals = Counter()
        for row in rows:
            for key in (
                "flipped_words", "corrected_words", "regressed_words",
                "other_changed_words", "flips_without_positional_truth",
            ):
                totals[key] += row[key]
        result[rule] = {
            "quality": _sum_quality([row["quality"] for row in rows]),
            "status_counts": dict(sorted(Counter(row["status"] for row in rows).items())),
            "cer_page_directions": dict(sorted(Counter(row["page_cer_direction"] for row in rows).items())),
            "wer_page_directions": dict(sorted(Counter(row["page_wer_direction"] for row in rows).items())),
            **{key: totals[key] for key in (
                "flipped_words", "corrected_words", "regressed_words",
                "other_changed_words", "flips_without_positional_truth",
            )},
        }
    sources = Counter()
    tone_errors = Counter()
    for row in cases:
        sources.update(row["evidence_source_audit"])
        tone_errors.update(row["tone_error_source_audit"])
    return {
        "baseline_strict": baseline,
        "ground_truth_blind_rules": result,
        "evidence_source_audit": dict(sorted(sources.items())),
        "tone_error_source_audit": dict(sorted(tone_errors.items())),
        "note": (
            "All candidate policies read ONLY OCR evidence when proposing; reference text "
            "is used afterward to score. Corrected/regressed token flips are "
            "positional counts ONLY when reference and OCR token lengths match; "
            "all other flips are reported separately. No production changes."
        ),
        "selected_policy_for_production": None,
        "held_out_acceptance_verified": False,
        "production_inference_modified": False,
    }
