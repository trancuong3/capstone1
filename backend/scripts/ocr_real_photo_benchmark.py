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
) -> dict[str, object]:
    # Torch FIRST: avoids Windows shm.dll dependency-loading conflicts observed
    # with Paddle 2.6.2 imported first in the ViRead CUDA 12.6 environment.
    import torch
    from app.services.ocr_engine import extract_text_and_boxes

    latencies: list[float] = []
    chars_wrong = chars_total = words_wrong = words_total = exact = 0
    gpu_allocated: list[float] = []
    gpu_reserved: list[float] = []
    failures: Counter[str] = Counter()
    profiles: Counter[str] = Counter()
    checkpoints: Counter[str] = Counter()
    conditions: Counter[str] = Counter()

    for case in cases:
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
            chars_wrong += edit_distance(list(predicted), list(gt))
            chars_total += len(gt)
            words_wrong += edit_distance(predicted.split(), gt.split())
            words_total += len(gt.split())
            exact += predicted == gt
            latencies.append(elapsed)
            profiles[profile] += 1
            checkpoints[sha] += 1
            conditions[case.condition] += 1
            if torch.cuda.is_available():
                gpu_allocated.append(torch.cuda.max_memory_allocated() / 1024**2)
                gpu_reserved.append(torch.cuda.max_memory_reserved() / 1024**2)
        except Exception as exc:
            # Do not print exception messages: some include source paths or OCR text.
            failures[type(exc).__name__] += 1

    n = len(latencies)
    return {
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
        "real_photo_origin_and_ground_truth_manual_review_required": True,
        "bbox_and_color_acceptance_not_measured": True,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Private JSONL manifest outside repository")
    parser.add_argument("--output", type=Path, help="Optional aggregate-only JSON file outside repository")
    parser.add_argument("--min-pages", type=int, default=10, help="Minimum distinct photographed pages (default: 10)")
    parser.add_argument("--expected-profile", type=str, help="Fail if loaded VietOCR model profile differs")
    parser.add_argument("--expected-sha", type=str, help="Fail if loaded checkpoint SHA256 differs")
    parser.add_argument("--max-cer", type=float, help="Optional prespecified micro CER threshold")
    parser.add_argument("--max-wer", type=float, help="Optional prespecified micro WER threshold")
    args = parser.parse_args(argv)
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
    report = evaluate(cases, expected_profile=args.expected_profile, expected_sha=args.expected_sha)
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
    print(encoded)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    return 0 if report["all_runtime_checks_passed"] and all(thresholds.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
