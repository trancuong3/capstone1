"""Private, opt-in A/B runner for ViRead OCR Vietnamese diacritics and tail artifacts.

Evaluates a frozen OCR checkpoint on the same input pages, then measures an
offline hypothesis without changing inference or using ground truth for
proposal generation. Only aggregate numeric results are written/printed.
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
from scripts.ocr_vietnamese_artifact_ab import evaluate_case, summarize_cases


def evaluate(
    cases: list[Case], *, expected_profile: str, expected_sha: str,
) -> dict[str, object]:
    # Torch first avoids known Windows CUDA/Paddle DLL import-order failures.
    import torch  # noqa: F401
    from app.services.ocr_engine import extract_text_and_boxes

    results: list[dict[str, object]] = []
    by_condition: dict[str, list[dict[str, object]]] = {}
    failures: Counter[str] = Counter()
    for case in cases:
        try:
            output = extract_text_and_boxes(case.image.read_bytes())
            verify_ocr_output(
                output, expected_profile=expected_profile, expected_sha=expected_sha,
            )
            row = evaluate_case(case.truth, output)
            results.append(row)
            by_condition.setdefault(case.condition, []).append(row)
        except Exception as exc:
            # Never print exception messages, input images, or OCR/GT text.
            failures[type(exc).__name__] += 1

    return {
        "dataset_case_count": len(cases),
        "successful_cases": len(results),
        "failed_cases": len(cases) - len(results),
        "failure_exception_types": dict(sorted(failures.items())),
        "model_profile_counts": {expected_profile: len(results)},
        "checkpoint_sha256_counts": {expected_sha: len(results)},
        "quality": summarize_cases(results) if results else None,
        "quality_by_condition": {
            condition: {
                "successful_cases": len(rows),
                "quality": summarize_cases(rows),
            }
            for condition, rows in sorted(by_condition.items())
        },
        "runtime_all_cases_verified": len(results) == len(cases),
        "actual_photo_provenance_independently_verified": False,
        "ground_truth_manual_review_required": True,
        "bbox_accuracy_and_reading_colors_not_measured": True,
        "quality_thresholds_predeclared": False,
        "model_or_inference_changed": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Private pages.jsonl outside repo")
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--min-pages", type=int, default=10)
    parser.add_argument("--expected-profile", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--output", required=True, type=Path, help="New private aggregate JSON")
    args = parser.parse_args(argv)

    dataset = args.dataset.expanduser().resolve()
    output = args.output.expanduser().resolve()
    repo_root = BACKEND_ROOT.parent.resolve()
    root = dataset.parent

    if root.is_relative_to(repo_root):
        parser.error("Private dataset must remain outside Git repository")
    if not 1 <= args.min_pages <= MAX_CASES:
        parser.error("--min-pages out of supported range")
    if not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha):
        parser.error("Invalid lowercase SHA-256")
    if output.parent != root or output.suffix.lower() != ".json" or output.exists():
        parser.error("Use a new aggregate .json directly under the private dataset root")
    if not args.env_file.expanduser().is_file():
        parser.error("--env-file missing")
    try:
        cases = load_cases(dataset)
        if len(cases) < args.min_pages:
            raise ValueError("Not enough distinct cases")
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
        print(f"Offline diagnostic failed: {type(exc).__name__}", file=sys.stderr)
        return 2

    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    try:
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(encoded)
    except OSError as exc:
        print(f"Cannot save aggregate: {type(exc).__name__}", file=sys.stderr)
        return 2

    print(encoded)
    return 0 if report["runtime_all_cases_verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
