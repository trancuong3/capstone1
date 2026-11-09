"""Book-disjoint ground-truth evaluation and Platt calibration for OCR scores.

This module never treats OCR candidates as labels. Labels are derived from the
Admin-verified reference text after NFC normalization that preserves Vietnamese
tone and vowel marks. The generated artifact is offline only; runtime activation
requires a separate compatibility review.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


class CalibrationDatasetError(ValueError):
    """Raised when ground-truth provenance or calibration compatibility is unsafe."""


SUPPORTED_CALIBRATION_SOURCES = {
    "paddle_crop_recognition_score",
    "vietocr_crop_recognition_score",
    "tesseract_raw_word_score",
}


def normalize_exact_text(value: str) -> str:
    """NFC, casefold and outer-punctuation normalization without accent folding."""
    token = unicodedata.normalize("NFC", str(value)).casefold().strip()
    while token and unicodedata.category(token[0]).startswith(("P", "S")):
        token = token[1:]
    while token and unicodedata.category(token[-1]).startswith(("P", "S")):
        token = token[:-1]
    return " ".join(token.split())


def _finite_number(value: object, field: str, row_number: int) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CalibrationDatasetError(
            f"row {row_number}: {field} must be a finite numeric raw score"
        )
    number = float(value)
    if not math.isfinite(number):
        raise CalibrationDatasetError(
            f"row {row_number}: {field} must be finite"
        )
    return number


def validate_ground_truth_rows(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate provenance and derive exact-match labels from verified text."""
    required = (
        "book_id",
        "page_revision_id",
        "source_image_hash",
        "word_index",
        "line_index",
        "bbox",
        "selected_candidate",
        "human_verified_text",
        "verification_source",
        "word_review_status",
        "engine_version",
        "preprocessing_version",
        "calibration_source",
        "calibration_score",
    )
    prepared: list[dict[str, Any]] = []
    for row_number, source in enumerate(rows, start=1):
        if not isinstance(source, dict):
            raise CalibrationDatasetError(f"row {row_number}: expected an object")
        missing = [key for key in required if key not in source]
        if missing:
            raise CalibrationDatasetError(
                f"row {row_number}: missing required fields: {', '.join(missing)}"
            )
        for key in ("book_id", "page_revision_id", "source_image_hash",
                    "selected_candidate", "human_verified_text",
                    "engine_version", "preprocessing_version", "calibration_source"):
            if not isinstance(source.get(key), str) or not source[key].strip():
                raise CalibrationDatasetError(
                    f"row {row_number}: {key} must be a non-empty string"
                )
        image_hash = source["source_image_hash"]
        if (
            len(image_hash) != 64
            or any(character not in "0123456789abcdefABCDEF" for character in image_hash)
        ):
            raise CalibrationDatasetError(
                f"row {row_number}: source_image_hash must be a 64-character SHA-256 hex digest"
            )
        if source["calibration_source"] not in SUPPORTED_CALIBRATION_SOURCES:
            raise CalibrationDatasetError(
                f"row {row_number}: calibration_source must be a word-level recognition score; "
                "line confidence and engine-agreement features are not accepted as raw word scores"
            )

        verification_source = source["verification_source"]
        review_status = source["word_review_status"]
        if verification_source not in {"admin", "verified_revision"}:
            raise CalibrationDatasetError(
                f"row {row_number}: ground truth must come from an Admin-verified source"
            )
        if review_status not in {"verified", "reference_match", "confirmed_mismatch"}:
            raise CalibrationDatasetError(
                f"row {row_number}: page verification alone is insufficient; "
                "the word must be verified, reference_match or an unambiguous confirmed_mismatch"
            )
        reference_alignment = source.get("reference_alignment")
        if review_status == "confirmed_mismatch":
            if verification_source != "verified_revision" or reference_alignment != "substitute":
                raise CalibrationDatasetError(
                    f"row {row_number}: negative labels require an unambiguous verified-reference substitution"
                )
        elif reference_alignment not in (None, "match"):
            raise CalibrationDatasetError(
                f"row {row_number}: non-mismatch label has a non-exact reference alignment"
            )

        for index_key in ("word_index", "line_index"):
            index_value = source[index_key]
            if isinstance(index_value, bool) or not isinstance(index_value, int) or index_value < 0:
                raise CalibrationDatasetError(
                    f"row {row_number}: {index_key} must be a non-negative integer"
                )
        bbox = source["bbox"]
        if (
            not isinstance(bbox, (list, tuple))
            or len(bbox) != 4
            or any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                for value in bbox
            )
        ):
            raise CalibrationDatasetError(f"row {row_number}: bbox must contain four finite numbers")
        x, y, width, height = (float(value) for value in bbox)
        if (
            x < 0 or y < 0 or width <= 0 or height <= 0
            or x + width > 1 or y + height > 1
        ):
            raise CalibrationDatasetError(f"row {row_number}: bbox is outside normalized image bounds")

        raw_score = _finite_number(source["calibration_score"], "calibration_score", row_number)
        candidate = normalize_exact_text(source["selected_candidate"])
        verified = normalize_exact_text(source["human_verified_text"])
        if not candidate or not verified:
            raise CalibrationDatasetError(f"row {row_number}: selected and verified tokens cannot be empty")
        exact_match = candidate == verified
        if "is_exact_match" in source and source["is_exact_match"] is not exact_match:
            raise CalibrationDatasetError(
                f"row {row_number}: supplied is_exact_match conflicts with the Admin-verified reference"
            )

        prepared.append({
            **source,
            "calibration_score": raw_score,
            "is_exact_match": exact_match,
            "normalized_candidate": candidate,
            "normalized_verified_text": verified,
        })

    if not prepared:
        raise CalibrationDatasetError("dataset is empty")
    return prepared


