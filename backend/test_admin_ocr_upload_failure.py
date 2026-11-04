"""Admin OCR upload/replacement transaction-boundary tests with mocked Storage and DB."""

from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test"
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")

from fastapi import HTTPException

from app.services.admin_ocr_service import AdminOcrService
from app.services.storage_service import StorageUploadFailure

ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
BOOK_ID = UUID("22222222-2222-4222-8222-222222222222")
PAGE_ID = UUID("33333333-3333-4333-8333-333333333333")
REVISION_ID = UUID("44444444-4444-4444-8444-444444444444")


def make_page(**overrides):
    values = {
        "Id": PAGE_ID,
        "BookId": BOOK_ID,
        "PageNumber": 1,
        "LifecycleStatus": "PROCESSING",
        "ImagePath": "books/source/candidate.png",
        "Width": 100,
        "Height": 100,
        "CurrentVerifiedRevisionId": None,
        "ProcessingMeta": {"storage": "supabase", "ocr_state": "PROCESSING"},
    }
    return SimpleNamespace(**(values | overrides))


def ocr_result():
    return {
        "text": "Chú mèo",
        "words": [
            {
                "word_index": 0,
                "line_index": 0,
                "text": "Chú",
                "normalized_text": "chú",
                "bbox": [0.1, 0.2, 0.1, 0.05],
                "ocr_confidence": 0.9,
            }
        ],
        "metadata": {"engine": "tesseract", "language": "vie"},
    }


class AdminOcrUploadFailureTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self, *, existing_page=None):
        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.refresh = AsyncMock()
        db.flush = AsyncMock()

        service = AdminOcrService(db)
        service.repo = MagicMock()
        service.repo.role = AsyncMock(return_value="admin")
        service.repo.book = AsyncMock(
            return_value=SimpleNamespace(Id=BOOK_ID, LifecycleStatus="ACTIVE")
        )
        service.repo.active_pages_for_renumber = AsyncMock(return_value=[])
        service.repo.next_active_page_number = AsyncMock(return_value=1)
        service.repo.flush = AsyncMock()
        service.repo.stage_page_reservation = MagicMock()
        service.repo.stage_page_revision_bundle = MagicMock()
        service.repo.stage_revision_bundle = MagicMock()
        service.repo.delete_page = AsyncMock()
        service.repo.set_page_lifecycle_status = MagicMock(
            side_effect=lambda page, state: setattr(page, "LifecycleStatus", state)
        )
        service.repo.revisions = AsyncMock(return_value=[])
        service.repo.next_revision_number = AsyncMock(return_value=3)
        service.repo.revision = AsyncMock(
            return_value=SimpleNamespace(ProcessingMeta={})
        )
        service.repo.words = AsyncMock(return_value=[])

        reserved_pages = []
        service._test_reserved_pages = reserved_pages
        service.repo.stage_page_reservation.side_effect = reserved_pages.append

        async def find_page(page_id, *, lock=False):
            if existing_page is not None and existing_page.Id == page_id:
                return existing_page
            return next((page for page in reserved_pages if page.Id == page_id), None)

        service.repo.page = AsyncMock(side_effect=find_page)
        service._read_validate_image = AsyncMock(
            return_value=(b"valid-image-data", "image/png", "png", 100, 100)
        )
        service.revision_detail = AsyncMock(return_value=object())
        return service

    async def test_storage_configuration_failure_removes_reservation_without_cleanup(self):
        service = self.make_service()
        missing_bucket = HTTPException(
            status_code=503,
            detail="Supabase Storage is not configured",
        )
        cleanup = AsyncMock()
        with (
            patch("app.services.admin_ocr_service.upload_object", side_effect=missing_bucket),
            patch.object(service, "_cleanup_uploaded_object", cleanup),
            self.assertLogs("app.services.admin_ocr_service", level="ERROR") as captured,
        ):
            with self.assertRaises(HTTPException) as raised:
                await service.upload_page(ACTOR_ID, BOOK_ID, MagicMock())

        self.assertEqual(raised.exception.status_code, 503)
        cleanup.assert_not_awaited()
        service.repo.delete_page.assert_awaited_once()
        self.assertEqual(service._test_reserved_pages, [])
        self.assertTrue(any('"stage":"storage_upload"' in line for line in captured.output))
        self.assertTrue(any(f'"book_id":"{BOOK_ID}"' in line for line in captured.output))
        service.repo.stage_page_reservation.assert_called_once()
        service.repo.stage_page_revision_bundle.assert_not_called()

    async def test_ambiguous_storage_failure_cleans_object_after_deleting_placeholder(self):
        service = self.make_service()
        ambiguous = StorageUploadFailure(
            "Could not save the image to Supabase Storage",
            cleanup_may_be_needed=True,
        )
        cleanup = AsyncMock()
        with (
            patch("app.services.admin_ocr_service.upload_object", side_effect=ambiguous),
            patch.object(service, "_cleanup_uploaded_object", cleanup),
            self.assertLogs("app.services.admin_ocr_service", level="ERROR"),
        ):
            with self.assertRaises(StorageUploadFailure):
                await service.upload_page(ACTOR_ID, BOOK_ID, MagicMock())

        service.repo.delete_page.assert_awaited_once()
        cleanup.assert_awaited_once()
        self.assertTrue(cleanup.await_args.kwargs["object_may_exist"])
        self.assertEqual(cleanup.await_args.kwargs["book_id"], BOOK_ID)
        self.assertEqual(service._test_reserved_pages, [])

    async def test_database_finalize_failure_rolls_back_deletes_placeholder_and_cleans_object(self):
        service = self.make_service()
        # Reservation succeeds, final activation commit fails, placeholder cleanup commits.
        service.db.commit = AsyncMock(
            side_effect=[None, RuntimeError("private database details"), None]
        )
        cleanup = AsyncMock()
        with (
            patch("app.services.admin_ocr_service.upload_object"),
            patch("app.services.admin_ocr_service.extract_text_and_boxes", return_value=ocr_result()),
            patch.object(service, "_cleanup_uploaded_object", cleanup),
            self.assertLogs("app.services.admin_ocr_service", level="ERROR"),
        ):
            with self.assertRaisesRegex(RuntimeError, "private database details"):
                await service.upload_page(ACTOR_ID, BOOK_ID, MagicMock())

        service.db.rollback.assert_awaited()
        self.assertGreaterEqual(service.db.commit.await_count, 3)
        service.repo.delete_page.assert_awaited_once()
        cleanup.assert_awaited_once()
        self.assertEqual(service._test_reserved_pages, [])

    async def test_upload_commits_hidden_reservation_before_storage_and_ocr(self):
        service = self.make_service()
        expected_response = object()
        service.revision_detail = AsyncMock(return_value=expected_response)

        def upload_side_effect(*_args, **_kwargs):
            self.assertEqual(service.db.commit.await_count, 1)
            self.assertEqual(service._test_reserved_pages[0].LifecycleStatus, "PROCESSING")

        def ocr_side_effect(_data):
            self.assertEqual(service.db.commit.await_count, 1)
            self.assertEqual(service._test_reserved_pages[0].LifecycleStatus, "PROCESSING")
            return ocr_result()

        with (
            patch("app.services.admin_ocr_service.upload_object", side_effect=upload_side_effect) as uploaded,
            patch("app.services.admin_ocr_service.extract_text_and_boxes", side_effect=ocr_side_effect),
        ):
            response = await service.upload_page(ACTOR_ID, BOOK_ID, MagicMock())

        self.assertIs(response, expected_response)
        uploaded.assert_called_once()
        service.db.commit.assert_awaited_once()  # The second await is the final commit in the actual call.
        self.assertEqual(service.db.commit.await_count, 2)
        service.repo.stage_page_reservation.assert_called_once()
        page = service._test_reserved_pages[0]
        self.assertEqual(page.LifecycleStatus, "ACTIVE")
        self.assertEqual(page.ProcessingMeta, {"storage": "supabase"})
        service.repo.stage_page_revision_bundle.assert_called_once()
        staged_page, revision, words = service.repo.stage_page_revision_bundle.call_args.args
        self.assertIs(staged_page, page)
        self.assertEqual(revision.VerificationStatus, "NEEDS_REVIEW")
        self.assertEqual(revision.DraftText, "Chú mèo")
        self.assertEqual(words[0]["bbox"], [0.1, 0.2, 0.1, 0.05])
        self.assertEqual(words[0]["ocr_confidence"], 0.9)
        service.repo.delete_page.assert_not_awaited()

    async def test_replacement_keeps_live_source_and_releases_db_before_storage(self):
        page = make_page(
            LifecycleStatus="ACTIVE",
            ImagePath="books/source/old.png",
            Width=800,
            Height=1000,
            CurrentVerifiedRevisionId=REVISION_ID,
            ProcessingMeta={},
        )
        service = self.make_service(existing_page=page)
        current_verified = SimpleNamespace(ProcessingMeta={})
        latest_revision = SimpleNamespace(Id=REVISION_ID, ProcessingMeta={})
        service.repo.revisions = AsyncMock(return_value=[latest_revision])
        service.repo.revision = AsyncMock(return_value=current_verified)
        service.repo.next_revision_number = AsyncMock(return_value=3)
        expected_response = object()
        service.revision_detail = AsyncMock(return_value=expected_response)
        service._read_validate_image = AsyncMock(
            return_value=(b"replacement-image", "image/png", "png", 1200, 1600)
        )

        def upload_side_effect(*_args, **_kwargs):
            # Admin role/page probe and locked snapshot transactions are both closed.
            self.assertEqual(service.db.rollback.await_count, 2)

        with (
            patch("app.services.admin_ocr_service.upload_object", side_effect=upload_side_effect) as uploaded,
            patch("app.services.admin_ocr_service.extract_text_and_boxes", return_value=ocr_result()),
        ):
            response = await service.replace_page_image(ACTOR_ID, PAGE_ID, MagicMock())

        self.assertIs(response, expected_response)
        uploaded.assert_called_once()
        service.db.commit.assert_awaited_once()
        self.assertGreaterEqual(service.db.rollback.await_count, 2)
        self.assertEqual(page.ImagePath, "books/source/old.png")
        self.assertEqual((page.Width, page.Height), (800, 1000))
        self.assertEqual(
            current_verified.ProcessingMeta,
            {
                "source_image_path": "books/source/old.png",
                "source_image_width": 800,
                "source_image_height": 1000,
            },
        )
        revision, words = service.repo.stage_revision_bundle.call_args.args
        self.assertEqual(revision.PageId, PAGE_ID)
        self.assertEqual(revision.RevisionNo, "3")
        self.assertEqual(revision.VerificationStatus, "NEEDS_REVIEW")
        self.assertEqual(revision.DraftText, "Chú mèo")
        self.assertEqual(revision.ProcessingMeta["source_image_path"], uploaded.call_args.args[0])
        self.assertEqual(revision.ProcessingMeta["source_image_width"], 1200)
        self.assertEqual(revision.ProcessingMeta["source_image_height"], 1600)
        self.assertEqual(words[0]["bbox"], [0.1, 0.2, 0.1, 0.05])
        service.repo.set_page_image_source.assert_not_called()

    async def test_replacement_snapshot_conflict_cleans_candidate_image(self):
        page = make_page(
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=REVISION_ID,
            ImagePath="books/source/old.png",
            Width=800,
            Height=1000,
        )
        service = self.make_service(existing_page=page)
        latest_revision = SimpleNamespace(Id=REVISION_ID, ProcessingMeta={})
        service.repo.revisions = AsyncMock(return_value=[latest_revision, latest_revision])
        # First revision snapshot is captured; later the page's verified revision changes.
        current_page = make_page(
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=UUID("55555555-5555-4555-8555-555555555555"),
            ImagePath=page.ImagePath,
            Width=page.Width,
            Height=page.Height,
        )
        service.repo.page = AsyncMock(side_effect=[page, page, current_page])
        cleanup = AsyncMock()
        with (
            patch("app.services.admin_ocr_service.upload_object"),
            patch("app.services.admin_ocr_service.extract_text_and_boxes", return_value=ocr_result()),
            patch.object(service, "_cleanup_uploaded_object", cleanup),
        ):
            with self.assertRaises(HTTPException) as raised:
                await service.replace_page_image(ACTOR_ID, PAGE_ID, MagicMock())

        self.assertEqual(raised.exception.status_code, 409)
        service.db.commit.assert_not_awaited()
        cleanup.assert_awaited_once()
        self.assertTrue(cleanup.await_args.kwargs["object_may_exist"])

    async def test_replacement_response_validation_failure_rolls_back_and_cleans_candidate(self):
        page = make_page(
            LifecycleStatus="ACTIVE",
            ImagePath="books/source/old.png",
            Width=800,
            Height=1000,
            CurrentVerifiedRevisionId=REVISION_ID,
        )
        service = self.make_service(existing_page=page)
        latest_revision = SimpleNamespace(Id=REVISION_ID, ProcessingMeta={})
        service.repo.revisions = AsyncMock(return_value=[latest_revision])
        service.repo.revision = AsyncMock(return_value=SimpleNamespace(ProcessingMeta={}))
        service.repo.next_revision_number = AsyncMock(return_value=3)
        service.revision_detail = AsyncMock(
            side_effect=HTTPException(status_code=409, detail="Invalid response contract")
        )
        cleanup = AsyncMock()
        with (
            patch("app.services.admin_ocr_service.upload_object"),
            patch("app.services.admin_ocr_service.extract_text_and_boxes", return_value=ocr_result()),
            patch.object(service, "_cleanup_uploaded_object", cleanup),
        ):
            with self.assertRaises(HTTPException):
                await service.replace_page_image(ACTOR_ID, PAGE_ID, MagicMock())

        service.db.commit.assert_not_awaited()
        service.db.rollback.assert_awaited()
        cleanup.assert_awaited_once()
        self.assertTrue(cleanup.await_args.kwargs["object_may_exist"])
        self.assertEqual(page.ImagePath, "books/source/old.png")
        self.assertEqual(page.CurrentVerifiedRevisionId, REVISION_ID)

    async def test_invalid_legacy_ocr_confidence_normalizes_to_null(self):
        self.assertIsNone(AdminOcrService._normalize_confidence(None))
        self.assertIsNone(AdminOcrService._normalize_confidence(-0.1))
        self.assertIsNone(AdminOcrService._normalize_confidence(1.1))
        self.assertIsNone(AdminOcrService._normalize_confidence(float("nan")))
        self.assertIsNone(AdminOcrService._normalize_confidence("invalid"))
        self.assertEqual(AdminOcrService._normalize_confidence(0.91), 0.91)


if __name__ == "__main__":
    unittest.main()
