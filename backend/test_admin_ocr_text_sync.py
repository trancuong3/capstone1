"""Regression tests for Admin OCR draft text/word consistency and transaction safety."""
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException

from app.schemas.admin_ocr import AdminOcrDraftRequest
from app.services.admin_ocr_service import AdminOcrService


ACTOR = UUID("11111111-1111-4111-8111-111111111111")
PAGE = UUID("33333333-3333-4333-8333-333333333333")
REVISION = UUID("44444444-4444-4444-8444-444444444444")
CREATED_AT = datetime(2026, 10, 16, tzinfo=timezone.utc)


def make_page():
    return SimpleNamespace(
        Id=PAGE,
        LifecycleStatus="ACTIVE",
        CurrentVerifiedRevisionId=None,
    )


def make_revision():
    return SimpleNamespace(
        Id=REVISION,
        PageId=PAGE,
        RevisionNo="1",
        VerificationStatus="NEEDS_REVIEW",
        DraftText="Tôi đi học.",
        VerifiedText=None,
        ContentHash="old-hash",
        ProcessingMeta={},
        CreatedAt=CREATED_AT,
        VerifiedAt=None,
        VerifiedBy=None,
    )


def make_payload(draft_text="Ta đi học."):
    return AdminOcrDraftRequest(
        draft_text=draft_text,
        words=[
            {
                "word_index": 0,
                "line_index": 0,
                "text": "Ta",
                "normalized_text": "ta",
                "bbox": [0.1, 0.2, 0.15, 0.04],
                "ocr_confidence": 0.71,
            },
            {
                "word_index": 1,
                "line_index": 0,
                "text": "đi",
                "normalized_text": "đi",
                "bbox": [0.28, 0.2, 0.1, 0.04],
                "ocr_confidence": 0.82,
            },
            {
                "word_index": 2,
                "line_index": 0,
                "text": "học.",
                "normalized_text": "học",
                "bbox": [0.4, 0.2, 0.2, 0.04],
                "ocr_confidence": 0.91,
            },
        ],
    )


def make_service():
    db = MagicMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    db.rollback = AsyncMock()
    service = AdminOcrService(db)
    page = make_page()
    revision = make_revision()
    service.repo.role = AsyncMock(return_value="admin")
    service.repo.page = AsyncMock(return_value=page)
    service.repo.revision = AsyncMock(return_value=revision)
    service.repo.sync_words = AsyncMock()
    service.repo.words = AsyncMock(return_value=[])
    return service, db, page, revision


class AdminOcrDraftTextSyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_saves_one_to_one_text_correction_with_existing_bbox(self):
        service, db, _page, revision = make_service()

        result = await service.save_draft(ACTOR, PAGE, REVISION, make_payload())

        self.assertEqual(result.draft_text, "Ta đi học.")
        self.assertEqual(revision.DraftText, "Ta đi học.")
        self.assertEqual(len(service.repo.sync_words.await_args.args[1]), 3)
        saved_words = service.repo.sync_words.await_args.args[1]
        self.assertEqual([word["text"] for word in saved_words], ["Ta", "đi", "học."])
        self.assertEqual(
            [word["bbox"] for word in saved_words],
            [
                [0.1, 0.2, 0.15, 0.04],
                [0.28, 0.2, 0.1, 0.04],
                [0.4, 0.2, 0.2, 0.04],
            ],
        )
        self.assertEqual([word["ocr_confidence"] for word in saved_words], [0.71, 0.82, 0.91])
        db.commit.assert_awaited_once()
        db.rollback.assert_not_awaited()

    async def test_rejects_draft_when_text_and_word_tokens_differ(self):
        service, db, _page, revision = make_service()
        payload = make_payload("Ta rất đi học.")

        with self.assertRaises(HTTPException) as caught:
            await service.save_draft(ACTOR, PAGE, REVISION, payload)

        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("ordered word list", caught.exception.detail)
        service.repo.sync_words.assert_not_awaited()
        db.commit.assert_not_awaited()
        self.assertEqual(revision.DraftText, "Tôi đi học.")

    async def test_rolls_back_if_word_synchronization_fails(self):
        service, db, _page, _revision = make_service()
        service.repo.sync_words.side_effect = RuntimeError("simulated persistence failure")

        with self.assertRaisesRegex(RuntimeError, "simulated persistence failure"):
            await service.save_draft(ACTOR, PAGE, REVISION, make_payload())

        db.commit.assert_not_awaited()
        db.rollback.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
