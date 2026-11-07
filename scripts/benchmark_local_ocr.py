#!/usr/bin/env python3
"""Measure local Ollama OCR correction against a private JSONL test corpus.

The report contains aggregate metrics only. It never prints or writes OCR text,
ground truth, image paths, or image bytes. This script never pulls a model and
uses the loopback-only provider configuration from the backend.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import sys
import time
import unicodedata
from pathlib import Path
from statistics import mean
from typing import cast

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig, LocalOcrCorrector


_TOKEN_PATTERN = re.compile(r"\S+", re.UNICODE)
_MODEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}")


def _distance(left: list[str] | str, right: list[str] | str) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_item in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_item in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_item != right_item),
                )
            )
        previous = current
    return previous[-1]


def _normalized_text(value: str) -> str:
    return unicodedata.normalize("NFC", " ".join(value.split()))


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def _load_cases(dataset: Path) -> list[dict[str, object]]:
    cases: list[dict[str, object]] = []
    with dataset.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON on line {line_number}") from exc
            if not isinstance(item, dict):
                raise ValueError(f"line {line_number} must contain an object")
            image = item.get("image")
            ocr_text = item.get("ocr_text")
            ground_truth = item.get("ground_truth")
            boxes = item.get("boxes")
            if (
                not isinstance(image, str)
                or not isinstance(ocr_text, str)
                or not isinstance(ground_truth, str)
                or not isinstance(boxes, list)
                or not image.strip()
                or not ocr_text.strip()
                or not ground_truth.strip()
            ):
                raise ValueError(f"line {line_number} has missing or invalid fields")
            source_tokens = _TOKEN_PATTERN.findall(ocr_text)
            if len(source_tokens) != len(boxes):
                raise ValueError(f"line {line_number} token count does not match boxes")
            if any(
                not isinstance(box, (list, tuple))
                or len(box) != 4
                or any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in box)
                or any(not math.isfinite(float(value)) for value in box)
                or float(box[0]) < 0
                or float(box[1]) < 0
                or float(box[2]) <= 0
                or float(box[3]) <= 0
                or float(box[0]) + float(box[2]) > 1
                or float(box[1]) + float(box[3]) > 1
                for box in boxes
            ):
                raise ValueError(f"line {line_number} has invalid normalized box coordinates")
            image_path = Path(image)
            if not image_path.is_absolute():
                image_path = dataset.parent / image_path
            if not image_path.is_file():
                raise ValueError(f"line {line_number} references a missing image")
            cases.append(
                {
                    "image_path": image_path,
                    "ocr_text": unicodedata.normalize("NFC", ocr_text),
                    "ground_truth": unicodedata.normalize("NFC", ground_truth),
                    "boxes": [tuple(float(value) for value in box) for box in boxes],
                }
            )
    if not cases:
        raise ValueError("dataset contains no cases")
    return cases


async def _evaluate(cases: list[dict[str, object]]) -> dict[str, object]:
    config = LocalOcrConfig.from_environment()
    corrector = LocalOcrCorrector(config)
    elapsed_ms: list[float] = []
    character_errors: list[float] = []
    word_errors: list[float] = []
    exact_matches = 0
    attempted_changes = 0
    useful_changes = 0
    harmful_changes = 0
    failed_cases = 0

    for case in cases:
        source_text = str(case["ocr_text"])
        ground_truth = str(case["ground_truth"])
        started = time.perf_counter()
        try:
            corrected = await corrector.correct(
                source_text,
                Path(case["image_path"]).read_bytes(),
                cast(list[tuple[float, float, float, float]], case["boxes"]),
            )
        except (LocalCorrectionError, OSError):
            failed_cases += 1
            continue
        elapsed_ms.append((time.perf_counter() - started) * 1000)

        normalized_result = _normalized_text(corrected)
        normalized_truth = _normalized_text(ground_truth)
        result_chars = list(normalized_result)
        truth_chars = list(normalized_truth)
        result_words = normalized_result.split()
        truth_words = normalized_truth.split()
        character_errors.append(_distance(result_chars, truth_chars) / max(1, len(truth_chars)))
        word_errors.append(_distance(result_words, truth_words) / max(1, len(truth_words)))
        exact_matches += normalized_result == normalized_truth

        source_words = _normalized_text(source_text).split()
        if len(source_words) == len(result_words) == len(truth_words):
            for source, result, target in zip(source_words, result_words, truth_words):
                if result != source:
                    attempted_changes += 1
                    if result == target:
                        useful_changes += 1
                    else:
                        harmful_changes += 1

    successful = len(elapsed_ms)
    return {
        "model": config.model,
        "successful_cases": successful,
        "failed_cases": failed_cases,
        "exact_match_rate": exact_matches / successful if successful else 0.0,
        "mean_cer": mean(character_errors) if character_errors else 0.0,
        "mean_wer": mean(word_errors) if word_errors else 0.0,
        "proposed_word_changes": attempted_changes,
        "useful_word_changes": useful_changes,
        "harmful_word_changes": harmful_changes,
        "first_case_ms": elapsed_ms[0] if elapsed_ms else None,
        "p50_case_ms": _percentile(elapsed_ms, 0.50),
        "p95_case_ms": _percentile(elapsed_ms, 0.95),
        "total_elapsed_ms": sum(elapsed_ms),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Private JSONL corpus; never add it to Git")
    parser.add_argument("--model", help="Installed Ollama model tag; this command never pulls models")
    parser.add_argument("--output", type=Path, help="Optional aggregate-only JSON report path")
    args = parser.parse_args()

    if args.model:
        if not _MODEL_PATTERN.fullmatch(args.model):
            parser.error("invalid model tag")
        os.environ["LOCAL_OCR_MODEL"] = args.model

    try:
        cases = _load_cases(args.dataset.resolve())
        report = asyncio.run(_evaluate(cases))
    except (OSError, ValueError, LocalCorrectionError) as exc:
        print(f"Benchmark could not run: {exc}", file=sys.stderr)
        return 2

    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    print(encoded)
    if args.output:
        args.output.write_text(encoded + "\n", encoding="utf-8")
    return 1 if report["failed_cases"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
