"""Tests for non-sensitive OCR bounding-box integrity checks."""
from __future__ import annotations

import unittest

from scripts.ocr_bbox_integrity import inspect_word_boxes


class BoundingBoxIntegrityTests(unittest.TestCase):
    def test_valid_normalized_coordinates(self):
        report = inspect_word_boxes([
            {"text": "Bé", "bbox": [0, 0, 0.5, 0.2]},
            {"text": "đọc", "bbox": (0.5, 0.25, 0.5, 0.5)},
        ])
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["valid_boxes"], 2)
        self.assertEqual(report["invalid_boxes"], 0)
        self.assertNotIn("Bé", str(report))

    def test_invalid_boxes_are_counted_without_tokens(self):
        boxes = [
            {"text": "secret1", "bbox": [0.9, 0.9, 0.2, 0.2]},
            {"text": "secret2", "bbox": [-0.1, 0, 0.1, 0.1]},
            {"text": "secret3", "bbox": [0, 0, 0, 0.1]},
            {"text": "secret4", "bbox": [float("nan"), 0, 0.1, 0.1]},
            {"text": "secret5", "bbox": [True, 0, 0.1, 0.1]},
            {"text": "secret6", "bbox": [0, 0, 0.1]},
            "private-word",
        ]
        report = inspect_word_boxes(boxes)
        self.assertEqual(report["reported_words"], 7)
        self.assertEqual(report["invalid_boxes"], 7)
        self.assertEqual(report["valid_boxes"], 0)
        self.assertEqual(report["invalid_reasons"]["out_of_image_bounds"], 2)
        self.assertEqual(report["invalid_reasons"]["non_positive_extent"], 1)
        self.assertEqual(report["invalid_reasons"]["non_finite_coordinate"], 1)
        self.assertEqual(report["invalid_reasons"]["non_numeric_coordinate"], 1)
        self.assertEqual(report["invalid_reasons"]["invalid_bbox_shape"], 1)
        self.assertEqual(report["invalid_reasons"]["invalid_word_record"], 1)
        self.assertNotIn("secret", str(report))
        self.assertNotIn("private-word", str(report))

    def test_missing_word_list_is_not_treated_as_success(self):
        report = inspect_word_boxes(None)
        self.assertEqual(report["status"], "not_reported")
        self.assertEqual(report["valid_boxes"], 0)


if __name__ == "__main__":
    unittest.main()