def split_books(
    rows: Sequence[dict[str, Any]],
    *,
    seed: str = "viread-book-disjoint-v1",
) -> dict[str, Any]:
    """Deterministically split complete books; a book can occur in one split only."""
    books = sorted(
        {str(row["book_id"]) for row in rows},
        key=lambda book_id: hashlib.sha256(
            (seed + ":" + book_id).encode("utf-8")
        ).hexdigest(),
    )
    if len(books) < 3:
        raise CalibrationDatasetError(
            "at least 3 distinct books are required for train/validation/test separation"
        )
    test_count = max(1, round(len(books) * 0.2))
    validation_count = max(1, round(len(books) * 0.2))
    train_count = len(books) - test_count - validation_count
    if train_count < 1:
        raise CalibrationDatasetError("not enough distinct books for three disjoint splits")
    train_books = set(books[:train_count])
    validation_books = set(books[train_count:train_count + validation_count])
    test_books = set(books[train_count + validation_count:])
    return {
        "train": [row for row in rows if str(row["book_id"]) in train_books],
        "validation": [row for row in rows if str(row["book_id"]) in validation_books],
        "test": [row for row in rows if str(row["book_id"]) in test_books],
        "_book_ids": {
            "train": sorted(train_books),
            "validation": sorted(validation_books),
            "test": sorted(test_books),
        },
    }


def _sigmoid(value: float) -> float:
    if value >= 35:
        return 1.0
    if value <= -35:
        return 0.0
    return 1.0 / (1.0 + math.exp(-value))


def fit_platt_scaling(
    raw_scores: Sequence[float],
    labels: Sequence[bool],
) -> dict[str, float]:
    """Fit a one-dimensional Platt logistic map using Newton updates."""
    if len(raw_scores) != len(labels) or len(raw_scores) < 4:
        raise CalibrationDatasetError("Platt scaling requires at least four score/label pairs")
    numeric_scores = [float(score) for score in raw_scores]
    if any(not math.isfinite(score) for score in numeric_scores):
        raise CalibrationDatasetError("calibration scores must be finite")
    y = [1.0 if label else 0.0 for label in labels]
    if len(set(y)) != 2:
        raise CalibrationDatasetError("training split must contain both exact and incorrect words")

    mean = sum(numeric_scores) / len(numeric_scores)
    variance = sum((score - mean) ** 2 for score in numeric_scores) / len(numeric_scores)
    scale = math.sqrt(variance) or 1.0
    standardized = [(score - mean) / scale for score in numeric_scores]

    slope = 0.0
    intercept = 0.0
    regularization = 1e-6
    for _iteration in range(200):
        gradient_slope = regularization * slope
        gradient_intercept = 0.0
        hessian_ss = regularization
        hessian_si = 0.0
        hessian_ii = regularization
        for feature, label in zip(standardized, y, strict=True):
            probability = _sigmoid(slope * feature + intercept)
            residual = probability - label
            weight = max(1e-9, probability * (1.0 - probability))
            gradient_slope += residual * feature
            gradient_intercept += residual
            hessian_ss += weight * feature * feature
            hessian_si += weight * feature
            hessian_ii += weight
        determinant = hessian_ss * hessian_ii - hessian_si * hessian_si
        if determinant <= 1e-12:
            break
        delta_slope = (
            hessian_ii * gradient_slope - hessian_si * gradient_intercept
        ) / determinant
        delta_intercept = (
            -hessian_si * gradient_slope + hessian_ss * gradient_intercept
        ) / determinant
        slope -= delta_slope
        intercept -= delta_intercept
        if abs(delta_slope) + abs(delta_intercept) < 1e-8:
            break

    return {
        "mean": mean,
        "scale": scale,
        "slope": slope,
        "intercept": intercept,
    }


