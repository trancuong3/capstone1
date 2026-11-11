"""Reading images must describe the selected revision, not the current page."""

import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.services.reading_content_service import ReadingContentService


class ReadingRevisionImageTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_geometry_falls_back_without_rewriting_revision_or_words(self):
        service, repo, page, revision = self.make_content(metadata={})
        with patch("app.services.reading_content_service.create_signed_image_url", return_value="https://example.com/page.png"):
            dto = await service._build_page_dto(page, revision)
        self.assertFalse(dto.image_overlay_safe)
        self.assertEqual(dto.words[0].word_id, repo.revision_words.return_value[0].Id)
        self.assertEqual(dto.words[0].bbox, (0.1, 0.2, 0.12, 0.04))
        self.assertEqual(revision.ProcessingMeta, {})

    async def test_geometry_proof_matches_the_selected_revision_words_and_source_dimensions(self):
        from copy import deepcopy
        from app.services.word_box_geometry import build_geometry_evidence
        service, repo, page, revision = self.make_content(metadata={})
        words = [dict(word_index=0, line_index=0, text="Bé", bbox=[0.1, 0.2, 0.12, 0.04])]
        revision.ProcessingMeta = {"word_box_geometry": build_geometry_evidence(words, 1200, 1600, reliable=True)}
        before = deepcopy(revision.ProcessingMeta)
        with patch("app.services.reading_content_service.create_signed_image_url", return_value="https://example.com/page.png"):
            good = await service._build_page_dto(page, revision)
            self.assertTrue(good.image_overlay_safe)
            # Simulate edited coordinates, retaining the old metadata.
            repo.revision_words.return_value[0].BoundingBox = [0.2, 0.2, 0.12, 0.04]
            changed = await service._build_page_dto(page, revision)
        self.assertFalse(changed.image_overlay_safe)
        self.assertEqual(revision.ProcessingMeta, before)
        self.assertEqual(good.words[0].word_id, changed.words[0].word_id)

    def make_content(self, *, historical=False, metadata=None):
        revision_id = uuid4()
        page = SimpleNamespace(
            Id=uuid4(),
            CurrentVerifiedRevisionId=uuid4() if historical else revision_id,
            PageNumber=1,
            Width=1200,
            Height=1600,
            ImagePath="books/book/pages/page/current.png",
        )
        revision = SimpleNamespace(
            Id=revision_id,
            VerifiedText="Bé đọc",
            ProcessingMeta=metadata,
        )
        repo = SimpleNamespace(
            db=SimpleNamespace(rollback=AsyncMock()),
            revision_words=AsyncMock(return_value=[
                SimpleNamespace(
                    Id=uuid4(), WordIndex=0, LineIndex=0, Text="Bé",
                    BoundingBox=[0.1, 0.2, 0.12, 0.04],
                ),
            ]),
        )
        return ReadingContentService(repo), repo, page, revision

    async def test_historical_revision_uses_its_source_image_and_dimensions(self):
        service, repo, page, revision = self.make_content(
            historical=True,
            metadata={
                "source_image_path": "books/book/pages/page/original.png",
                "source_image_width": 600,
                "source_image_height": 800,
            },
        )
        with patch(
            "app.services.reading_content_service.create_signed_image_url",
            return_value="https://example.com/signed-original.png",
        ) as sign:
            dto = await service._build_page_dto(page, revision)

        sign.assert_called_once_with("books/book/pages/page/original.png")
        repo.db.rollback.assert_awaited_once()
        self.assertEqual((dto.width, dto.height), (600, 800))
        self.assertEqual(dto.image_url, "https://example.com/signed-original.png")
        self.assertEqual(dto.page_revision_id, revision.Id)
        self.assertEqual(dto.words[0].bbox, (0.1, 0.2, 0.12, 0.04))

    async def test_legacy_current_revision_can_use_page_image(self):
        service, _, page, revision = self.make_content()
        with patch(
            "app.services.reading_content_service.create_signed_image_url",
            return_value="https://example.com/signed-current.png",
        ) as sign:
            dto = await service._build_page_dto(page, revision)

        sign.assert_called_once_with(page.ImagePath)
        self.assertEqual((dto.width, dto.height), (1200, 1600))

    async def test_historical_revision_without_image_provenance_uses_text_fallback(self):
        service, _, page, revision = self.make_content(historical=True)
        with patch(
            "app.services.reading_content_service.create_signed_image_url",
            return_value="https://example.com/unexpected-current.png",
        ) as sign:
            dto = await service._build_page_dto(page, revision)

        sign.assert_not_called()
        self.assertIsNone(dto.image_url)
        self.assertEqual(dto.text, "Bé đọc")
        self.assertEqual(len(dto.words), 1)

    async def test_incomplete_source_snapshot_never_borrows_current_dimensions(self):
        for invalid_width in (None, 0, -1, True, "600"):
            with self.subTest(width=invalid_width):
                service, _, page, revision = self.make_content(
                    historical=True,
                    metadata={
                        "source_image_path": "books/book/pages/page/original.png",
                        "source_image_width": invalid_width,
                        "source_image_height": 800,
                    },
                )
                with patch(
                    "app.services.reading_content_service.create_signed_image_url",
                    return_value="https://example.com/unexpected-current.png",
                ) as sign:
                    dto = await service._build_page_dto(page, revision)

                sign.assert_not_called()
                self.assertIsNone(dto.image_url)
                self.assertEqual(dto.text, "Bé đọc")

    async def test_storage_failure_preserves_revision_text_and_words(self):
        service, _, page, revision = self.make_content(
            historical=True,
            metadata={
                "source_image_path": "books/book/pages/page/original.png",
                "source_image_width": 600,
                "source_image_height": 800,
            },
        )
        with patch(
            "app.services.reading_content_service.create_signed_image_url",
            side_effect=RuntimeError("Storage unavailable"),
        ):
            dto = await service._build_page_dto(page, revision)

        self.assertIsNone(dto.image_url)
        self.assertEqual((dto.width, dto.height), (600, 800))
        self.assertEqual(dto.text, "Bé đọc")
        self.assertEqual(len(dto.words), 1)
