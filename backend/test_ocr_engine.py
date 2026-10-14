"""OCR adapter tests. Tesseract and Supabase are mocked; no live OCR is required."""
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import cv2
import numpy as np

from app.services import ocr_engine


def sample_png(width: int = 400, height: int = 200) -> bytes:
    image = np.full((height, width, 3), 255, dtype=np.uint8)
    success, encoded = cv2.imencode(".png", image)
    if not success:
        raise AssertionError("Could not encode test image")
    return encoded.tobytes()


def tesseract_tsv(
    first_confidence: str = "91.0",
    second_confidence: str = "-1",
    first_text: str = "Chú",
    second_text: str = "mèo",
) -> dict[str, list[object]]:
    return {
        "text": [first_text, second_text, ""],
        "left": [100, 200, 0],
        "top": [50, 100, 0],
        "width": [40, 50, 0],
        "height": [20, 25, 0],
        "conf": [first_confidence, second_confidence, "-1"],
        "block_num": [1, 1, 0],
        "par_num": [1, 1, 0],
        "line_num": [1, 2, 0],
    }


class OcrEngineTests(unittest.TestCase):
    def _configured_tesseract(self):
        return (
            patch.object(ocr_engine.shutil, "which", return_value="/usr/bin/tesseract"),
            patch.object(ocr_engine.pytesseract, "get_tesseract_version", return_value="5.3.0"),
            patch.object(ocr_engine.pytesseract, "get_languages", return_value=["eng", "vie"]),
        )

    def test_best_strategy_preserves_real_tsv_boxes_and_missing_confidence(self):
        patches = self._configured_tesseract()
        def scaled_tsv(image, **_kwargs):
            height, width = image.shape[:2]
            return {
                "text": ["Chú", "mèo", ""],
                "left": [round(width * 0.25), round(width * 0.5), 0],
                "top": [round(height * 0.25), round(height * 0.5), 0],
                "width": [round(width * 0.1), round(width * 0.125), 0],
                "height": [round(height * 0.1), round(height * 0.125), 0],
                "conf": ["91.0", "-1", "-1"],
                "block_num": [1, 1, 0],
                "par_num": [1, 1, 0],
                "line_num": [1, 2, 0],
            }

        with patches[0], patches[1], patches[2], patch.object(
            ocr_engine.pytesseract, "image_to_data", side_effect=scaled_tsv
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png())

        self.assertEqual(result["text"], "Chú\nmèo")
        self.assertEqual(result["words"][0]["text"], "Chú")
        first_bbox = result["words"][0]["bbox"]
        for actual, expected in zip(first_bbox, (0.25, 0.25, 0.1, 0.1)):
            self.assertAlmostEqual(actual, expected)
        self.assertAlmostEqual(result["words"][0]["ocr_confidence"], 0.91)
        self.assertIsNone(result["words"][1]["ocr_confidence"])
        self.assertEqual(result["words"][0]["line_index"], 0)
        self.assertEqual(result["words"][1]["line_index"], 1)
        self.assertEqual(result["metadata"]["coordinate_space"], "normalized_original_dimensions")
        self.assertEqual(result["metadata"]["candidate_count"], 4)
        self.assertIn("words_need_review", result["metadata"]["warnings"])

    def test_baseline_keeps_old_single_candidate_behavior_for_benchmarking(self):
        patches = self._configured_tesseract()
        with patches[0], patches[1], patches[2], patch.object(
            ocr_engine.pytesseract, "image_to_data", return_value=tesseract_tsv()
        ) as run_ocr:
            result = ocr_engine.extract_text_and_boxes(sample_png(), strategy="baseline")

        self.assertEqual(run_ocr.call_count, 1)
        self.assertEqual(result["text"], "Chú\nmèo")
        self.assertEqual(result["metadata"]["candidate_count"], 1)
        self.assertEqual(result["metadata"]["selected_candidate"], "baseline_clahe_psm3")
        self.assertIsNone(result["metadata"]["candidate_score_margin"])
        self.assertNotIn("candidate_scores_ambiguous", result["metadata"]["warnings"])

    def test_best_strategy_selects_candidate_with_stronger_confidence(self):
        patches = self._configured_tesseract()
        outputs = [
            tesseract_tsv("20.0", "18.0"),
            tesseract_tsv("98.0", "97.0"),
            tesseract_tsv("40.0", "42.0"),
            tesseract_tsv("30.0", "32.0"),
        ]
        with patches[0], patches[1], patches[2], patch.object(
            ocr_engine.pytesseract, "image_to_data", side_effect=outputs
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png())

        self.assertEqual(result["metadata"]["selected_candidate"], "grayscale_psm3")
        self.assertAlmostEqual(result["metadata"]["mean_confidence"], 0.975)
        self.assertEqual(result["metadata"]["low_confidence_word_count"], 0)

    def test_close_candidate_scores_add_ambiguity_warning(self):
        patches = self._configured_tesseract()
        scores = [(0.90, 0.90), (0.89, 0.89), (0.70, 0.70), (0.60, 0.60)]
        with patches[0], patches[1], patches[2], patch.object(
            ocr_engine.pytesseract, "image_to_data", return_value=tesseract_tsv()
        ), patch.object(ocr_engine, "_candidate_score", side_effect=scores):
            result = ocr_engine.extract_text_and_boxes(sample_png())

        metadata = result["metadata"]
        self.assertIn("candidate_scores_ambiguous", metadata["warnings"])
        self.assertAlmostEqual(metadata["candidate_score_margin"], 0.01)
        self.assertEqual(metadata["candidate_score_ambiguity_margin"], 0.025)

    def test_missing_vietnamese_language_data_fails_closed(self):
        with patch.object(ocr_engine.shutil, "which", return_value="/usr/bin/tesseract"), patch.object(
            ocr_engine.pytesseract, "get_tesseract_version", return_value="5.3.0"
        ), patch.object(ocr_engine.pytesseract, "get_languages", return_value=["eng"]):
            with self.assertRaises(ocr_engine.OcrEngineUnavailable):
                ocr_engine.extract_text_and_boxes(sample_png())

    def test_empty_output_does_not_return_fake_words(self):
        empty = {
            "text": ["", "  "],
            "left": [0, 0],
            "top": [0, 0],
            "width": [0, 0],
            "height": [0, 0],
            "conf": ["-1", "-1"],
            "block_num": [0, 0],
            "par_num": [0, 0],
            "line_num": [0, 0],
        }
        patches = self._configured_tesseract()
        with patches[0], patches[1], patches[2], patch.object(
            ocr_engine.pytesseract, "image_to_data", return_value=empty
        ):
            with self.assertRaises(ocr_engine.OcrNoTextDetected):
                ocr_engine.extract_text_and_boxes(sample_png())

    def test_unicode_nfc_is_used_without_removing_vietnamese_diacritics(self):
        decomposed = "a\u0306"
        self.assertEqual(ocr_engine.normalize_word(decomposed), "ă")
        self.assertEqual(ocr_engine.normalize_text_tokens("TIE\u0302\u0301NG Vie\u0323\u0302t"), ["tiếng", "việt"])

    def test_unsupported_strategy_is_rejected(self):
        with self.assertRaises(ValueError):
            ocr_engine.extract_text_and_boxes(sample_png(), strategy="unknown")


if __name__ == "__main__":
    unittest.main()
