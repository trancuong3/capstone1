"""Draft lifecycle, bbox validation and transaction safety regressions."""

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
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

from app.schemas.admin_ocr import AdminOcrWordInput
from app.services.admin_ocr_service import AdminOcrService


ACTOR = UUID("11111111-1111-4111-8111-111111111111")
PAGE_ID = UUID("33333333-3333-4333-8333-333333333333")
R1_ID = UUID("44444444-4444-4444-8444-444444444441")
R2_ID = UUID("44444444-4444-4444-8444-444444444442")
CREATED_AT = datetime(2026, 11, 6, tzinfo=timezone.utc)


def _source(revision_id=R1_ID, number="1", text="Ngày xưa có bé."):
    return SimpleNamespace(
        Id=revision_id,
        PageId=PAGE_ID,
        RevisionNo=number,
        VerificationStatus="VERIFIED",
        VerifiedText=text,
        DraftText=None,
        ContentHash="source-hash",
        ProcessingMeta={"source": "ocr"},
        CreatedAt=CREATED_AT,
        VerifiedAt=CREATED_AT,
        VerifiedBy=ACTOR,
    )


def _source_words():
    return [
        SimpleNamespace(
            WordIndex=index,
            LineIndex=0 if index < 2 else 1,
            Text=text,
            NormalizedText=normalized,
            BoundingBox=box,
            OCRConfidence=confidence,
        )
        for index, (text, normalized, box, confidence) in enumerate(
            (
                ("Ngày", "ngày", [0.1, 0.1, 0.2, 0.05], 0.91),
                ("xưa", "xưa", {"x": 0.32, "y": 0.1, "width": 0.2, "height": 0.05}, 0.82),
                ("có", "có", (0.1, 0.2, 0.1, 0.04), None),
                ("bé.", "bé", [0.22, 0.2, 0.14, 0.04], 0.7),
            )
        )
    ]


def _make_service(*, lifecycle="ACTIVE", current=R1_ID, words=None):
    db = MagicMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    db.rollback = AsyncMock()
    service = AdminOcrService(db)
    page = SimpleNamespace(
        Id=PAGE_ID,
        LifecycleStatus=lifecycle,
        CurrentVerifiedRevisionId=current,
    )
    source = _source()
    service.require_admin = AsyncMock()
    service.repo.page = AsyncMock(return_value=page)
    service.repo.revision = AsyncMock(return_value=source)
    source_words = _source_words() if words is None else words
    service.repo.words = AsyncMock(return_value=source_words)
    service.repo.revisions = AsyncMock(return_value=[source])
    service.repo.next_revision_number = AsyncMock(return_value=2)
    service.repo.stage_revision_bundle = MagicMock()
    service.revision_detail = AsyncMock(return_value=SimpleNamespace(page_revision_id=R2_ID))
    return service, db, page, source, source_words


def _bbox_word(box):
    return {
        "word_index": 0,
        "line_index": 0,
        "text": "Ngày",
        "normalized_text": "ngày",
        "bbox": box,
        "ocr_confidence": 0.9,
    }


class AdminOcrBoundingBoxContractTests(unittest.TestCase):
    def test_accepts_list_tuple_and_supported_dictionary(self):
        for box in (
            [0.1, 0.2, 0.3, 0.4],
            (0, 0, 1, 1),
            {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4},
        ):
            with self.subTest(box=box):
                word = AdminOcrWordInput(**_bbox_word(box))
                self.assertEqual(len(word.bbox), 4)
                self.assertEqual(word.bbox[2:], (0.3, 0.4) if box != (0, 0, 1, 1) else (1.0, 1.0))

    def test_rejects_wrong_shape_missing_values_and_string_coordinates(self):
        invalid = (
            None,
            [0.1, 0.2, 0.3],
            [0.1, 0.2, 0.3, 0.4, 0.5],
            {"x": 0.1, "y": 0.2, "width": 0.3},
            ["0.1", 0.2, 0.3, 0.4],
        )
        for box in invalid:
            with self.subTest(box=box), self.assertRaises(ValidationError):
                AdminOcrWordInput(**_bbox_word(box))

    def test_rejects_non_finite_out_of_range_and_non_positive_boxes(self):
        invalid = (
            [float("nan"), 0.1, 0.2, 0.2],
            [0.1, float("inf"), 0.2, 0.2],
            [0.1, float("-inf"), 0.2, 0.2],
            [-0.1, 0.1, 0.2, 0.2],
            [0.1, 1.1, 0.2, 0.2],
            [0.1, 0.1, 0, 0.2],
            [0.1, 0.1, 0.2, 0],
            [0.9, 0.1, 0.2, 0.2],
            [0.1, 0.9, 0.2, 0.2],
            [10**400, 0.1, 0.2, 0.2],
        )
        for box in invalid:
            with self.subTest(box=box), self.assertRaises(ValidationError):
                AdminOcrWordInput(**_bbox_word(box))

    def test_rejects_boolean_coordinate(self):
        with self.assertRaises(ValidationError):
            AdminOcrWordInput(**_bbox_word([True, 0.1, 0.2, 0.2]))


class AdminOcrDraftLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_create_draft_copies_verified_content_and_preserves_pointer(self):
        service, db, page, source, source_words = _make_service()
        result = await service.create_edit_draft(ACTOR, PAGE_ID, R1_ID)

        self.assertEqual(result.page_revision_id, R2_ID)
        revision, copied_words = service.repo.stage_revision_bundle.call_args.args
        self.assertEqual(revision.PageId, PAGE_ID)
        self.assertEqual(revision.RevisionNo, "2")
        self.assertEqual(revision.VerificationStatus, "NEEDS_REVIEW")
        self.assertEqual(revision.DraftText, source.VerifiedText)
        self.assertIsNone(revision.VerifiedText)
        self.assertEqual(revision.ProcessingMeta["source_revision_id"], str(R1_ID))
        self.assertEqual(
            [word["word_index"] for word in copied_words],
            [word.WordIndex for word in source_words],
        )
        self.assertEqual(
            [word["line_index"] for word in copied_words],
            [word.LineIndex for word in source_words],
        )
        self.assertEqual(
            [word["ocr_confidence"] for word in copied_words],
            [word.OCRConfidence for word in source_words],
        )
        self.assertEqual(
            [word["bbox"] for word in copied_words],
            [
                [0.1, 0.1, 0.2, 0.05],
                [0.32, 0.1, 0.2, 0.05],
                [0.1, 0.2, 0.1, 0.04],
                [0.22, 0.2, 0.14, 0.04],
            ],
        )
        self.assertEqual(page.CurrentVerifiedRevisionId, R1_ID)
        self.assertEqual(source.VerifiedText, "Ngày xưa có bé.")
        db.commit.assert_awaited_once()
        db.rollback.assert_not_awaited()

    async def test_requested_source_must_be_current_verified_revision(self):
        service, db, _page, _source_row, _words = _make_service()

        with self.assertRaises(HTTPException) as caught:
            await service.create_edit_draft(ACTOR, PAGE_ID, R2_ID)

        self.assertEqual(caught.exception.status_code, 409)
        service.repo.revision.assert_not_awaited()
        service.repo.stage_revision_bundle.assert_not_called()
        db.commit.assert_not_awaited()

    async def test_existing_pending_revision_prevents_duplicate_concurrent_draft(self):
        service, db, _page, source, _words = _make_service()
        pending = SimpleNamespace(
            Id=R2_ID,
            VerificationStatus="NEEDS_REVIEW",
        )
        service.repo.revisions = AsyncMock(return_value=[pending, source])

        with self.assertRaises(HTTPException) as caught:
            await service.create_edit_draft(ACTOR, PAGE_ID, R1_ID)

        self.assertEqual(caught.exception.status_code, 409)
        service.repo.revision.assert_not_awaited()
        service.repo.stage_revision_bundle.assert_not_called()
        db.commit.assert_not_awaited()

    async def test_missing_page_retired_page_and_no_verified_revision_fail_safely(self):
        cases = (
            (_make_service(lifecycle="RETIRED"), "retired", 409),
            (_make_service(current=None), "missing", 409),
        )
        for fixture, label, status in cases:
            service, db, _page, _source_row, _words = fixture
            with self.subTest(label=label):
                with self.assertRaises(HTTPException) as caught:
                    await service.create_edit_draft(ACTOR, PAGE_ID, R1_ID)
                self.assertEqual(caught.exception.status_code, status)
                service.repo.stage_revision_bundle.assert_not_called()
                db.commit.assert_not_awaited()

        service, db, _page, _source_row, _words = _make_service()
        service.repo.page = AsyncMock(return_value=None)
        with self.assertRaises(HTTPException) as caught:
            await service.create_edit_draft(ACTOR, PAGE_ID, R1_ID)
        self.assertEqual(caught.exception.status_code, 404)
        db.commit.assert_not_awaited()

    async def test_source_status_text_words_order_and_bbox_are_checked(self):
        invalid_cases = (
            ("wrong status", lambda source, _words: setattr(source, "VerificationStatus", "NEEDS_REVIEW")),
            ("empty text", lambda source, _words: setattr(source, "VerifiedText", "  ")),
            ("missing words", lambda _source, words: words.clear()),
            ("invalid order", lambda _source, words: setattr(words[0], "WordIndex", 2)),
            ("invalid bbox", lambda _source, words: setattr(words[0], "BoundingBox", [0, 0, float("nan"), 0.2])),
            ("invalid confidence", lambda _source, words: setattr(words[0], "OCRConfidence", float("inf"))),
        )
        for label, mutate in invalid_cases:
            with self.subTest(label=label):
                service, db, _page, source, words = _make_service()
                mutate(source, words)
                with self.assertRaises(HTTPException) as caught:
                    await service.create_edit_draft(ACTOR, PAGE_ID, R1_ID)
                self.assertEqual(caught.exception.status_code, 409)
                service.repo.stage_revision_bundle.assert_not_called()
                db.commit.assert_not_awaited()

    async def test_admin_authorization_runs_before_page_lookup(self):
        service, db, _page, _source_row, _words = _make_service()
        service.require_admin.side_effect = HTTPException(status_code=403)

        with self.assertRaises(HTTPException) as caught:
            await service.create_edit_draft(ACTOR, PAGE_ID, R1_ID)

        self.assertEqual(caught.exception.status_code, 403)
        service.repo.page.assert_not_awaited()
        db.commit.assert_not_awaited()

    async def test_staging_commit_and_integrity_failures_roll_back_bundle(self):
        for label, stage_error, commit_error in (
            ("stage", RuntimeError("word insertion failed"), None),
            ("commit", None, RuntimeError("database unavailable")),
            ("integrity", None, IntegrityError("insert", {}, RuntimeError("conflict"))),
        ):
            with self.subTest(label=label):
                service, db, _page, _source_row, _words = _make_service()
                if stage_error:
                    service.repo.stage_revision_bundle.side_effect = stage_error
                if commit_error:
                    db.commit.side_effect = commit_error
                with self.assertRaises(HTTPException if label == "integrity" else RuntimeError):
                    await service.create_edit_draft(ACTOR, PAGE_ID, R1_ID)
                db.rollback.assert_awaited_once()
                if label == "stage":
                    db.commit.assert_not_awaited()
                else:
                    db.commit.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