def predict_platt(raw_score: float, model: dict[str, float]) -> float:
    standardized = (float(raw_score) - model["mean"]) / model["scale"]
    return _sigmoid(model["slope"] * standardized + model["intercept"])


def expected_calibration_error(
    probabilities: Sequence[float],
    labels: Sequence[bool],
    *,
    bins: int = 10,
) -> float | None:
    if not probabilities or len(probabilities) != len(labels):
        return None
    total = len(probabilities)
    error = 0.0
    for bin_index in range(bins):
        lower = bin_index / bins
        upper = (bin_index + 1) / bins
        members = [
            index for index, probability in enumerate(probabilities)
            if lower <= probability < upper
            or (bin_index == bins - 1 and probability == 1.0)
        ]
        if not members:
            continue
        confidence = sum(probabilities[index] for index in members) / len(members)
        accuracy = sum(bool(labels[index]) for index in members) / len(members)
        error += len(members) / total * abs(confidence - accuracy)
    return error


def choose_green_threshold(
    probabilities: Sequence[float],
    labels: Sequence[bool],
    *,
    minimum_precision: float = 0.99,
    minimum_decisions: int = 30,
) -> float | None:
    """Choose the lowest validation threshold meeting the precision and sample gates."""
    if not probabilities or len(probabilities) != len(labels):
        return None
    for threshold in sorted(set(float(value) for value in probabilities)):
        selected = [
            index for index, probability in enumerate(probabilities)
            if probability >= threshold
        ]
        if len(selected) < minimum_decisions:
            continue
        precision = sum(bool(labels[index]) for index in selected) / len(selected)
        if precision >= minimum_precision:
            return threshold
    return None


def classification_metrics(
    rows: Sequence[dict[str, Any]],
    probabilities: Sequence[float],
    *,
    green_threshold: float | None,
    bins: int = 10,
) -> dict[str, Any]:
    labels = [bool(row["is_exact_match"]) for row in rows]
    count = len(rows)
    if count == 0 or len(probabilities) != count:
        return {"samples": count}

    binary_predictions = [probability >= 0.5 for probability in probabilities]
    true_positive = sum(pred and label for pred, label in zip(binary_predictions, labels, strict=True))
    false_positive = sum(pred and not label for pred, label in zip(binary_predictions, labels, strict=True))
    false_negative = sum((not pred) and label for pred, label in zip(binary_predictions, labels, strict=True))
    precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else None
    recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else None
    brier = sum(
        (probability - (1.0 if label else 0.0)) ** 2
        for probability, label in zip(probabilities, labels, strict=True)
    ) / count

    green_indices: list[int] = []
    diagnostic_red_indices: list[int] = []
    if green_threshold is not None:
        green_indices = [
            index for index, probability in enumerate(probabilities)
            if probability >= green_threshold
        ]
        red_threshold = 1.0 - green_threshold
        diagnostic_red_indices = [
            index for index, probability in enumerate(probabilities)
            if probability <= red_threshold
        ]
    green_correct = sum(labels[index] for index in green_indices)
    green_precision = green_correct / len(green_indices) if green_indices else None
    false_green_rate = (
        (len(green_indices) - green_correct) / len(green_indices)
        if green_indices else None
    )
    red_correct = sum(labels[index] for index in diagnostic_red_indices)
    false_red_rate = (
        red_correct / len(diagnostic_red_indices)
        if diagnostic_red_indices else None
    )
    coverage = (
        (len(green_indices) + len(diagnostic_red_indices)) / count
        if green_threshold is not None else 0.0
    )
    return {
        "samples": count,
        "word_accuracy": sum(labels) / count,
        "precision_at_0_5": precision,
        "recall_at_0_5": recall,
        "green_precision": green_precision,
        "false_green_rate": false_green_rate,
        "false_red_rate_diagnostic_only": false_red_rate,
        "coverage_diagnostic_only": coverage,
        "expected_calibration_error": expected_calibration_error(
            probabilities, labels, bins=bins
        ),
        "brier_score": brier,
        "green_decisions": len(green_indices),
        "diagnostic_red_decisions_not_enabled_in_runtime": len(diagnostic_red_indices),
    }


