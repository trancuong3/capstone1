"""Local Tesseract adapter tests using mocked engine output (no live OCR or Supabase)."""
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import cv2
import numpy as np

from app.services import ocr_engine


def sample_png() -> bytes:
    image = np.full((200, 400, 3), 255, dtype=np.uint8)
    success, encoded = cv2.imencode(".png", image)
    if not success:
        raise AssertionError("Could not encode test image")
    return encoded.tobytes()


def tesseract_tsv() -> dict[str, list[object]]:
    return {
        "text": ["Chú", "mèo", ""],
        "left": [100, 200, 0],
        "top": [50, 100, 0],
        "width": [40, 50, 0],
        "height": [20, 25, 0],
        "conf": ["91.0", "-1", "-1"],
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

    def test_uses_real_tsv_boxes_and_never_invents_confidence(self):
        patches = self._configured_tesseract()
        with patches[0], patches[1], patches[2], patch.object(
            ocr_engine.pytesseract,
            "image_to_data",
            return_value=tesseract_tsv(),
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png())

        self.assertEqual(result["text"], "Chú mèo")
        self.assertEqual(result["words"][0]["text"], "Chú")
        first_bbox = result["words"][0]["bbox"]
        for actual, expected in zip(first_bbox, (0.25, 0.25, 0.1, 0.1)):
            self.assertAlmostEqual(actual, expected)
        self.assertAlmostEqual(result["words"][0]["ocr_confidence"], 0.91)
        self.assertIsNone(result["words"][1]["ocr_confidence"])
        self.assertEqual(result["words"][0]["line_index"], 0)
        self.assertEqual(result["words"][1]["line_index"], 1)
        self.assertEqual(result["metadata"]["coordinate_space"], "normalized_original_dimensions")

    def test_invalid_tesseract_confidence_is_null(self):
        invalid_confidence = {
            "text": ["Chú"],
            "left": [100],
            "top": [50],
            "width": [40],
            "height": [20],
            "conf": ["150"],
            "block_num": [1],
            "par_num": [1],
            "line_num": [1],
        }
        patches = self._configured_tesseract()
        with patches[0], patches[1], patches[2], patch.object(
            ocr_engine.pytesseract,
            "image_to_data",
            return_value=invalid_confidence,
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png())

        self.assertIsNone(result["words"][0]["ocr_confidence"])

    def test_keeps_short_low_confidence_vietnamese_words_for_admin_review(self):
        uncertain = {
            "text": ["là"],
            "left": [100],
            "top": [50],
            "width": [25],
            "height": [20],
            "conf": ["-1"],
            "block_num": [1],
            "par_num": [1],
            "line_num": [1],
        }
        patches = self._configured_tesseract()
        with patches[0], patches[1], patches[2], patch.object(
            ocr_engine.pytesseract,
            "image_to_data",
            return_value=uncertain,
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png())

        self.assertEqual(result["text"], "là")
        self.assertEqual(len(result["words"]), 1)
        self.assertIsNone(result["words"][0]["ocr_confidence"])
        self.assertEqual(result["words"][0]["normalized_text"], "là")

    def test_uses_candidate_score_to_select_between_real_preprocessing_variants(self):
        def result_for(token: str, confidence: str) -> dict[str, list[object]]:
            return {
                "text": [token],
                "left": [200],
                "top": [100],
                "width": [50],
                "height": [25],
                "conf": [confidence],
                "block_num": [1],
                "par_num": [1],
                "line_num": [1],
            }

        candidates = iter([
            result_for("Chú", "35"),
            result_for("mèo", "95"),
            result_for("và", "80"),
        ])

        def fake_image_to_data(*_args, **_kwargs):
            return next(candidates)

        patches = self._configured_tesseract()
        with (
            patches[0],
            patches[1],
            patches[2],
            patch.dict(os.environ, {"TESSERACT_PSM": "", "TESSERACT_LANG": ""}),
            patch.object(
                ocr_engine.pytesseract,
                "image_to_data",
                new=fake_image_to_data,
            ),
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png())

        self.assertEqual(result["text"], "mèo")
        self.assertEqual(result["metadata"]["selected_psm"], 6)
        self.assertEqual(result["metadata"]["candidate_count"], 3)
        self.assertEqual(
            [candidate["preprocessing"] for candidate in result["metadata"]["candidate_scores"]],
            [
                "otsu_threshold",
                "clahe_grayscale",
                "adaptive_gaussian_threshold",
            ],
        )
        for actual, expected in zip(result["words"][0]["bbox"], (0.2, 0.2, 0.05, 0.05)):
            self.assertAlmostEqual(actual, expected)

    def test_candidate_score_rejects_empty_or_non_text_output(self):
        self.assertEqual(
            ocr_engine._candidate_quality_score({"text": ["", "   "], "conf": ["-1"]}),
            -1.0,
        )
        score = ocr_engine._candidate_quality_score({
            "text": ["Chú", "mèo"],
            "conf": ["92", "88"],
            "block_num": [1, 1],
            "par_num": [1, 1],
            "line_num": [1, 1],
        })
        self.assertGreater(score, 0.75)
        self.assertLessEqual(score, 1.0)

    def test_missing_vietnamese_language_data_fails_closed(self):
        with patch.object(ocr_engine.shutil, "which", return_value="/usr/bin/tesseract"), patch.object(
            ocr_engine.pytesseract, "get_tesseract_version", return_value="5.3.0"
        ), patch.object(ocr_engine.pytesseract, "get_languages", return_value=["eng"]):
            with self.assertRaises(ocr_engine.OcrEngineUnavailable):
                ocr_engine.extract_text_and_boxes(sample_png())

    def test_uses_vie_best_when_vie_not_available(self):
        with patch.object(ocr_engine.shutil, "which", return_value="/usr/bin/tesseract"), patch.object(
            ocr_engine.pytesseract, "get_tesseract_version", return_value="5.3.0"
        ), patch.object(ocr_engine.pytesseract, "get_languages", return_value=["eng", "vie_best"]), patch.object(
            ocr_engine.pytesseract, "image_to_data", return_value=tesseract_tsv()
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png())
        self.assertEqual(result["metadata"]["language"], "vie_best")

    def test_empty_tesseract_output_does_not_return_fake_words(self):
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
            ocr_engine.pytesseract,
            "image_to_data",
            return_value=empty,
        ):
            with self.assertRaises(ocr_engine.OcrNoTextDetected):
                ocr_engine.extract_text_and_boxes(sample_png())


if __name__ == "__main__":
    unittest.main()

