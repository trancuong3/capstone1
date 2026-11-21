"""Pure Python tests of privacy-safe IoU, manual label contract and matching."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.ocr_word_box_iou import (
    intersection_over_union,
    load_manual_annotations,
    score_page,
    summarize_scores,
    valid_box,
)


class WordBoxIoUTests(unittest.TestCase):
    def test_iou_exact_disjoint_and_threshold_boundary(self):
        a = [0, 0, 0.4, 0.4]
        self.assertEqual(intersection_over_union(a, a), 1)
        self.assertEqual(intersection_over_union(a, [0.6, 0.6, 0.2, 0.2]), 0)
        self.assertAlmostEqual(intersection_over_union(a, [0, 0, 0.2, 0.4]), 0.5)
        ref = [{"text": "đọc", "bbox": a}]
        pred = [{"text": "đọc", "bbox": [0, 0, 0.2, 0.4]}]
        self.assertEqual(score_page(pred, ref)["0.50"]["geometry_tp"], 1)
        self.assertEqual(score_page(pred, ref)["0.75"]["geometry_tp"], 0)

    def test_one_to_one_duplicate_detection_and_strict_accents(self):
        box = [0.1, 0.1, 0.3, 0.2]
        ref = [{"text": "đọc", "bbox": box}]
        pred = [
            {"text": "đọc", "bbox": box},
            {"text": "doc", "bbox": box},
        ]
        counts = score_page(pred, ref)
        totals = summarize_scores([counts])
        self.assertEqual(totals["0.50"]["geometry"]["tp"], 1)
        self.assertEqual(totals["0.50"]["geometry"]["fp"], 1)
        self.assertEqual(totals["0.50"]["strict_word_and_geometry"]["tp"], 1)
        self.assertEqual(totals["0.50"]["geometry"]["precision"], 0.5)
        self.assertEqual(
            score_page([{"text": "doc", "bbox": box}], ref)["0.50"]["strict_word_position_tp"], 0
        )
        self.assertEqual(
            score_page([{"text": "Đọc", "bbox": box}], ref)["0.50"]["strict_word_position_tp"], 0
        )

    def test_max_cardinality_not_naive_greedy(self):
        # p1 overlaps r1 and r2; p2 overlaps only r1. Must assign p1->r2.
        ref = [
            {"text": "một", "bbox": [0.0, 0.0, 0.4, 0.4]},
            {"text": "hai", "bbox": [0.05, 0.0, 0.4, 0.4]},
        ]
        pred = [
            {"text": "hai", "bbox": [0.025, 0.0, 0.4, 0.4]},
            {"text": "một", "bbox": [0.0, 0.0, 0.22, 0.4]},
        ]
        counts = score_page(pred, ref)["0.50"]
        self.assertEqual(counts["geometry_tp"], 2)
        self.assertEqual(counts["strict_word_position_tp"], 2)

    def test_invalid_prediction_is_false_positive_not_hidden(self):
        ref = [{"text": "Bé", "bbox": [0.1, 0.1, 0.2, 0.2]}]
        pred = [{"text": "Bé", "bbox": [-1, 0, 1, 1]}]
        report = summarize_scores([score_page(pred, ref)])
        self.assertEqual(report["0.50"]["geometry"]["tp"], 0)
        self.assertEqual(report["0.50"]["geometry"]["fp"], 1)
        self.assertEqual(report["0.50"]["geometry"]["fn"], 1)
        self.assertFalse(valid_box([True, 0, 0.2, 0.2]))
        self.assertFalse(valid_box([float("nan"), 0, 0.2, 0.2]))

    def test_micro_precision_recall_f1_and_zero_predictions(self):
        r = [{"text": "bé", "bbox": [0.1, 0.1, 0.2, 0.2]}]
        first = score_page([{"text": "bé", "bbox": r[0]["bbox"]}], r)
        second = score_page([], r)
        summary = summarize_scores([first, second])["0.50"]["geometry"]
        self.assertEqual(summary["tp"], 1)
        self.assertEqual(summary["fp"], 0)
        self.assertEqual(summary["fn"], 1)
        self.assertEqual(summary["precision"], 1)
        self.assertEqual(summary["recall"], 0.5)
        self.assertEqual(summary["f1"], 0.666667)

    def test_manual_annotations_require_full_independent_review(self):
        with tempfile.TemporaryDirectory() as dirname:
            path = Path(dirname) / "bbox.jsonl"
            good = {
                "image": "images/a.png", "annotation_source": "manual_independent",
                "reviewer_confirmed": True,
                "coordinate_space": "normalized_original_dimensions",
                "words": [{"text": "Bé", "bbox": [0.1, 0.1, 0.2, 0.2]}],
            }
            path.write_text(json.dumps(good, ensure_ascii=False) + "\n", encoding="utf-8")
            labels = load_manual_annotations(path, {"images/a.png"})
            self.assertEqual(len(labels["images/a.png"]), 1)
            with self.assertRaises(ValueError):
                load_manual_annotations(path, {"images/a.png", "images/b.png"})
            path.write_text(json.dumps({**good, "reviewer_confirmed": False}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_manual_annotations(path, {"images/a.png"})
            path.write_text(json.dumps(good, ensure_ascii=False) + "\n" +
                            json.dumps(good, ensure_ascii=False) + "\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_manual_annotations(path, {"images/a.png"})
            path.write_text(json.dumps({**good, "words": []}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_manual_annotations(path, {"images/a.png"})
            path.write_text(json.dumps({
                **good, "words": [{"text": "Bé đang", "bbox": [0.1, 0.1, 0.2, 0.2]}]
            }), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_manual_annotations(path, {"images/a.png"})

    def test_scores_never_contain_private_words(self):
        a = [{"text": "tuyệt_mật", "bbox": [0.1, 0.2, 0.2, 0.1]}]
        summary = summarize_scores([score_page(a, a)])
        report = json.dumps(summary, ensure_ascii=False)
        self.assertNotIn("tuyệt_mật", report)
        self.assertNotIn("bbox", report)


if __name__ == "__main__":
    unittest.main()
