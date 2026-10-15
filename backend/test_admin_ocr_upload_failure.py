"""Upload failure behavior around Storage configuration; no live database or Storage calls."""
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException
from types import SimpleNamespace

from app.services.admin_ocr_service import AdminOcrService
from app.services.storage_service import StorageUploadFailure

ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
BOOK_ID = UUID("22222222-2222-4222-8222-222222222222")


class AdminOcrUploadFailureTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self) -> AdminOcrService:
        service = AdminOcrService(MagicMock())
        service.repo = MagicMock()
        service.repo.role = AsyncMock(return_value="admin")
        service.repo.book = AsyncMock(return_value=SimpleNamespace(LifecycleStatus="ACTIVE"))
        service.repo.page_number_exists = AsyncMock(return_value=False)
        service._read_validate_image = AsyncMock(
            return_value=(b"valid-image-data", "image/png", "png", 100, 100)
        )
        return service

    async def test_missing_storage_configuration_does_not_attempt_cleanup(self):
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
                await service.upload_page(ACTOR_ID, BOOK_ID, 1, MagicMock())

        self.assertEqual(raised.exception.status_code, 503)
        cleanup.assert_not_awaited()
        self.assertTrue(any('"stage":"storage_upload"' in line for line in captured.output))
        self.assertTrue(any('"book_id":"' + str(BOOK_ID) + '"' in line for line in captured.output))
        service.db.add_all.assert_not_called()

    async def test_ambiguous_storage_upload_failure_attempts_best_effort_cleanup(self):
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
                await service.upload_page(ACTOR_ID, BOOK_ID, 1, MagicMock())

        cleanup.assert_awaited_once()
        self.assertTrue(cleanup.await_args.kwargs["object_may_exist"])
        self.assertEqual(cleanup.await_args.kwargs["book_id"], BOOK_ID)
        service.db.add_all.assert_not_called()

    async def test_database_commit_failure_rolls_back_and_attempts_cleanup(self):
        service = self.make_service()
        service.db.commit = AsyncMock(side_effect=RuntimeError("private database details"))
        service.db.refresh = AsyncMock()
        service.db.rollback = AsyncMock()
        service.db.add_all = MagicMock()
        service.db.add = MagicMock()
        cleanup = AsyncMock()
        ocr_result = {
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
        with (
            patch("app.services.admin_ocr_service.upload_object"),
            patch("app.services.admin_ocr_service.extract_text_and_boxes", return_value=ocr_result),
            patch.object(service, "_cleanup_uploaded_object", cleanup),
            self.assertLogs("app.services.admin_ocr_service", level="ERROR"),
        ):
            with self.assertRaisesRegex(RuntimeError, "private database details"):
                await service.upload_page(ACTOR_ID, BOOK_ID, 1, MagicMock())

        service.db.rollback.assert_awaited_once()
        cleanup.assert_awaited_once()
        self.assertTrue(cleanup.await_args.kwargs["object_may_exist"])
        self.assertEqual(cleanup.await_args.kwargs["book_id"], BOOK_ID)

    async def test_invalid_legacy_ocr_confidence_normalizes_to_null(self):
        from app.services.admin_ocr_service import AdminOcrService

        self.assertIsNone(AdminOcrService._normalize_confidence(None))
        self.assertIsNone(AdminOcrService._normalize_confidence(-0.1))
        self.assertIsNone(AdminOcrService._normalize_confidence(1.1))
        self.assertIsNone(AdminOcrService._normalize_confidence(float("nan")))
        self.assertIsNone(AdminOcrService._normalize_confidence("invalid"))
        self.assertEqual(AdminOcrService._normalize_confidence(0.91), 0.91)

    async def test_success_creates_unverified_revision_and_stores_real_ocr_boxes(self):
        service = self.make_service()
        service.db.commit = AsyncMock()
        service.db.refresh = AsyncMock()
        service.db.rollback = AsyncMock()
        service.db.add_all = MagicMock()
        service.db.add = MagicMock()
        service.repo.words = AsyncMock(return_value=[])
        expected_response = object()
        service.revision_detail = AsyncMock(return_value=expected_response)
        ocr_result = {
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
        uploaded = MagicMock()
        with (
            patch("app.services.admin_ocr_service.upload_object", uploaded),
            patch("app.services.admin_ocr_service.extract_text_and_boxes", return_value=ocr_result),
        ):
            response = await service.upload_page(ACTOR_ID, BOOK_ID, 1, MagicMock())

        self.assertIs(response, expected_response)
        uploaded.assert_called_once()
        service.db.commit.assert_awaited_once()
        page, revision, word_data = service.repo.stage_page_revision_bundle.call_args.args
        self.assertEqual(page.ImagePath.split("/")[-1].split(".")[-1], "png")
        self.assertEqual(revision.VerificationStatus, "NEEDS_REVIEW")
        self.assertEqual(revision.DraftText, "Chú mèo")
        self.assertEqual(word_data[0]["bbox"], [0.1, 0.2, 0.1, 0.05])
        self.assertEqual(word_data[0]["ocr_confidence"], 0.9)
        service.db.add_all.assert_not_called()
        service.db.add.assert_not_called()


if __name__ == "__main__":
    unittest.main()
