"""Unit tests for hybrid OCR normalization, crop validation and selective re-recognition."""
from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import cv2
import numpy as np

from app.services.ocr_evidence import (
    MAX_SELECTIVE_WORD_CROPS_PER_PAGE,
    crop_word_region,
    find_split_merge_candidates,
    normalize_alignment_token,
    token_alignment_cost,
)
from app.services.ocr_engine import _recognize_uncertain_word_crops


class HybridOcrEvidenceTests(unittest.TestCase):
    def test_nfc_alignment_preserves_tone_and_vowel_diacritics(self):
        self.assertEqual(normalize_alignment_token("ve\u0301"), normalize_alignment_token("vé"))
        self.assertNotEqual(normalize_alignment_token("vé"), normalize_alignment_token("về"))
        self.assertGreater(token_alignment_cost("vé", "về"), 0.0)
        self.assertGreater(token_alignment_cost("lui", "hui"), 0.0)

    def test_split_merge_candidates_are_reported_without_forcing_alignment(self):
        merged = find_split_merge_candidates(["khongbiet"], ["khong", "biet"])
        self.assertTrue(any(item["operation"] == "merge" for item in merged))
        split = find_split_merge_candidates(["xin", "chao"], ["xinchao"])
        self.assertTrue(any(item["operation"] == "split" for item in split))

    def test_bbox_validation_rejects_out_of_bounds_and_non_finite_geometry(self):
        image = np.full((160, 320, 3), 255, dtype=np.uint8)
        for bbox in (
            [0.9, 0.2, 0.2, 0.1],
            [-0.1, 0.2, 0.2, 0.1],
            [0.2, 0.2, 0.0, 0.1],
            [0.2, 0.2, float("nan"), 0.1],
            [True, 0.2, 0.2, 0.1],
        ):
            with self.subTest(bbox=bbox):
                crop, quality = crop_word_region(image, bbox)
                self.assertIsNone(crop)
                self.assertEqual(quality["bbox_quality"], "rejected")

    def test_blank_crop_is_not_used_as_recognition_evidence(self):
        image = np.full((160, 320, 3), 255, dtype=np.uint8)
        crop, quality = crop_word_region(image, [0.2, 0.35, 0.3, 0.25])
        self.assertIsNone(crop)
        self.assertEqual(quality["bbox_quality"], "valid")
        self.assertEqual(quality["crop_quality"], "weak")

    def test_valid_crop_has_padding_and_retains_dark_marks(self):
        image = np.full((160, 320, 3), 255, dtype=np.uint8)
        cv2.putText(image, "ve", (90, 90), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
        crop, quality = crop_word_region(image, [0.25, 0.35, 0.2, 0.3])
        self.assertIsNotNone(crop)
        self.assertEqual(quality["bbox_quality"], "valid")
        self.assertEqual(quality["crop_quality"], "usable")
        self.assertGreater(float(quality["ink_ratio"]), 0.001)
        self.assertGreater(crop.shape[0], 48)

    def test_selective_crop_calls_loaded_engines_and_keeps_raw_score_provenance(self):
        image = np.full((180, 360, 3), 255, dtype=np.uint8)
        cv2.putText(image, "ve", (100, 105), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
        word = {
            "bbox": [0.27, 0.35, 0.2, 0.3],
            "ocr_evidence": {"alignment": "substitute"},
        }
        paddle = MagicMock()
        paddle.ocr.return_value = [[("về", 0.82)]]
        vietocr = MagicMock()
        vietocr.predict_batch.return_value = (["vé"], [0.73])

        stats = _recognize_uncertain_word_crops(image, [word], paddle, vietocr)

        paddle.ocr.assert_called_once()
        self.assertEqual(paddle.ocr.call_args.kwargs, {"det": False, "rec": True, "cls": False})
        vietocr.predict_batch.assert_called_once()
        crop_evidence = word["ocr_evidence"]["crop_evidence"]
        self.assertEqual(crop_evidence["paddleocr_candidate"], "về")
        self.assertEqual(crop_evidence["vietocr_candidate"], "vé")
        self.assertEqual(crop_evidence["paddle_crop_recognition_score"], 0.82)
        self.assertEqual(crop_evidence["vietocr_crop_recognition_score"], 0.73)
        self.assertEqual(crop_evidence["score_semantics"], "raw_recognition_output_not_probability")
        self.assertEqual(stats["recognized"], 1)
        self.assertLessEqual(stats["max_crops_per_page"], MAX_SELECTIVE_WORD_CROPS_PER_PAGE)

    def test_beam_search_uses_predict_instead_of_predict_batch(self):
        image = np.full((180, 360, 3), 255, dtype=np.uint8)
        cv2.putText(image, "ve", (100, 105), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
        word = {
            "bbox": [0.27, 0.35, 0.2, 0.3],
            "ocr_evidence": {"alignment": "substitute"},
        }
        paddle = MagicMock()
        paddle.ocr.return_value = [[("về", 0.82)]]
        vietocr = MagicMock()
        vietocr.config = {"predictor": {"beamsearch": True}}
        vietocr.predict.return_value = ("vé", None)

        _recognize_uncertain_word_crops(image, [word], paddle, vietocr)

        vietocr.predict_batch.assert_not_called()
        vietocr.predict.assert_called_once()
        crop_evidence = word["ocr_evidence"]["crop_evidence"]
        self.assertEqual(crop_evidence["vietocr_candidate"], "vé")
        self.assertIsNone(crop_evidence["vietocr_crop_recognition_score"])
        self.assertEqual(crop_evidence["vietocr_decoding_mode"], "beam_search")

    def test_paddle_crop_failure_does_not_discard_vietocr_evidence(self):
        image = np.full((180, 360, 3), 255, dtype=np.uint8)
        cv2.putText(image, "ve", (100, 105), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
        word = {
            "bbox": [0.27, 0.35, 0.2, 0.3],
            "ocr_evidence": {"alignment": "substitute"},
        }
        paddle = MagicMock()
        paddle.ocr.side_effect = RuntimeError("recognition unavailable")
        vietocr = MagicMock()
        vietocr.predict_batch.return_value = (["vé"], [float("nan")])

        _recognize_uncertain_word_crops(image, [word], paddle, vietocr)

        crop_evidence = word["ocr_evidence"]["crop_evidence"]
        self.assertEqual(crop_evidence["paddle_error"], "RuntimeError")
        self.assertEqual(crop_evidence["vietocr_candidate"], "vé")
        self.assertIsNone(crop_evidence["vietocr_crop_recognition_score"])
        self.assertEqual(crop_evidence["status"], "completed")

    def test_invalid_bbox_never_calls_crop_engines(self):
        image = np.full((180, 360, 3), 255, dtype=np.uint8)
        word = {
            "bbox": [0.95, 0.3, 0.2, 0.3],
            "ocr_evidence": {"alignment": "substitute"},
        }
        paddle = MagicMock()
        vietocr = MagicMock()
        stats = _recognize_uncertain_word_crops(image, [word], paddle, vietocr)
        paddle.ocr.assert_not_called()
        vietocr.predict_batch.assert_not_called()
        self.assertEqual(stats["rejected_bbox"], 1)
        self.assertEqual(word["ocr_evidence"]["crop_evidence"]["status"], "skipped")


if __name__ == "__main__":
    unittest.main()
