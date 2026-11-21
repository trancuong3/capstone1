"""Private real-photo quality benchmark for the *production* ViRead OCR pipeline.

No image data, OCR text, ground truth, or file paths are emitted in reports.
This is an opt-in local acceptance aid, not a production upload or DB script.
Synthetic fixtures must not be presented as real-photo acceptance evidence.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import sys
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_CASES = 1000
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
CONDITION_PATTERN = re.compile(r"[a-z][a-z0-9_-]{0,39}\Z")
REQUIRED_ENGINES = ("paddleocr", "vietocr", "tesseract")


@dataclass(frozen=True)
class Case:
    image: Path
    truth: str
    condition: str


def normalize(text: str) -> str:
    """NFC + whitespace normalization; DO NOT fold Vietnamese diacritics."""
    return unicodedata.normalize("NFC", " ".join(text.split()))


def edit_distance(left: list[str], right: list[str]) -> int:
    """Levenshtein distance with O(min(n, m)) space."""
    if len(right) > len(left):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for row, a in enumerate(left, 1):
        current = [row]
        for col, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[col] + 1, previous[col - 1] + (a != b)))
        previous = current
    return previous[-1]


def load_cases(manifest: Path) -> list[Case]:
    root = manifest.resolve().parent
    cases: list[Case] = []
    seen: set[Path] = set()
    with manifest.open("r", encoding="utf-8-sig") as file:
        for line_no, line in enumerate(file, 1):
            if not line.strip():
                continue
            if len(cases) >= MAX_CASES:
                raise ValueError(f"Too many cases (max {MAX_CASES})")
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Case at line {line_no}: invalid JSON") from exc
            if not isinstance(row, dict):
                raise ValueError(f"Case at line {line_no}: expected object")
            name, truth = row.get("image"), row.get("ground_truth")
            condition = row.get("condition", "unspecified")
            if not isinstance(name, str) or not name.strip() or not isinstance(truth, str) or not normalize(truth):
                raise ValueError(f"Case at line {line_no}: image and independent ground_truth are required")
            if not isinstance(condition, str) or not CONDITION_PATTERN.fullmatch(condition):
                raise ValueError(f"Case at line {line_no}: invalid condition label")
            requested = Path(name)
            if requested.is_absolute():
                raise ValueError(f"Case at line {line_no}: use an image path relative to manifest")
            resolved = (root / requested).resolve()
            if not resolved.is_relative_to(root) or resolved.suffix.lower() not in IMAGE_SUFFIXES:
                raise ValueError(f"Case at line {line_no}: invalid image path or extension")
            if resolved in seen:
                raise ValueError(f"Case at line {line_no}: duplicate image")
            if not resolved.is_file():
                raise ValueError(f"Case at line {line_no}: image not found")
            if not 0 < resolved.stat().st_size <= MAX_IMAGE_BYTES:
                raise ValueError(f"Case at line {line_no}: image is empty or exceeds 12 MiB")
            seen.add(resolved)
            cases.append(Case(resolved, normalize(truth), condition))
    if not cases:
        raise ValueError("Dataset is empty")
    return cases


def percentile(data: list[float], quantile: float) -> float | None:
    if not data:
        return None
    values = sorted(data)
    return round(values[max(0, math.ceil(len(values) * quantile) - 1)], 2)


def evaluate(
    cases: list[Case], *, expected_profile: str | None, expected_sha: str | None,
    private_error_records: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    # Torch FIRST: avoids Windows shm.dll dependency-loading conflicts observed
    # with Paddle 2.6.2 imported first in the ViRead CUDA 12.6 environment.
    import torch
    from app.services.ocr_engine import extract_text_and_boxes

    latencies: list[float] = []
    chars_wrong = chars_total = words_wrong = words_total = exact = 0
    neutral_words_wrong = neutral_words_total = 0
    gpu_allocated: list[float] = []
    gpu_reserved: list[float] = []
    failures: Counter[str] = Counter()
    profiles: Counter[str] = Counter()
    checkpoints: Counter[str] = Counter()
    conditions: Counter[str] = Counter()
    condition_quality: dict[str, dict[str, int]] = {}

    for case_index, case in enumerate(cases, 1):
        try:
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.reset_peak_memory_stats()
            began = time.perf_counter()
            output = extract_text_and_boxes(case.image.read_bytes())
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            elapsed = (time.perf_counter() - began) * 1000
            if not isinstance(output, dict) or not isinstance(output.get("text"), str):
                raise ValueError("invalid_ocr_output")
            metadata = output.get("metadata")
            if not isinstance(metadata, dict):
                raise ValueError("missing_metadata")
            status = metadata.get("engine_statuses")
            if not isinstance(status, dict) or any(status.get(key) != "success" for key in REQUIRED_ENGINES):
                raise ValueError("engine_not_successful")
            provenance = metadata.get("vietocr_runtime_provenance")
            if not isinstance(provenance, dict) or provenance.get("model_load_status") != "loaded" or provenance.get("model_inference_status") != "success" or provenance.get("fallback_reason") is not None:
                raise ValueError("model_not_verified_or_fallback")
            profile = provenance.get("model_profile")
            sha = provenance.get("checkpoint_sha256")
            if not isinstance(profile, str) or not isinstance(sha, str) or not re.fullmatch(r"[a-f0-9]{64}", sha):
                raise ValueError("invalid_model_provenance")
            if expected_profile is not None and profile != expected_profile:
                raise ValueError("unexpected_profile")
            if expected_sha is not None and sha != expected_sha:
                raise ValueError("unexpected_checkpoint")
            predicted = normalize(output["text"])
            gt = case.truth
            private_record = None
            if private_error_records is not None:
                from scripts.ocr_word_error_diagnostics import analyze_word_errors
                private_record = {
                    "case_number": case_index,
                    "condition": case.condition,
                    **analyze_word_errors(gt, predicted),
                }
            from scripts.ocr_word_error_diagnostics import edge_punctuation_neutral_tokens
            neutral_gt = edge_punctuation_neutral_tokens(gt)
            neutral_predicted = edge_punctuation_neutral_tokens(predicted)
            neutral_edits = edit_distance(neutral_predicted, neutral_gt)
            neutral_words_wrong += neutral_edits
            neutral_words_total += len(neutral_gt)
            chars_wrong += edit_distance(list(predicted), list(gt))
            chars_total += len(gt)
            words_wrong += edit_distance(predicted.split(), gt.split())
            words_total += len(gt.split())
            exact += predicted == gt
            latencies.append(elapsed)
            profiles[profile] += 1
            checkpoints[sha] += 1
            conditions[case.condition] += 1
            # Only aggregated statistics; never emit OCR text or source paths.
            bucket = condition_quality.setdefault(case.condition, {
                "successful_cases": 0, "exact_page_matches": 0,
                "character_edits": 0, "reference_characters": 0,
                "word_edits": 0, "reference_words": 0,
                "edge_punctuation_neutral_word_edits": 0,
                "edge_punctuation_neutral_reference_words": 0,
            })
            bucket["successful_cases"] += 1
            bucket["exact_page_matches"] += int(predicted == gt)
            bucket["character_edits"] += edit_distance(list(predicted), list(gt))
            bucket["reference_characters"] += len(gt)
            bucket["word_edits"] += edit_distance(predicted.split(), gt.split())
            bucket["reference_words"] += len(gt.split())
            bucket["edge_punctuation_neutral_word_edits"] += neutral_edits
            bucket["edge_punctuation_neutral_reference_words"] += len(neutral_gt)
            if torch.cuda.is_available():
                gpu_allocated.append(torch.cuda.max_memory_allocated() / 1024**2)
                gpu_reserved.append(torch.cuda.max_memory_reserved() / 1024**2)
            if private_record is not None and private_error_records is not None:
                private_error_records.append(private_record)
        except Exception as exc:
            # Do not print exception messages: some include source paths or OCR text.
            failures[type(exc).__name__] += 1

    n = len(latencies)
    report = {
        "dataset_case_count": len(cases),
        "successful_cases": n,
        "failed_cases": len(cases) - n,
        "failure_exception_types": dict(failures),
        "recognition": {
            "exact_page_match_rate": round(exact / n, 6) if n else None,
            "micro_cer": round(chars_wrong / chars_total, 6) if chars_total else None,
            "micro_wer": round(words_wrong / words_total, 6) if words_total else None,
            "character_edits": chars_wrong,
            "reference_characters": chars_total,
            "word_edits": words_wrong,
            "reference_words": words_total,
            "edge_punctuation_neutral_wer": round(
                neutral_words_wrong / neutral_words_total, 6
            ) if neutral_words_total else None,
            "edge_punctuation_neutral_word_edits": neutral_words_wrong,
            "edge_punctuation_neutral_reference_words": neutral_words_total,
            "edge_punctuation_neutral_note": (
                "Diagnostic only: removes punctuation/symbols at token edges, "
                "preserves Vietnamese diacritics, case and internal punctuation; "
                "not interchangeable with strict micro_wer"
            ),
        },
        "timing_ms": {
            "mean": round(statistics.mean(latencies), 2) if n else None,
            "p50": percentile(latencies, 0.50),
            "p95": percentile(latencies, 0.95),
            "max": round(max(latencies), 2) if n else None,
        },
        "gpu": {
            "torch_cuda_available": torch.cuda.is_available(),
            "torch_max_allocated_mib": round(max(gpu_allocated), 2) if gpu_allocated else None,
            "torch_max_reserved_mib": round(max(gpu_reserved), 2) if gpu_reserved else None,
            "note": "PyTorch CUDA allocator only, not total driver/GPU memory",
        },
        "runtime": {
            "model_profile_counts": dict(profiles),
            "checkpoint_sha256_counts": dict(checkpoints),
            "engine_contract": list(REQUIRED_ENGINES),
        },
        "conditions_case_counts": dict(conditions),
        "quality_by_condition": {
            condition: {
                "successful_cases": bucket["successful_cases"],
                "exact_page_match_rate": round(
                    bucket["exact_page_matches"] / bucket["successful_cases"], 6
                ),
                "micro_cer": round(
                    bucket["character_edits"] / bucket["reference_characters"], 6
                ) if bucket["reference_characters"] else None,
                "micro_wer": round(
                    bucket["word_edits"] / bucket["reference_words"], 6
                ) if bucket["reference_words"] else None,
                "character_edits": bucket["character_edits"],
                "reference_characters": bucket["reference_characters"],
                "word_edits": bucket["word_edits"],
                "reference_words": bucket["reference_words"],
                "edge_punctuation_neutral_wer": round(
                    bucket["edge_punctuation_neutral_word_edits"]
                    / bucket["edge_punctuation_neutral_reference_words"], 6
                ) if bucket["edge_punctuation_neutral_reference_words"] else None,
                "edge_punctuation_neutral_word_edits": bucket["edge_punctuation_neutral_word_edits"],
                "edge_punctuation_neutral_reference_words": bucket["edge_punctuation_neutral_reference_words"],
            }
            for condition, bucket in sorted(condition_quality.items())
        },
        "real_photo_origin_and_ground_truth_manual_review_required": True,
        "bbox_and_color_acceptance_not_measured": True,
    }
    if private_error_records is not None:
        # Only safe aggregate counts go in the standard report, never tokens.
        classes: Counter[str] = Counter()
        complete = 0
        skipped = 0
        for row in private_error_records:
            if row["status"] != "complete":
                skipped += 1
                continue
            complete += 1
            classes.update(error["kind"] for error in row["errors"])
        report["private_diagnostic_summary"] = {
            "analyzed_cases": complete,
            "skipped_cases": skipped,
            "word_error_kind_counts": dict(sorted(classes.items())),
            "alignment_note": "One of potentially multiple optimal token alignments; diagnostic only",
        }
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Private JSONL manifest outside repository")
    parser.add_argument("--output", type=Path, help="Optional aggregate-only JSON file outside repository")
    parser.add_argument("--env-file", type=Path, help="Existing local backend .env to load without printing credentials")
    parser.add_argument("--min-pages", type=int, default=10, help="Minimum distinct photographed pages (default: 10)")
    parser.add_argument("--expected-profile", type=str, help="Fail if loaded VietOCR model profile differs")
    parser.add_argument("--expected-sha", type=str, help="Fail if loaded checkpoint SHA256 differs")
    parser.add_argument("--max-cer", type=float, help="Optional prespecified micro CER threshold")
    parser.add_argument("--max-wer", type=float, help="Optional prespecified micro WER threshold")
    parser.add_argument(
        "--private-error-output", type=Path,
        help="OPT-IN sensitive JSONL with mismatched words; store only beside private dataset, never commit/share",
    )
    args = parser.parse_args(argv)
    # Worktrees do not inherit the developer's original checkout .env.  Load
    # an explicitly selected local environment file before the OCR engine
    # imports app.database.config.  Never print secrets or copy them into Git.
    if args.env_file is not None:
        import os
        from dotenv import dotenv_values

        if not args.env_file.expanduser().is_file():
            parser.error("--env-file does not exist")
        env_values = dotenv_values(args.env_file.expanduser())
        if not env_values:
            parser.error("--env-file is empty")
        # Match app.database.config's handling of *empty* process values.
        for key, value in env_values.items():
            if value is not None and not (os.getenv(key) or "").strip():
                os.environ[key] = value
    if args.min_pages < 1 or args.min_pages > MAX_CASES:
        parser.error("--min-pages must be between 1 and 1000")
    if args.expected_sha and not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha):
        parser.error("--expected-sha must be 64 lowercase SHA-256 hex characters")
    if any(x is not None and (not math.isfinite(x) or x < 0) for x in (args.max_cer, args.max_wer)):
        parser.error("CER/WER thresholds must be finite nonnegative numbers")
    if args.output and args.output.resolve().is_relative_to(BACKEND_ROOT.parent.resolve()):
        parser.error("--output must be outside repository to prevent accidental dataset disclosure")
    try:
        if args.dataset.resolve().is_relative_to(BACKEND_ROOT.parent.resolve()):
            raise ValueError("Place private dataset outside repository")
        cases = load_cases(args.dataset)
    except (OSError, ValueError) as exc:
        print(f"Dataset rejected: {type(exc).__name__}" + (f": {exc}" if isinstance(exc, ValueError) else ""), file=sys.stderr)
        return 2
    if len(cases) < args.min_pages:
        print(f"FAIL: {len(cases)} distinct cases, requires {args.min_pages}", file=sys.stderr)
        return 2
    private_path = args.private_error_output.expanduser().resolve() if args.private_error_output else None
    if private_path is not None:
        # Diagnostics contain OCR and ground-truth words, unlike the aggregate.
        # Explicitly restrict storage to the private dataset's own directory tree.
        if private_path.suffix.lower() != ".jsonl":
            parser.error("--private-error-output must end with .jsonl")
        if not private_path.is_relative_to(args.dataset.resolve().parent):
            parser.error("--private-error-output must be within the private dataset directory")
        if private_path == args.dataset.resolve():
            parser.error("--private-error-output cannot replace the dataset manifest")
        if args.output and private_path == args.output.resolve():
            parser.error("--private-error-output cannot replace the aggregate report")
        if args.env_file and private_path == args.env_file.resolve():
            parser.error("--private-error-output cannot replace the environment file")
        if private_path.exists():
            parser.error("--private-error-output already exists; choose a new filename")
    private_errors: list[dict[str, object]] | None = [] if private_path else None
    if private_errors is None:
        report = evaluate(cases, expected_profile=args.expected_profile, expected_sha=args.expected_sha)
    else:
        report = evaluate(
            cases, expected_profile=args.expected_profile, expected_sha=args.expected_sha,
            private_error_records=private_errors,
        )
    metrics = report["recognition"]
    thresholds = {}
    if args.max_cer is not None:
        thresholds["micro_cer"] = metrics["micro_cer"] is not None and metrics["micro_cer"] <= args.max_cer
    if args.max_wer is not None:
        thresholds["micro_wer"] = metrics["micro_wer"] is not None and metrics["micro_wer"] <= args.max_wer
    report["thresholds_passed"] = thresholds
    report["all_runtime_checks_passed"] = report["failed_cases"] == 0
    report["quality_thresholds_predeclared"] = bool(thresholds)
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if private_path is not None and private_errors is not None:
        import os
        try:
            private_path.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive create avoids overwriting any existing user file.
            fd = os.open(private_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as diagnostics_file:
                for row in private_errors:
                    diagnostics_file.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError as exc:
            print(f"Could not write private diagnostics: {type(exc).__name__}", file=sys.stderr)
            return 2
    print(encoded)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    return 0 if report["all_runtime_checks_passed"] and all(thresholds.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
