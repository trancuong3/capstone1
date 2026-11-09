"""Tests for the book-disjoint OCR calibration pipeline."""
from __future__ import annotations

import hashlib
import unittest

from app.services.ocr_calibration import (
    CalibrationDatasetError,
    build_calibration_artifact,
    choose_green_threshold,
    fit_platt_scaling,
    normalize_exact_text,
    predict_platt,
    split_books,
    validate_ground_truth_rows,
)


def make_rows(book_count: int = 10, per_book: int = 30):
    rows = []
    for book in range(book_count):
        for index in range(per_book):
            is_correct = index % 2 == 0
            score = 0.9 if is_correct else 0.1
            candidate = "vé" if is_correct else "về"
            reference = "vé"
            rows.append({
                "book_id": f"book-{book}",
                "page_revision_id": f"revision-{book}-{index // 10}",
                "source_image_hash": hashlib.sha256(
                    f"image-{book}-{index // 10}".encode("utf-8")
                ).hexdigest(),
                "word_index": index,
                "line_index": index // 10,
                "bbox": [0.1, 0.2, 0.1, 0.05],
                "paddle_candidate": candidate,
                "vietocr_candidate": candidate,
                "selected_candidate": candidate,
                "crop_candidates": [],
                "human_verified_text": reference,
                "verification_source": "verified_revision",
                "word_review_status": "reference_match" if is_correct else "confirmed_mismatch",
                "reference_alignment": "match" if is_correct else "substitute",
                "engine_version": "PP-OCRv4+VietOCR-0.3.12",
                "preprocessing_version": "vi_word_crop_nfc_v1",
                "calibration_source": "vietocr_crop_recognition_score",
                "calibration_score": score,
            })
    return rows


class OcrCalibrationTests(unittest.TestCase):
    def test_nfc_keeps_vietnamese_marks_distinct(self):
        self.assertEqual(normalize_exact_text("ve\u0301"), "vé")
        self.assertNotEqual(normalize_exact_text("vé"), normalize_exact_text("về"))

    def test_only_admin_verified_word_labels_are_accepted(self):
        rows = make_rows(book_count=1, per_book=2)
        rows[0]["word_review_status"] = "needs_review"
        with self.assertRaises(CalibrationDatasetError):
            validate_ground_truth_rows(rows)

    def test_line_confidence_cannot_be_used_as_word_calibration_score(self):
        row = make_rows(book_count=1, per_book=2)[0]
        row["calibration_source"] = "paddle_line_confidence"
        with self.assertRaises(CalibrationDatasetError):
            validate_ground_truth_rows([row])

    def test_invalid_source_image_hash_is_rejected(self):
        row = make_rows(book_count=1, per_book=2)[0]
        row["source_image_hash"] = "not-a-sha256"
        with self.assertRaises(CalibrationDatasetError):
            validate_ground_truth_rows([row])

    def test_split_is_book_disjoint(self):
        split = split_books(make_rows())
        train = set(row["book_id"] for row in split["train"])
        validation = set(row["book_id"] for row in split["validation"])
        test = set(row["book_id"] for row in split["test"])
        self.assertFalse(train & validation)
        self.assertFalse(train & test)
        self.assertFalse(validation & test)

    def test_platt_scaling_maps_score_order_and_returns_probabilities(self):
        scores = [0.1, 0.2, 0.15, 0.8, 0.9, 0.85] * 5
        labels = [False, False, False, True, True, True] * 5
        model = fit_platt_scaling(scores, labels)
        low = predict_platt(0.1, model)
        high = predict_platt(0.9, model)
        self.assertGreater(high, low)
        self.assertGreaterEqual(low, 0.0)
        self.assertLessEqual(high, 1.0)

    def test_green_threshold_requires_precision_and_minimum_decisions(self):
        threshold = choose_green_threshold(
            [0.99] * 20 + [0.4] * 10,
            [True] * 20 + [False] * 10,
            minimum_precision=0.99,
            minimum_decisions=20,
        )
        self.assertEqual(threshold, 0.99)
        blocked = choose_green_threshold(
            [0.99] * 10,
            [True] * 10,
            minimum_precision=0.99,
            minimum_decisions=20,
        )
        self.assertIsNone(blocked)

    def test_artifact_is_offline_and_requires_compatibility_group(self):
        rows = make_rows()
        artifact = build_calibration_artifact(
            rows,
            dataset_hash=hashlib.sha256(b"test-dataset").hexdigest(),
            minimum_green_decisions=5,
            minimum_samples=100,
        )
        self.assertEqual(artifact["method"], "platt_scaling")
        self.assertFalse(artifact["runtime_enabled"])
        self.assertFalse(artifact["auto_red_enabled"])
        self.assertEqual(
            artifact["dataset_sha256"], hashlib.sha256(b"test-dataset").hexdigest()
        )
        rows[0]["preprocessing_version"] = "different-preprocessing"
        with self.assertRaises(CalibrationDatasetError):
            build_calibration_artifact(
                rows,
                dataset_hash="mixed",
                minimum_green_decisions=5,
                minimum_samples=100,
            )


if __name__ == "__main__":
    unittest.main()
