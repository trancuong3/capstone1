"""Unit tests for Dual-Engine OCR (PaddleOCR DBNet + VietOCR Transformer).

Mocked engine output tests without requiring GPU, live models, or external services.
"""
from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import cv2
import numpy as np

from app.services import ocr_engine


def sample_png_bytes(width: int = 400, height: int = 200) -> bytes:
    """Tạo nhanh ảnh giả lập trắng trong bộ nhớ RAM."""
    image = np.full((height, width, 3), 255, dtype=np.uint8)
    success, encoded = cv2.imencode(".png", image)
    if not success:
        raise AssertionError("Could not encode test image")
    return encoded.tobytes()


class DualEngineOcrTests(unittest.TestCase):
    def test_normalize_word_canonical_vietnamese(self):
        """Kiểm tra chuẩn hóa token tiếng Việt canonical."""
        self.assertEqual(ocr_engine.normalize_word("  Chú,  "), "chú")
        self.assertEqual(ocr_engine.normalize_word('"Mèo"'), "mèo")
        self.assertEqual(ocr_engine.normalize_word("..."), "")  # Dấu chấm câu được loại bỏ sạch
        self.assertEqual(ocr_engine.normalize_word("-"), "-")   # Giữ lại bullet gạch đầu dòng
        self.assertEqual(ocr_engine.normalize_word("Việt-Nam"), "việt-nam")

    def test_clean_ocr_punctuation(self):
        """Kiểm tra làm sạch dấu câu tất định."""
        self.assertEqual(ocr_engine.clean_ocr_punctuation("?Có phải không"), '"Có phải không')
        self.assertEqual(ocr_engine.clean_ocr_punctuation("Thật sao...3?"), 'Thật sao...?"')

    def test_is_vietocr_reliable_filters_hallucination(self):
        """VietOCR Transformer lặp từ tự hồi quy sẽ bị từ chối."""
        self.assertFalse(ocr_engine.is_vietocr_reliable("từ từ từ", "từ hôm qua"))
        self.assertTrue(ocr_engine.is_vietocr_reliable("Xin chào bạn", "Xin chao ban"))

    def test_empty_paddle_output_raises_no_text_detected(self):
        """Khi PaddleOCR không phát hiện được chữ nào, phải ném ngoại lệ OcrNoTextDetected."""
        mock_paddle = MagicMock()
        mock_paddle.ocr.return_value = [[]]
        mock_viet = MagicMock()

        with patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_viet)):
            with self.assertRaises(ocr_engine.OcrNoTextDetected):
                ocr_engine.extract_text_and_boxes(sample_png_bytes())

    def test_extract_text_and_boxes_dual_engine_contract(self):
        """Kiểm tra hợp đồng dữ liệu chuẩn hóa của Dual-Engine."""
        # Giả lập kết quả trả về từ DBNet của PaddleOCR: 1 dòng chữ gồm 2 từ
        # Tọa độ hộp [tl, tr, br, bl] trên ảnh kích thước 400x200
        quad = [[40.0, 30.0], [160.0, 30.0], [160.0, 70.0], [40.0, 70.0]]
        paddle_raw = [[quad, ("Chu meo", 0.95)]]

        mock_paddle = MagicMock()
        mock_paddle.ocr.return_value = [paddle_raw]

        mock_viet = MagicMock()
        mock_viet.predict.return_value = "Chú mèo"

        with patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_viet)):
            result = ocr_engine.extract_text_and_boxes(sample_png_bytes(400, 200))

        # Kiểm tra nội dung trích xuất
        self.assertEqual(result["text"], "Chú mèo")
        self.assertEqual(len(result["words"]), 2)

        first_word = result["words"][0]
        self.assertEqual(first_word["text"], "Chú")
        self.assertEqual(first_word["normalized_text"], "chú")
        self.assertEqual(first_word["line_index"], 0)
        self.assertAlmostEqual(first_word["ocr_confidence"], 0.95, places=2)

        # Bounding box chuẩn hóa trong không gian [0, 1]
        bbox = first_word["bbox"]
        self.assertEqual(len(bbox), 4)
        self.assertTrue(0.0 <= bbox[0] <= 1.0)
        self.assertTrue(0.0 <= bbox[1] <= 1.0)
        self.assertTrue(bbox[0] + bbox[2] <= 1.0)
        self.assertTrue(bbox[1] + bbox[3] <= 1.0)

        # Metadata chuẩn xác của hệ thống Dual-Engine mới
        meta = result["metadata"]
        self.assertEqual(meta["engine"], "paddleocr_vietocr_dual")
        self.assertEqual(meta["language"], "vi")
        self.assertEqual(meta["coordinate_space"], "normalized_original_dimensions")
        self.assertEqual(meta["word_count"], 2)
        self.assertEqual(meta["line_count"], 1)


if __name__ == "__main__":
    unittest.main()