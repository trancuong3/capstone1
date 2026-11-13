"""Unit tests for Dual-Engine OCR (PaddleOCR DBNet + VietOCR Transformer).

Mocked engine output tests without requiring GPU, live models, or external services.
"""
from __future__ import annotations

import os
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock, patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import cv2
import numpy as np

from app.services import ocr_engine
from app.services.admin_ocr_service import AdminOcrService


_tesseract_cross_check = patch.object(
    ocr_engine,
    "_attach_tesseract_line_readings",
    return_value={"status": "not_run", "paired_words": 0, "error": None, "elapsed_ms": 0.0},
)


def setUpModule() -> None:
    # These tests drive PaddleOCR/VietOCR through mocks. The real Tesseract
    # binary must not read the blank sample images, or results would depend
    # on what is installed. Its pairing is covered in test_ocr_adjudication.py.
    _tesseract_cross_check.start()


def tearDownModule() -> None:
    _tesseract_cross_check.stop()


def sample_png_bytes(width: int = 400, height: int = 200) -> bytes:
    """Tạo nhanh ảnh giả lập trắng trong bộ nhớ RAM."""
    image = np.full((height, width, 3), 255, dtype=np.uint8)
    success, encoded = cv2.imencode(".png", image)
    if not success:
        raise AssertionError("Could not encode test image")
    return encoded.tobytes()