def build_calibration_artifact(
    rows: Sequence[dict[str, Any]],
    *,
    dataset_hash: str,
    minimum_green_precision: float = 0.99,
    minimum_green_decisions: int = 30,
    minimum_samples: int = 100,
    seed: str = "viread-book-disjoint-v1",
) -> dict[str, Any]:
    prepared = validate_ground_truth_rows(rows)
    book_ids = {str(row["book_id"]) for row in prepared}
    if len(prepared) < minimum_samples:
        raise CalibrationDatasetError(
            f"need at least {minimum_samples} verified word examples; found {len(prepared)}"
        )
    if len(book_ids) < 5:
        raise CalibrationDatasetError(
            f"need at least 5 distinct books for book-disjoint evaluation; found {len(book_ids)}"
        )

    compatibility = {
        (row["engine_version"], row["preprocessing_version"], row["calibration_source"])
        for row in prepared
    }
    if len(compatibility) != 1:
        raise CalibrationDatasetError(
            "dataset mixes engine version, preprocessing version or raw score source; "
            "calibrate each compatible group separately"
        )
    engine_version, preprocessing_version, calibration_source = next(iter(compatibility))

    split = split_books(prepared, seed=seed)
    train = split["train"]
    validation = split["validation"]
    test = split["test"]
    for split_name, split_rows in (
        ("train", train),
        ("validation", validation),
        ("test", test),
    ):
        if len({row["is_exact_match"] for row in split_rows}) < 2:
            raise CalibrationDatasetError(
                f"{split_name} books must contain both correct and incorrect candidates "
                "to fit/evaluate calibration without single-class ambiguity"
            )

    model = fit_platt_scaling(
        [row["calibration_score"] for row in train],
        [row["is_exact_match"] for row in train],
    )
    validation_probabilities = [
        predict_platt(row["calibration_score"], model) for row in validation
    ]
    validation_labels = [row["is_exact_match"] for row in validation]
    green_threshold = choose_green_threshold(
        validation_probabilities,
        validation_labels,
        minimum_precision=minimum_green_precision,
        minimum_decisions=minimum_green_decisions,
    )
    test_probabilities = [
        predict_platt(row["calibration_score"], model) for row in test
    ]

    return {
        "artifact_version": "viread-platt-book-disjoint-v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "dataset_sha256": dataset_hash,
        "dataset_samples": len(prepared),
        "distinct_books": len(book_ids),
        "engine_version": engine_version,
        "preprocessing_version": preprocessing_version,
        "calibration_source": calibration_source,
        "split_strategy": "book_id_disjoint_deterministic_hash",
        "book_ids": split["_book_ids"],
        "sample_counts": {
            "train": len(train),
            "validation": len(validation),
            "test": len(test),
        },
        "method": "platt_scaling",
        "model": model,
        "validation_policy": {
            "minimum_green_precision": minimum_green_precision,
            "minimum_green_decisions": minimum_green_decisions,
            "green_threshold": green_threshold,
        },
        "validation_metrics": classification_metrics(
            validation, validation_probabilities, green_threshold=green_threshold
        ),
        "test_metrics": classification_metrics(
            test, test_probabilities, green_threshold=green_threshold
        ),
        "auto_green_eligible": green_threshold is not None,
        "runtime_enabled": False,
        "auto_red_enabled": False,
        "activation_note": (
            "Offline artifact only. Runtime activation requires engine/preprocessing "
            "compatibility validation and a separate precision review."
        ),
    }


def load_jsonl_dataset(path: Path) -> tuple[list[dict[str, Any]], str]:
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CalibrationDatasetError(
                f"line {line_number}: invalid JSON: {exc.msg}"
            ) from exc
        if not isinstance(value, dict):
            raise CalibrationDatasetError(f"line {line_number}: expected JSON object")
        rows.append(value)
    return rows, digest


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate verified ViRead OCR words and train a book-disjoint Platt artifact."
    )
    parser.add_argument("--dataset", required=True, type=Path, help="Admin-reviewed JSONL dataset")
    parser.add_argument("--output", required=True, type=Path, help="Output calibration JSON path")
    parser.add_argument("--minimum-green-precision", type=float, default=0.99)
    parser.add_argument("--minimum-green-decisions", type=int, default=30)
    parser.add_argument("--minimum-samples", type=int, default=100)
    parser.add_argument("--seed", default="viread-book-disjoint-v1")
    args = parser.parse_args()

    try:
        rows, dataset_hash = load_jsonl_dataset(args.dataset)
        artifact = build_calibration_artifact(
            rows,
            dataset_hash=dataset_hash,
            minimum_green_precision=args.minimum_green_precision,
            minimum_green_decisions=args.minimum_green_decisions,
            minimum_samples=args.minimum_samples,
            seed=args.seed,
        )
    except (OSError, UnicodeDecodeError, CalibrationDatasetError) as exc:
        parser.exit(2, f"Calibration blocked: {exc}\n")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "output": str(args.output),
        "dataset_sha256": artifact["dataset_sha256"],
        "sample_counts": artifact["sample_counts"],
        "auto_green_eligible": artifact["auto_green_eligible"],
        "runtime_enabled": artifact["runtime_enabled"],
        "test_metrics": artifact["test_metrics"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
