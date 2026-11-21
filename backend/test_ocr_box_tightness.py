"""Focused, dependency-free tests for offline box tightness experiments."""
from __future__ import annotations

import json
import unittest

from scripts.ocr_box_tightness import (
    CANDIDATES, candidate_predictions, evaluate_hypotheses,
    inspect_overlap_shapes, resize_box,
)
from scripts.ocr_word_box_iou import intersection_over_union


class BboxTightnessTests(unittest.TestCase):
    def test_center_scaling_and_clamping_without_mutating_original(self):
        source = {"text": "Bé", "bbox": [0.1, 0.1, 0.2, 0.2]}
        untouched = source["bbox"][:]
        adjusted = candidate_predictions([source], 1.1, 0.9)[0]
        self.assertEqual(adjusted["text"], "Bé")
        self.assertAlmostEqual(adjusted["bbox"][0], 0.09)
        self.assertAlmostEqual(adjusted["bbox"][1], 0.11)
        self.assertAlmostEqual(adjusted["bbox"][2], 0.22)
        self.assertAlmostEqual(adjusted["bbox"][3], 0.18)
        self.assertEqual(source["bbox"], untouched)
        clipped = resize_box([0, 0, 0.2, 0.2], 1.1, 1.1)
        self.assertGreaterEqual(clipped[0], 0)
        self.assertGreaterEqual(clipped[1], 0)
        self.assertLessEqual(clipped[0] + clipped[2], 1)
        self.assertEqual(resize_box([2, 0, 0.2, 0.2], 1.1, 1.1), [2, 0, 0.2, 0.2])

    def test_diagnostic_best_iou_histogram_has_no_private_words(self):
        ref = [{"text": "đọc", "bbox": [0.1, 0.1, 0.2, 0.2]}]
        predicted = [
            {"text": "đọc", "bbox": [0.1, 0.1, 0.2, 0.2]},
            {"text": "doc", "bbox": [0.7, 0.7, 0.1, 0.1]},
            {"text": "private", "bbox": None},
        ]
        report = inspect_overlap_shapes(predicted, ref)
        self.assertEqual(report["best_overlap_histogram"]["0.90_to_1.00"], 1)
        self.assertEqual(report["best_overlap_histogram"]["below_0.25"], 1)
        self.assertEqual(report["best_overlap_histogram"]["invalid_prediction"], 1)
        self.assertEqual(report["exact_word_best_overlap_pairs"], 1)
        self.assertEqual(report["median_predicted_to_reference_width"], 1)
        encoded = json.dumps(report, ensure_ascii=False)
        self.assertNotIn("đọc", encoded)
        self.assertNotIn("private", encoded)

    def test_offline_candidate_may_improve_iou_without_changing_words(self):
        ref = [{"text": "đọc", "bbox": [0.1, 0.1, 0.2, 0.2]}]
        original = [{"text": "đọc", "bbox": [0.115, 0.115, 0.17, 0.17]}]
        self.assertLess(intersection_over_union(ref[0]["bbox"], original[0]["bbox"]), 0.75)
        report = evaluate_hypotheses([(original, ref)])
        self.assertEqual(len(CANDIDATES), 9)
        self.assertEqual(report["baseline"]["0.75"]["geometry"]["f1"], 0)
        self.assertEqual(
            report["bbox_tightness_hypotheses"]["width_110_height_110"]["scores"]
            ["0.75"]["geometry"]["f1"], 1,
        )
        self.assertEqual(report["baseline"]["0.50"]["geometry"]["f1"], 1)
        self.assertEqual(report["production_inference_modified"], False)
        self.assertEqual(original[0]["bbox"], [0.115, 0.115, 0.17, 0.17])
        self.assertNotIn("đọc", json.dumps(report, ensure_ascii=False))

    def test_wrong_word_still_fails_text_plus_geometry(self):
        ref = [{"text": "đọc", "bbox": [0.1, 0.1, 0.2, 0.2]}]
        pred = [{"text": "doc", "bbox": [0.1, 0.1, 0.2, 0.2]}]
        report = evaluate_hypotheses([(pred, ref)])
        self.assertEqual(report["baseline"]["0.50"]["geometry"]["f1"], 1)
        self.assertEqual(report["baseline"]["0.50"]["strict_word_and_geometry"]["f1"], 0)

    def test_missing_invalid_predictions_remain_false_positives(self):
        gt = [{"text": "An", "bbox": [0.2, 0.2, 0.1, 0.1]}]
        pred = [{"text": "An", "bbox": [-1, 0, 0.2, 0.2]}]
        report = evaluate_hypotheses([(pred, gt)])
        self.assertEqual(report["baseline"]["0.50"]["geometry"]["fp"], 1)
        self.assertEqual(report["baseline_shapes"]["max_iou_by_prediction_histogram"], {
            "invalid_prediction": 1,
        })


if __name__ == "__main__":
    unittest.main()