class DualEngineOcrTests(unittest.TestCase):
    def test_tesseract_uses_configured_binary_or_discovers_installation(self):
        configured_path = r"C:\tools\tesseract.exe"
        discovered_path = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

        with patch.dict(os.environ, {"TESSERACT_CMD": configured_path}):
            result = ocr_engine._resolve_tesseract_command()
        self.assertEqual(result, configured_path)

        with patch.dict(os.environ, {"TESSERACT_CMD": ""}):
            with patch.object(ocr_engine.shutil, "which", return_value=discovered_path):
                result = ocr_engine._resolve_tesseract_command()
        self.assertEqual(result, discovered_path)

    def test_normalize_word_canonical_vietnamese(self):
        """Kiểm tra chuẩn hóa token tiếng Việt canonical."""
        self.assertEqual(ocr_engine.normalize_word("  Chú,  "), "chú")
        self.assertEqual(ocr_engine.normalize_word('"Mèo"'), "mèo")
        self.assertEqual(ocr_engine.normalize_word("..."), "")  # Dấu chấm câu được loại bỏ sạch
        self.assertEqual(ocr_engine.normalize_word("-"), "-")   # Giữ lại bullet gạch đầu dòng
        self.assertEqual(ocr_engine.normalize_word("Việt-Nam"), "việt-nam")

    def test_source_token_indexes_survive_empty_token_filtering(self):
        self.assertEqual(
            ocr_engine._tokens_with_source_indices("một !!! hai"),
            [(0, "một"), (2, "hai")],
        )

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

        with (
            patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_viet)),
            patch.object(ocr_engine, "_extract_text_and_boxes_tesseract",
                         side_effect=ocr_engine.OcrNoTextDetected("No text in the test image")) as fallback,
        ):
            with self.assertRaises(ocr_engine.OcrNoTextDetected):
                ocr_engine.extract_text_and_boxes(sample_png_bytes())
        fallback.assert_called_once()

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

        with (
            patch.dict(os.environ, {"OCR_DEBUG_BOXES_PATH": ""}),
            patch.object(ocr_engine.cv2, "imwrite") as debug_write,
            patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_viet)),
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png_bytes(400, 200))
        debug_write.assert_not_called()

        # Kiểm tra nội dung trích xuất
        self.assertEqual(result["text"], "Chú mèo")
        self.assertEqual(len(result["words"]), 2)

        first_word = result["words"][0]
        self.assertEqual(first_word["text"], "Chú")
        self.assertEqual(first_word["normalized_text"], "chú")
        self.assertEqual(first_word["line_index"], 0)
        self.assertIsNone(first_word["ocr_score_source"])
        self.assertIsNone(first_word["ocr_confidence"])
        self.assertEqual(first_word["ocr_review_status"], "engine_disagreement")
        self.assertEqual(
            [word["ocr_review_status"] for word in result["words"]],
            ["engine_disagreement", "engine_disagreement"],
            "Tone-only disagreement requires review and is not evidence of which token is wrong",
        )
        self.assertTrue(all(word["ocr_confidence"] is None for word in result["words"]))
        self.assertEqual(
            [word["ocr_evidence"]["alignment"] for word in result["words"]],
            ["substitute", "substitute"],
        )
        self.assertEqual(
            [word["ocr_evidence"]["engine_outputs"] for word in result["words"]],
            [
                {"paddleocr": "Chu", "vietocr": "Chú"},
                {"paddleocr": "meo", "vietocr": "mèo"},
            ],
        )
        self.assertEqual(
            result["metadata"]["engine_statuses"],
            {"paddleocr": "success", "vietocr": "success", "tesseract": "not_run"},
        )
        self.assertEqual(
            result["words"][0]["ocr_evidence"]["engine_statuses"],
            {"paddleocr": "success", "vietocr": "success", "tesseract": "not_run"},
        )
        self.assertEqual(result["words"][0]["ocr_evidence"]["paddle_token_index"], 0)
        self.assertEqual(result["words"][0]["ocr_evidence"]["vietocr_token_index"], 0)

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
        self.assertIsNone(meta["ocr_score_contract"])
        self.assertEqual(meta["ocr_evidence_contract"], "hybrid_ocr_evidence_v4")
        self.assertEqual(meta["line_evidence"][0]["paddle_line_confidence"], 0.95)
        self.assertEqual(
            meta["line_evidence"][0]["paddle_line_score_contract"],
            "paddle_line_score_v1",
        )

    def test_dual_engine_line_evidence_keeps_insertions_and_deletions_separate_from_boxes(self):
        quad = [[40.0, 30.0], [260.0, 30.0], [260.0, 70.0], [40.0, 70.0]]
        mock_paddle = MagicMock()
        mock_paddle.ocr.return_value = [[[quad, ("một ba", 0.95)]]]
        mock_viet = MagicMock()
        mock_viet.predict.return_value = "một hai ba"

        with (
            patch.dict(os.environ, {"OCR_DEBUG_BOXES_PATH": ""}),
            patch.object(ocr_engine.cv2, "imwrite"),
            patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_viet)),
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png_bytes(400, 200))

        line = result["metadata"]["line_evidence"][0]
        operations = line["alignment_operations"]
        self.assertNotEqual(line["paddle_output"].split(), line["vietocr_output"].split())
        self.assertTrue(any(step["operation"] in {"insert", "delete"} for step in operations))
        self.assertEqual(len(result["words"]), len(result["text"].split()))
        self.assertTrue(all(len(word["bbox"]) == 4 for word in result["words"]))
        self.assertTrue(
            all(word["ocr_confidence"] is None for word in result["words"]),
            "The raw Paddle line score must not be duplicated into word probability.",
        )

    def test_split_merge_candidates_are_attached_to_each_selected_source_token(self):
        quad = [[20.0, 30.0], [380.0, 30.0], [380.0, 90.0], [20.0, 90.0]]

        # One PaddleOCR token corresponds to two VietOCR tokens. Keep selected
        # source indexes and avoid inventing a one-to-one opposite-engine token.
        mock_paddle = MagicMock()
        mock_paddle.ocr.return_value = [[[quad, ("xinchao", 0.95)]]]
        mock_viet = MagicMock()
        mock_viet.predict.return_value = "xin chao"
        with (
            patch.dict(os.environ, {"OCR_DEBUG_BOXES_PATH": ""}),
            patch.object(ocr_engine.cv2, "imwrite"),
            patch.object(ocr_engine, "is_vietocr_reliable", return_value=True),
            patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_viet)),
        ):
            merged = ocr_engine.extract_text_and_boxes(sample_png_bytes(400, 200))

        self.assertEqual([word["text"] for word in merged["words"]], ["xin", "chao"])
        self.assertEqual([word["ocr_evidence"]["alignment"] for word in merged["words"]], ["merge", "merge"])
        self.assertEqual(
            [word["ocr_evidence"]["engine_outputs"] for word in merged["words"]],
            [
                {"paddleocr": None, "vietocr": "xin"},
                {"paddleocr": None, "vietocr": "chao"},
            ],
        )
        self.assertEqual([word["ocr_evidence"]["vietocr_token_index"] for word in merged["words"]], [0, 1])
        self.assertEqual([word["ocr_evidence"]["paddle_token_index"] for word in merged["words"]], [None, None])
        self.assertEqual(
            merged["metadata"]["line_evidence"][0]["split_merge_candidates"],
            [{"operation": "merge", "primary_indices": [0], "secondary_indices": [0, 1]}],
        )

        # Reverse direction: two PaddleOCR tokens correspond to one VietOCR token.
        mock_paddle = MagicMock()
        mock_paddle.ocr.return_value = [[[quad, ("xin chao", 0.95)]]]
        mock_viet = MagicMock()
        mock_viet.predict.return_value = "xinchao"
        with (
            patch.dict(os.environ, {"OCR_DEBUG_BOXES_PATH": ""}),
            patch.object(ocr_engine.cv2, "imwrite"),
            patch.object(ocr_engine, "is_vietocr_reliable", return_value=False),
            patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_viet)),
        ):
            split = ocr_engine.extract_text_and_boxes(sample_png_bytes(400, 200))

        self.assertEqual([word["text"] for word in split["words"]], ["xin", "chao"])
        self.assertEqual([word["ocr_evidence"]["alignment"] for word in split["words"]], ["split", "split"])
        self.assertEqual(
            [word["ocr_evidence"]["engine_outputs"] for word in split["words"]],
            [
                {"paddleocr": "xin", "vietocr": None},
                {"paddleocr": "chao", "vietocr": None},
            ],
        )
        self.assertEqual([word["ocr_evidence"]["paddle_token_index"] for word in split["words"]], [0, 1])
        self.assertEqual([word["ocr_evidence"]["vietocr_token_index"] for word in split["words"]], [None, None])
        self.assertEqual(
            split["metadata"]["line_evidence"][0]["split_merge_candidates"],
            [{"operation": "split", "primary_indices": [0, 1], "secondary_indices": [0]}],
        )

    def test_shared_models_serialize_inference_across_concurrent_requests(self):
        counters = {
            name: {"guard": threading.Lock(), "active": 0, "max_active": 0}
            for name in ("paddle", "vietocr")
        }

        def tracked(counter, result_factory):
            with counter["guard"]:
                counter["active"] += 1
                counter["max_active"] = max(counter["max_active"], counter["active"])
            time.sleep(0.02)
            try:
                return result_factory()
            finally:
                with counter["guard"]:
                    counter["active"] -= 1

        def paddle_result():
            # A fresh box is needed because the extraction path normalizes
            # PaddleOCR coordinates in-place after detection.
            quad = [[20.0, 30.0], [380.0, 30.0], [380.0, 90.0], [20.0, 90.0]]
            return [[[quad, ("Xin chao", 0.95)]]]

        mock_paddle = MagicMock()
        mock_paddle.ocr.side_effect = lambda *_args, **_kwargs: tracked(
            counters["paddle"], paddle_result
        )
        mock_viet = MagicMock()
        mock_viet.predict.side_effect = lambda *_args, **_kwargs: tracked(
            counters["vietocr"], lambda: "Xin chao"
        )
        image_bytes = sample_png_bytes(400, 200)

        with (
            patch.dict(os.environ, {"OCR_DEBUG_BOXES_PATH": ""}),
            patch.object(ocr_engine.cv2, "imwrite"),
            patch.object(ocr_engine, "is_vietocr_reliable", return_value=True),
            patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_viet)),
        ):
            with ThreadPoolExecutor(max_workers=4) as executor:
                results = list(
                    executor.map(
                        lambda _index: ocr_engine.extract_text_and_boxes(image_bytes),
                        range(4),
                    )
                )

        self.assertEqual(len(results), 4)
        self.assertTrue(all(result["text"] == "Xin chao" for result in results))
        self.assertEqual(mock_paddle.ocr.call_count, 4)
        self.assertEqual(mock_viet.predict.call_count, 4)
        self.assertEqual(counters["paddle"]["max_active"], 1)
        self.assertEqual(counters["vietocr"]["max_active"], 1)

    def test_invalid_paddle_line_scores_remain_unavailable_at_line_scope(self):
        quad = [[40.0, 30.0], [160.0, 30.0], [160.0, 70.0], [40.0, 70.0]]
        for invalid_score in (float("nan"), float("inf"), True, -0.1, 1.1):
            with self.subTest(score=invalid_score):
                mock_paddle = MagicMock()
                mock_paddle.ocr.return_value = [[[quad, ("ma", invalid_score)]]]
                mock_viet = MagicMock()
                mock_viet.predict.return_value = "ma"
                with (
                    patch.dict(os.environ, {"OCR_DEBUG_BOXES_PATH": ""}),
                    patch.object(ocr_engine.cv2, "imwrite"),
                    patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_viet)),
                ):
                    result = ocr_engine.extract_text_and_boxes(sample_png_bytes())
                self.assertIsNone(
                    result["metadata"]["line_evidence"][0]["paddle_line_confidence"]
                )
                self.assertIsNone(result["words"][0]["ocr_confidence"])

    def test_word_evidence_separates_agreement_from_probability_and_reference(self):
        score, status, source = ocr_engine._word_ocr_evidence("on", "on", 0.95)
        self.assertIsNone(score)
        self.assertIsNone(source)
        self.assertEqual(status, "engine_agreement")

        wrong_reference = [{
            "text": "on",
            "ocr_confidence": None,
            "ocr_evidence": {
                "contract": "dual_engine_agreement_v2",
                "engine_outputs": {"paddleocr": "on", "vietocr": "on"},
                "alignment": "match",
                "engine_agreement_score": 1.0,
                "calibrated_word_accuracy": None,
                "verification_source": None,
                "reference_text": None,
                "review_reason": "Both engines returned the same token.",
            },
        }]
        operations = AdminOcrService._apply_verified_reference(
            wrong_reference, "ơn"
        )
        self.assertEqual(operations[0]["operation"], "substitute")
        self.assertEqual(wrong_reference[0]["ocr_review_status"], "confirmed_mismatch")
        self.assertEqual(wrong_reference[0]["ocr_evidence"]["reference_text"], "ơn")
        self.assertEqual(
            wrong_reference[0]["ocr_evidence"]["verification_source"],
            "verified_revision",
        )
        self.assertIsNone(wrong_reference[0]["ocr_confidence"])

        punctuation_match = [{"text": "Cửa,"}]
        AdminOcrService._apply_verified_reference(punctuation_match, "cửa")
        self.assertEqual(
            punctuation_match[0]["ocr_review_status"], "reference_match"
        )

        ambiguous_alignment = [{"text": token} for token in ("sư", "on", "cửa")]
        AdminOcrService._apply_verified_reference(ambiguous_alignment, "sư ơn")
        self.assertEqual(
            [word["ocr_review_status"] for word in ambiguous_alignment],
            ["reference_match", "needs_review", "needs_review"],
            "Unequal token counts must not create false red mismatch labels.",
        )

        verified_words = [{"text": text, "ocr_confidence": None} for text in ("sư", "đồ", "cửa")]
        AdminOcrService._apply_verified_reference(verified_words, "sư đồ cửa")
        self.assertEqual(
            [word["ocr_review_status"] for word in verified_words],
            ["reference_match", "reference_match", "reference_match"],
        )

    def test_user_examples_remain_unresolved_engine_disagreements(self):
        for paddle_token, vietocr_token in (("lui", "hui"), ("vé", "về")):
            with self.subTest(paddle=paddle_token, vietocr=vietocr_token):
                aligned = ocr_engine.align_ocr_tokens(
                    [paddle_token], [vietocr_token]
                )
                self.assertEqual(aligned[0]["operation"], "substitute")
                score, status = ocr_engine._word_engine_evidence(
                    paddle_token, vietocr_token
                )
                self.assertIsNotNone(score)
                self.assertLess(score, 1.0)
                self.assertEqual(status, "engine_disagreement")
                confidence, _review_status, _source = ocr_engine._word_ocr_evidence(
                    paddle_token, vietocr_token, 0.999
                )
                self.assertIsNone(confidence)

    def test_vietnamese_diacritics_are_alignment_hints_not_exact_matches(self):
        pairs = (
            ("ơn", "on"),
            ("nàng", "nảng"),
            ("sư", "su"),
            ("đồ", "đo"),
            ("cửa", "cua"),
            ("ma", "má"),
            ("a", "ă"),
            ("d", "đ"),
        )
        for recognized, alternative in pairs:
            with self.subTest(recognized=recognized, alternative=alternative):
                alignment = ocr_engine.align_ocr_tokens([recognized], [alternative])
                self.assertEqual(len(alignment), 1)
                self.assertEqual(alignment[0]["operation"], "substitute")
                self.assertLess(alignment[0]["similarity"], 1.0)

    def test_sequence_alignment_is_global_monotonic_and_explicit_about_gaps(self):
        equal = ocr_engine.align_ocr_tokens(
            ["Ngọc", "đế", "ơn", "trên"], ["Ngọc", "đế", "on", "trên"]
        )
        self.assertEqual(
            [step["operation"] for step in equal],
            ["match", "match", "substitute", "match"],
        )
        self.assertEqual(
            [(step["primary_index"], step["secondary_index"]) for step in equal],
            [(0, 0), (1, 1), (2, 2), (3, 3)],
        )

        missing = ocr_engine.align_ocr_tokens(
            ["đầu", "giữa", "cuối"], ["đầu", "cuối"]
        )
        self.assertIn(
            ("delete", 1, None),
            [(step["operation"], step["primary_index"], step["secondary_index"]) for step in missing],
        )
        extra = ocr_engine.align_ocr_tokens(["một", "ba"], ["một", "hai", "ba"])
        self.assertIn(
            ("insert", None, 1),
            [(step["operation"], step["primary_index"], step["secondary_index"]) for step in extra],
        )

        repeated = ocr_engine.align_ocr_tokens(
            ["đi", "đi", "đến"], ["đi", "xa", "đi", "đến"]
        )
        primary_matches = [
            step["primary_index"] for step in repeated if step["primary_index"] is not None
        ]
        secondary_matches = [
            step["secondary_index"] for step in repeated if step["secondary_index"] is not None
        ]
        self.assertEqual(len(primary_matches), len(set(primary_matches)))
        self.assertEqual(len(secondary_matches), len(set(secondary_matches)))
        self.assertEqual(primary_matches, sorted(primary_matches))
        self.assertEqual(secondary_matches, sorted(secondary_matches))

        punctuation = ocr_engine.align_ocr_tokens(["cửa,", "Sư"], ["cửa", "sư"])
        self.assertEqual([step["operation"] for step in punctuation], ["substitute", "substitute"])
        capped = ocr_engine.align_ocr_tokens(["a", "b"], ["a", "b"], max_cells=1)
        self.assertEqual([step["operation"] for step in capped], ["delete", "delete", "insert", "insert"])

    def test_tesseract_keeps_its_per_word_raw_scores_without_claiming_verification(self):
        data = {
            "text": ["ma", "má", "mèo"],
            "left": [10, 70, 130],
            "top": [20, 20, 20],
            "width": [40, 40, 40],
            "height": [20, 20, 20],
            "conf": ["92", "27", "62"],
            "line_num": [1, 1, 1],
        }
        with patch.object(ocr_engine.pytesseract, "image_to_data", return_value=data):
            result = ocr_engine._extract_text_and_boxes_tesseract(sample_png_bytes())

        self.assertEqual(
            [word["ocr_confidence"] for word in result["words"]],
            [0.92, 0.27, 0.62],
        )
        self.assertEqual(
            [word["ocr_review_status"] for word in result["words"]],
            ["needs_review", "needs_review", "needs_review"],
        )
        for confidence in (None, 0.0, 0.92, 1.0):
            self.assertEqual(
                ocr_engine._tesseract_review_status(confidence),
                "needs_review",
            )
        self.assertEqual(
            result["metadata"]["ocr_score_contract"], "tesseract_raw_word_score_v1"
        )
        self.assertEqual(
            result["words"][0]["ocr_evidence"]["contract"],
            "tesseract_raw_word_score_v1",
        )

    def test_paddle_output_survives_vietocr_inference_error(self):
        quad = [[40.0, 30.0], [260.0, 30.0], [260.0, 70.0], [40.0, 70.0]]
        mock_paddle = MagicMock()
        mock_paddle.ocr.return_value = [[[quad, ("công chúa", 0.95)]]]
        mock_viet = MagicMock()
        mock_viet.predict.side_effect = RuntimeError("model failure")

        with (
            patch.dict(os.environ, {"OCR_DEBUG_BOXES_PATH": ""}),
            patch.object(ocr_engine.cv2, "imwrite"),
            patch.object(
                ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_viet)
            ),
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png_bytes())

        self.assertEqual(result["text"], "công chúa")
        self.assertEqual(
            result["metadata"]["engine_statuses"]["paddleocr"], "success"
        )
        self.assertEqual(result["metadata"]["engine_statuses"]["vietocr"], "error")
        self.assertEqual(
            result["words"][0]["ocr_evidence"]["engine_errors"]["vietocr"],
            "RuntimeError",
        )
        self.assertEqual(
            result["words"][0]["ocr_evidence"]["engine_outputs"]["paddleocr"],
            "công",
        )
        self.assertIsNone(
            result["words"][0]["ocr_evidence"]["engine_outputs"]["vietocr"]
        )
        self.assertEqual(
            result["words"][0]["ocr_evidence"]["engine_statuses"]["vietocr"],
            "error",
        )

    def test_paddle_recognition_remains_available_when_vietocr_was_not_initialized(self):
        quad = [[40.0, 30.0], [260.0, 30.0], [260.0, 70.0], [40.0, 70.0]]
        mock_paddle = MagicMock()
        mock_paddle.ocr.return_value = [[[quad, ("một hai", 0.95)]]]

        with (
            patch.dict(os.environ, {"OCR_DEBUG_BOXES_PATH": ""}),
            patch.object(ocr_engine.cv2, "imwrite"),
            patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, None)),
            patch.object(ocr_engine, "_vietocr_initialization_status", "not_initialized"),
        ):
            result = ocr_engine.extract_text_and_boxes(sample_png_bytes())

        self.assertEqual(result["text"], "một hai")
        self.assertEqual(result["metadata"]["engine_statuses"]["paddleocr"], "success")
        self.assertEqual(result["metadata"]["engine_statuses"]["vietocr"], "not_initialized")
        self.assertEqual(result["metadata"]["engine_statuses"]["tesseract"], "not_run")
        self.assertEqual(
            result["words"][0]["ocr_evidence"]["engine_outputs"]["paddleocr"],
            "một",
        )
        self.assertIsNone(
            result["words"][0]["ocr_evidence"]["engine_outputs"]["vietocr"]
        )

    def test_broken_installed_paddle_import_is_not_reported_as_not_installed(self):
        with (
            patch.object(ocr_engine, "_paddle_engine", None),
            patch.object(ocr_engine, "_vietocr_engine", MagicMock()),
            patch.object(ocr_engine, "_ocr_dependencies_loaded", True),
            patch.object(ocr_engine, "PaddleOCR", None),
            patch.object(ocr_engine, "_paddle_import_status", "not_initialized"),
            patch.object(ocr_engine, "_paddle_import_error", "ModuleNotFoundError"),
            # _get_ocr_engines mutates this lifecycle field; restore it after
            # this simulated import failure so later tests see isolated state.
            patch.object(ocr_engine, "_paddle_initialization_error", None),
        ):
            with self.assertRaises(ocr_engine.OcrEngineUnavailable):
                ocr_engine._get_ocr_engines()
            self.assertEqual(
                ocr_engine._paddle_initialization_status, "not_initialized"
            )
            self.assertEqual(
                ocr_engine._paddle_initialization_error, "ModuleNotFoundError"
            )

    def test_vietocr_initialization_failure_does_not_disable_existing_paddle_detector(self):
        paddle_instance = MagicMock()
        config_loader = MagicMock()
        config_loader.load_config_from_name.side_effect = RuntimeError("missing weights")
        predictor_factory = MagicMock()

        with (
            patch.object(ocr_engine, "_paddle_engine", paddle_instance),
            patch.object(ocr_engine, "_vietocr_engine", None),
            patch.object(ocr_engine, "_paddle_initialization_status", "success"),
            patch.object(ocr_engine, "_paddle_initialization_error", None),
            patch.object(ocr_engine, "_ocr_dependencies_loaded", True),
            patch.object(ocr_engine, "_vietocr_initialization_status", "not_initialized"),
            patch.object(ocr_engine, "_vietocr_initialization_error", None),
            patch.object(ocr_engine, "Cfg", config_loader),
            patch.object(ocr_engine, "Predictor", predictor_factory),
            patch.object(ocr_engine, "_find_cached_vietocr_weights", return_value=None),
            patch.object(ocr_engine, "torch", MagicMock()),
            patch.object(ocr_engine.torch.cuda, "is_available", return_value=False),
            patch.object(ocr_engine.torch, "set_num_threads"),
        ):
            paddle, viet = ocr_engine._get_ocr_engines()

            # Assert while patches are active. After the context exits, patch
            # correctly restores the pre-test module state.
            self.assertIs(paddle, paddle_instance)
            self.assertIsNone(viet)
            self.assertEqual(ocr_engine._paddle_initialization_status, "success")
            self.assertEqual(ocr_engine._vietocr_initialization_status, "not_initialized")
            self.assertEqual(ocr_engine._vietocr_initialization_error, "RuntimeError")
            self.assertEqual(ocr_engine._paddle_initialization_error, None)
            predictor_factory.assert_not_called()

    def test_unexpected_dual_pipeline_error_is_not_replaced_by_tesseract(self):
        mock_paddle = MagicMock()
        mock_vietocr = MagicMock()
        with (
            patch.object(
                ocr_engine,
                "_get_ocr_engines",
                return_value=(mock_paddle, mock_vietocr),
            ),
            patch.object(
                ocr_engine,
                "_extract_text_and_boxes_dual_engine",
                side_effect=RuntimeError("alignment processing bug"),
            ),
            patch.object(ocr_engine, "_extract_text_and_boxes_tesseract") as tesseract,
        ):
            with self.assertRaisesRegex(RuntimeError, "alignment processing bug"):
                ocr_engine.extract_text_and_boxes(sample_png_bytes())
        tesseract.assert_not_called()

    def test_fallback_to_tesseract_when_dual_engine_unavailable(self):
        """Khi Dual-Engine không có trong môi trường, hệ thống tự động fallback Tesseract."""
        mock_tesseract_result = {
            "text": "Con mèo trèo cây cau",
            "words": [
                {
                    "word_index": 0,
                    "line_index": 0,
                    "text": "Con",
                    "normalized_text": "con",
                    "bbox": [0.1, 0.1, 0.1, 0.1],
                    "ocr_confidence": 0.9,
                }
            ],
            "metadata": {"engine": "tesseract"},
        }
        with patch.object(
            ocr_engine,
            "_get_ocr_engines",
            side_effect=ocr_engine.OcrEngineUnavailable("Libraries not installed"),
        ):
            with patch.object(
                ocr_engine,
                "_extract_text_and_boxes_tesseract",
                return_value=mock_tesseract_result,
            ):
                result = ocr_engine.extract_text_and_boxes(sample_png_bytes())
                self.assertEqual(result["metadata"]["engine"], "tesseract")
                self.assertEqual(result["text"], "Con mèo trèo cây cau")
                self.assertEqual(
                    result["metadata"]["engine_statuses"],
                    {
                        "paddleocr": ocr_engine._paddle_initialization_status,
                        "vietocr": "not_run",
                        "tesseract": "success",
                    },
                )


if __name__ == "__main__":
    unittest.main()
