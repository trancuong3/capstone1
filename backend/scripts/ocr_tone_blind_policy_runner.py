"""Run strict reference-blind OCR tone policy A/B locally on private photos.

Proposals are calculated from the OCR word evidence and do not inspect the
ground-truth text until AFTER proposal generation. Aggregate output only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.ocr_box_tightness_probe import verify_ocr_output
from scripts.ocr_real_photo_benchmark import MAX_CASES, Case, load_cases
from scripts.ocr_tone_blind_policy import evaluate_case, summarize_cases
from scripts.ocr_vietnamese_artifact_ab_runner import _contract_failure_code


def evaluate(
    cases: list[Case], *, expected_profile: str, expected_sha: str,
) -> dict[str, object]:
    import torch  # noqa: F401  (Windows Paddle/CUDA DLL import order)
    from app.services.ocr_engine import extract_text_and_boxes

    rows: list[dict[str, object]] = []
    conditions: dict[str, list[dict[str, object]]] = {}
    failures: Counter[str] = Counter()
    stages: Counter[str] = Counter()
    contract: Counter[str] = Counter()
    for case in cases:
        output: object = None
        stage = "ocr_inference"
        try:
            output = extract_text_and_boxes(case.image.read_bytes())
            stage = "verify_engine_and_checkpoint"
            verify_ocr_output(
                output, expected_profile=expected_profile, expected_sha=expected_sha,
            )
            stage = "blind_policy_analysis"
            row = evaluate_case(case.truth, output)
            rows.append(row)
            conditions.setdefault(case.condition, []).append(row)
        except Exception as exc:
            failures[type(exc).__name__] += 1
            stages[stage] += 1
            if stage == "verify_engine_and_checkpoint":
                contract[_contract_failure_code(
                    output, expected_profile, expected_sha,
                )] += 1

    return {
        "dataset_case_count": len(cases),
        "successful_cases": len(rows),
        "failed_cases": len(cases) - len(rows),
        "failure_exception_types": dict(sorted(failures.items())),
        "failure_stage_counts": dict(sorted(stages.items())),
        "contract_failure_codes": dict(sorted(contract.items())),
        "model_profile_counts": {expected_profile: len(rows)},
        "checkpoint_sha256_counts": {expected_sha: len(rows)},
        "quality": summarize_cases(rows) if rows else None,
        "quality_by_condition": {
            condition: {"successful_cases": len(subset), "quality": summarize_cases(subset)}
            for condition, subset in sorted(conditions.items())
        },
        "runtime_all_cases_verified": len(rows) == len(cases),
        "photo_provenance_verified": False,
        "reference_independence_audited": False,
        "real_photo_iou_and_child_reading_feedback_tested": False,
        "held_out_acceptance_verified": False,
        "production_inference_modified": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--min-pages", type=int, default=10)
    parser.add_argument("--expected-profile", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)

    dataset = args.dataset.expanduser().resolve()
    output = args.output.expanduser().resolve()
    root = dataset.parent
    if root.is_relative_to(BACKEND_ROOT.parent.resolve()):
        parser.error("Private dataset must be outside the repository")
    if not 1 <= args.min_pages <= MAX_CASES:
        parser.error("Invalid --min-pages")
    if not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha):
        parser.error("Expected lowercase SHA-256")
    if output.parent != root or output.suffix.lower() != ".json" or output.exists():
        parser.error("Use a NEW private aggregate JSON outside repository")
    if not args.env_file.expanduser().is_file():
        parser.error("Missing private env file")
    try:
        cases = load_cases(dataset)
        if len(cases) < args.min_pages:
            raise ValueError("Insufficient unique image cases")
    except (OSError, ValueError) as exc:
        print(f"Invalid dataset: {type(exc).__name__}", file=sys.stderr)
        return 2

    from dotenv import dotenv_values
    for key, value in dotenv_values(args.env_file.expanduser()).items():
        if value is not None and not (os.getenv(key) or "").strip():
            os.environ[key] = value

    try:
        report = evaluate(
            cases, expected_profile=args.expected_profile, expected_sha=args.expected_sha,
        )
    except Exception as exc:
        print(f"Blind A/B failed: {type(exc).__name__}", file=sys.stderr)
        return 2
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    try:
        descriptor = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(serialized)
    except OSError as exc:
        print(f"Cannot save aggregate: {type(exc).__name__}", file=sys.stderr)
        return 2
    print(serialized)
    return 0 if report["runtime_all_cases_verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
