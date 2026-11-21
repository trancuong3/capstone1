"""OCR correction must align model words to OCR boxes, not bare punctuation."""
from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.schemas.admin_ocr import AdminOcrWordInput
from app.services.admin_ocr_chunking import ChunkingConfig
from app.services.admin_ocr_service import AdminOcrService


ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
PAGE_ID = UUID("22222222-2222-4222-8222-222222222222")


class AdminOcrCorrectionWordAlignmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_standalone_punctuation_does_not_require_an_ocr_box(self):
        service = AdminOcrService(MagicMock())
        service.require_admin = AsyncMock()
        service.repo.page = AsyncMock(
            return_value=SimpleNamespace(ImagePath="books/test/page.png")
        )
        words = [
            AdminOcrWordInput(
                word_index=index,
                line_index=0,
                text=text,
                normalized_text=text.casefold(),
                bbox=[0.1 + index * 0.3, 0.1, 0.2, 0.1],
                ocr_confidence=0.9,
            )
            for index, text in enumerate(("Bé", "đi"))
        ]
        config = SimpleNamespace(
            local=SimpleNamespace(chunking=ChunkingConfig())
        )

        with patch(
            "app.services.admin_ocr_service.OcrCorrectionConfig.from_environment",
            return_value=config,
        ):
            prepared = await service.prepare_ai_correction(
                ACTOR_ID, PAGE_ID, "Bé — đi", words
            )

        self.assertEqual(len(prepared.word_boxes), 2)
        self.assertEqual(prepared.total_chunks, 1)

