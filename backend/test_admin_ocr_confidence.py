"""Admin OCR confidence provenance tests; no live database or Storage access."""
from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.services.admin_ocr_service import AdminOcrService

PAGE_ID = UUID("33333333-3333-4333-8333-333333333333")
REVISION_ID = UUID("44444444-4444-4444-8444-444444444444")


class AdminOcrConfidenceProvenanceTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self, row, processing_meta):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[row])
        page = SimpleNamespace(Id=PAGE_ID, LifecycleStatus="ACTIVE")
        revision = SimpleNamespace(
            Id=REVISION_ID,
            RevisionNo="1",
            VerificationStatus="NEEDS_REVIEW",
            VerifiedText=None,
            DraftText=str(row.Text),
            ProcessingMeta=processing_meta,
            CreatedAt=datetime.now(timezone.utc),
            VerifiedAt=None,
            VerifiedBy=None,
        )
        return service, page, revision

    @staticmethod
    def make_word(text: str, confidence: float | None):
        return SimpleNamespace(
            WordIndex=0,
            LineIndex=0,
            Text=text,
            NormalizedText=text.lower(),
            BoundingBox=[0.1, 0.2, 0.2, 0.05],
            OCRConfidence=confidence,
        )

    async def test_tesseract_native_word_score_is_exposed_as_raw_not_calibrated(self):
        row = self.make_word("Mèo", 0.88)
        service, page, revision = self.make_service(
            row,
            {
                "engine": "tesseract",
                "confidence_contract": {
                    "calibration_status": "NOT_CALIBRATED",
                    "calibrated_confidence_available": False,
                },
                "word_confidence_evidence": [
                    {
                        "word_index": 0,
                        "recognized_text": "Mèo",
                        "confidence_source": "tesseract",
                        "confidence_scope": "word",
                        "raw_engine_score": 88.0,
                        "line_engine_score": None,
                        "calibrated_confidence": None,
                        "calibration_status": "NOT_CALIBRATED",
                    }
                ],
            },
        )

        detail = await service.revision_detail(page, revision)
        word = detail.words[0]

        self.assertEqual(word.raw_engine_score, 88.0)
        self.assertEqual(word.confidence_source, "tesseract")
        self.assertEqual(word.confidence_scope, "word")
        self.assertIsNone(word.calibrated_confidence)
        self.assertEqual(word.calibration_status, "NOT_CALIBRATED")
        self.assertEqual(word.confidence_applicability, "APPLIES_TO_CURRENT_TEXT")

    async def test_paddle_line_score_is_not_exposed_as_a_word_score(self):
        row = self.make_word("Chú", None)
        service, page, revision = self.make_service(
            row,
            {
                "engine": "paddleocr_vietocr_dual",
                "word_confidence_evidence": [
                    {
                        "word_index": 0,
                        "recognized_text": "Chú",
                        "confidence_source": "paddleocr",
                        "confidence_scope": "line",
                        "raw_engine_score": None,
                        "line_engine_score": 0.93,
                        "calibrated_confidence": None,
                        "calibration_status": "NOT_CALIBRATED",
                    }
                ],
            },
        )

        detail = await service.revision_detail(page, revision)
        word = detail.words[0]

        self.assertIsNone(word.raw_engine_score)
        self.assertEqual(word.line_engine_score, 0.93)
        self.assertEqual(word.confidence_scope, "line")
        self.assertIsNone(word.calibrated_confidence)

    async def test_original_score_is_not_applied_to_a_manually_corrected_token(self):
        row = self.make_word("Mẹo", 0.88)
        service, page, revision = self.make_service(
            row,
            {
                "engine": "tesseract",
                "word_confidence_evidence": [
                    {
                        "word_index": 0,
                        "recognized_text": "Mèo",
                        "confidence_source": "tesseract",
                        "confidence_scope": "word",
                        "raw_engine_score": 88.0,
                        "line_engine_score": None,
                        "calibrated_confidence": None,
                        "calibration_status": "NOT_CALIBRATED",
                    }
                ],
            },
        )

        detail = await service.revision_detail(page, revision)
        word = detail.words[0]

        self.assertIsNone(word.raw_engine_score)
        self.assertEqual(
            word.confidence_applicability,
            "ORIGINAL_OCR_TEXT_ONLY",
        )
        self.assertEqual(word.confidence_source, "tesseract")

    async def test_legacy_score_without_provenance_is_unknown(self):
        row = self.make_word("Mèo", 0.95)
        service, page, revision = self.make_service(
            row,
            {"engine": "paddleocr_vietocr_dual"},
        )

        detail = await service.revision_detail(page, revision)
        word = detail.words[0]

        self.assertEqual(word.ocr_confidence, 0.95)
        self.assertIsNone(word.raw_engine_score)
        self.assertIsNone(word.calibrated_confidence)
        self.assertEqual(word.calibration_status, "UNKNOWN")
        self.assertEqual(word.confidence_applicability, "UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
