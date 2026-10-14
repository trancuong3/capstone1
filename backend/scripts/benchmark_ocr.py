"""Reproducible OCR comparison on a user-supplied JSON manifest with ground truth.

Manifest format:
[
  {"image": "images/page-01.jpg", "ground_truth": "Text verified by a human."}
]
Paths are resolved relative to the manifest. No book scans or ground-truth data are
bundled in the repository. Run from the backend directory:
    python -m scripts.benchmark_ocr --manifest path/to/manifest.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import unicodedata
from pathlib import Path
from typing import Sequence

from app.services.ocr_engine import extract_text_and_boxes


def normalize_for_metric(text: str) -> str:
    # Preserve Vietnamese diacritics. Normalize Unicode and whitespace only.
    return " ".join(unicodedata.normalize("NFC", text).split())


def edit_distance(left: Sequence[str], right: Sequence[str]) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for row, left_item in enumerate(left, start=1):
        current = [row]
        for column, right_item in enumerate(right, start=1):
            current.append(
                min(
                    current[column - 1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (left_item != right_item),
                )
            )
        previous = current
    return previous[-1]


def error_rate(reference: str, hypothesis: str, *, words: bool) -> float:
    reference_text = normalize_for_metric(reference)
    hypothesis_text = normalize_for_metric(hypothesis)
    reference_units = reference_text.split() if words else list(reference_text)
    hypothesis_units = hypothesis_text.split() if words else list(hypothesis_text)
    if not reference_units:
        return 0.0 if not hypothesis_units else 1.0
    return edit_distance(reference_units, hypothesis_units) / len(reference_units)


def run_benchmark(manifest_path: Path) -> dict[str, object]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, list) or not manifest:
        raise ValueError("Manifest must be a non-empty JSON array")
    base_dir = manifest_path.parent
    results: list[dict[str, object]] = []
    failed = 0

    for index, item in enumerate(manifest):
        if not isinstance(item, dict) or not isinstance(item.get("image"), str) or not isinstance(item.get("ground_truth"), str):
            raise ValueError(f"Manifest item {index} must have image and ground_truth strings")
        if not item["image"].strip() or not item["ground_truth"].strip():
            raise ValueError(f"Manifest item {index} must have a non-empty image path and verified ground_truth")
        image_path = Path(item["image"])
        if not image_path.is_absolute():
            image_path = base_dir / image_path
        ground_truth = item["ground_truth"]
        row: dict[str, object] = {"image": str(image_path), "ground_truth_chars": len(ground_truth)}
        try:
            image_bytes = image_path.read_bytes()
            baseline_started = time.perf_counter()
            baseline = extract_text_and_boxes(image_bytes, strategy="baseline")
            baseline_elapsed_ms = round((time.perf_counter() - baseline_started) * 1000, 3)
            best_started = time.perf_counter()
            improved = extract_text_and_boxes(image_bytes, strategy="best")
            best_elapsed_ms = round((time.perf_counter() - best_started) * 1000, 3)
            row.update(
                {
                    "baseline_cer": round(error_rate(ground_truth, baseline["text"], words=False), 6),
                    "baseline_wer": round(error_rate(ground_truth, baseline["text"], words=True), 6),
                    "best_cer": round(error_rate(ground_truth, improved["text"], words=False), 6),
                    "best_wer": round(error_rate(ground_truth, improved["text"], words=True), 6),
                    "baseline_elapsed_ms": baseline_elapsed_ms,
                    "best_elapsed_ms": best_elapsed_ms,
                    "best_candidate": improved["metadata"].get("selected_candidate"),
                    "best_candidate_count": improved["metadata"].get("candidate_count"),
                }
            )
        except Exception as exc:
            failed += 1
            row["error"] = type(exc).__name__
            row["error_message"] = str(exc)
        results.append(row)

    successful = [row for row in results if "best_cer" in row]
    summary: dict[str, object] = {
        "manifest": str(manifest_path),
        "total_images": len(manifest),
        "successful_images": len(successful),
        "failed_images": failed,
        "metric_definition": "NFC plus whitespace normalization; accents are preserved; CER is code-point edit distance and WER is word edit distance.",
        "results": results,
    }
    if successful:
        for key in (
            "baseline_cer",
            "baseline_wer",
            "best_cer",
            "best_wer",
            "baseline_elapsed_ms",
            "best_elapsed_ms",
        ):
            summary[f"mean_{key}"] = round(
                sum(float(row[key]) for row in successful) / len(successful), 6
            )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare the legacy one-pass OCR with the candidate-selection OCR.")
    parser.add_argument("--manifest", type=Path, required=True, help="Path to JSON manifest with image and verified ground_truth.")
    args = parser.parse_args()
    try:
        report = run_benchmark(args.manifest.resolve())
    except Exception as exc:
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False, indent=2))
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["successful_images"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
