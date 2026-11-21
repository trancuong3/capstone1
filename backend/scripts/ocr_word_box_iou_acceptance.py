"""Measure OCR word-box IoU against PRIVATE independently hand-labeled photos.

Never upload image/annotation data or print OCR text, annotation words, paths
or exception messages. This is a diagnostic runner, not final acceptance.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.ocr_real_photo_benchmark import MAX_CASES, REQUIRED_ENGINES, Case, load_cases
from scripts.ocr_word_box_iou import load_manual_annotations, score_page, summarize_scores


def evaluate_iou(
    cases: list[Case],
    annotations: dict[str, list[dict[str, object]]],
    dataset_root: Path,
    *,
    expected_profile: str,
    expected_sha: str,
) -> dict[str, object]:
    # Torch before Paddle: necessary for Windows + CUDA/Paddle DLL load order.
    import torch  # noqa: F401
    from app.services.ocr_engine import extract_text_and_boxes

    results: list[dict[str, dict[str, int]]] = []
    by_condition: dict[str, list[dict[str, dict[str, int]]]] = defaultdict(list)
    failures: Counter[str] = Counter()
    profiles: Counter[str] = Counter()
    checkpoints: Counter[str] = Counter()

    for case in cases:
        try:
            output = extract_text_and_boxes(case.image.read_bytes())
            if not isinstance(output, dict):
                raise ValueError("invalid_ocr_result")
            metadata = output.get("metadata")
            if not isinstance(metadata, dict):
                raise ValueError("missing_ocr_metadata")
            engine_statuses = metadata.get("engine_statuses")
            if not isinstance(engine_statuses, dict) or any(
                engine_statuses.get(name) != "success" for name in REQUIRED_ENGINES
            ):
                raise ValueError("ocr_engine_status_invalid")
            provenance = metadata.get("vietocr_runtime_provenance")
            if not isinstance(provenance, dict) or (
                provenance.get("model_load_status") != "loaded"
                or provenance.get("model_inference_status") != "success"
                or provenance.get("fallback_reason") is not None
            ):
                raise ValueError("unverified_ocr_checkpoint")
            if provenance.get("model_profile") != expected_profile or provenance.get("checkpoint_sha256") != expected_sha:
                raise ValueError("unexpected_ocr_checkpoint")
            image_key = case.image.resolve().relative_to(dataset_root).as_posix()
            scored = score_page(output.get("words"), annotations[image_key])
            results.append(scored)
            by_condition[case.condition].append(scored)
            profiles[expected_profile] += 1
            checkpoints[expected_sha] += 1
        except Exception as error:
            # NEVER log exception text; it may contain private paths or words.
            failures[type(error).__name__] += 1

    return {
        "dataset_case_count": len(cases),
        "successful_cases": len(results),
        "failed_cases": len(cases) - len(results),
        "failure_exception_types": dict(sorted(failures.items())),
        "model_profile_counts": dict(profiles),
        "checkpoint_sha256_counts": dict(checkpoints),
        "word_box_iou": summarize_scores(results) if results else None,
        "word_box_iou_by_condition": {
            condition: {
                "successful_cases": len(scores),
                "thresholds": summarize_scores(scores),
            }
            for condition, scores in sorted(by_condition.items())
        },
        "annotation_source_claim": "manually_labeled_independent",
        "annotation_source_independently_audited": False,
        "annotation_review_required": True,
        "bbox_iou_measured": bool(results),
        "word_box_matching_contract": (
            "Maximum-cardinality one-to-one IoU matching at 0.50/0.75; "
            "exact NFC token identity (case, accents and punctuation preserved) "
            "is scored by a separate constrained maximum matching. "
            "Invalid predicted boxes remain false positives."
        ),
        "color_scoring_not_measured": True,
        "quality_thresholds_predeclared": False,
        "all_runtime_checks_passed": len(results) == len(cases),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Private pages.jsonl outside Git")
    parser.add_argument("--bbox-annotations", required=True, type=Path, help="Local independent manual labels JSONL")
    parser.add_argument("--env-file", type=Path, help="Existing local backend .env")
    parser.add_argument("--min-pages", type=int, default=10)
    parser.add_argument("--expected-profile", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--output", required=True, type=Path, help="New aggregate-only JSON filename")
    args = parser.parse_args(argv)

    if not 1 <= args.min_pages <= MAX_CASES:
        parser.error("--min-pages must be between 1 and 1000")
    if not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha):
        parser.error("--expected-sha must be a lowercase SHA-256 hex digest")
    root = args.dataset.expanduser().resolve().parent
    annotations_path = args.bbox_annotations.expanduser().resolve()
    output_path = args.output.expanduser().resolve()
    repository = BACKEND_ROOT.parent.resolve()
    if root.is_relative_to(repository):
        parser.error("Private dataset must be outside repository")
    if annotations_path.suffix.lower() != ".jsonl" or not annotations_path.is_relative_to(root):
        parser.error("--bbox-annotations must be a private JSONL inside dataset folder")
    if annotations_path == args.dataset.expanduser().resolve():
        parser.error("--bbox-annotations must not be the dataset manifest")
    if output_path.suffix.lower() != ".json" or not output_path.is_relative_to(root):
        parser.error("--output must be a new aggregate JSON inside private dataset folder")
    if output_path.exists():
        parser.error("--output exists; use a new filename")
    if args.env_file and not args.env_file.expanduser().is_file():
        parser.error("--env-file does not exist")

    # Original backend config is read at engine import time. Worktrees do not
    # inherit the .env in the developer's primary clone.
    if args.env_file:
        import os
        from dotenv import dotenv_values

        for key, value in dotenv_values(args.env_file.expanduser()).items():
            if value is not None and not (os.getenv(key) or "").strip():
                os.environ[key] = value

    try:
        cases = load_cases(args.dataset)
        if len(cases) < args.min_pages:
            raise ValueError("Not enough distinct photos")
        keys = {case.image.resolve().relative_to(root).as_posix() for case in cases}
        labels = load_manual_annotations(annotations_path, keys)
    except (OSError, ValueError) as error:
        # Do not print exception content, annotation paths, or text.
        print(f"Dataset or manual annotations rejected: {type(error).__name__}", file=sys.stderr)
        return 2

    report = evaluate_iou(
        cases, labels, root, expected_profile=args.expected_profile, expected_sha=args.expected_sha
    )
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    # Exclusive write; do not overwrite a private file or existing report.
    import os

    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(encoded)
    except OSError as error:
        print(f"Unable to write aggregate report: {type(error).__name__}", file=sys.stderr)
        return 2
    print(encoded)
    return 0 if report["all_runtime_checks_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
