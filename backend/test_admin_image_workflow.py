"""Image/revision association and upload replay without providers or a database."""
import hashlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

from fastapi import HTTPException

from app.services.book_service import AdminCatalogService
from test_admin_data import PAGE, REVISION, catalog_repo, revision_row
import test_admin_ocr_upload_failure as upload_fixture
from test_admin_ocr_upload_failure import ACTOR_ID, BOOK_ID, PAGE_ID, REVISION_ID, make_page

UPLOAD_ID = UUID("70000000-0000-4000-8000-000000000001")
DIGEST = hashlib.sha256(b"valid-image-data").hexdigest()


class AdminImageWorkflowTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self, **kwargs):
        return upload_fixture.AdminOcrUploadFailureTests().make_service(**kwargs)

    async def test_original_upload_replay_returns_saved_revision_without_ocr_or_storage(self):
        service = self.make_service()
        existing = make_page(LifecycleStatus="ACTIVE", ProcessingMeta={
            "upload_id": str(UPLOAD_ID), "image_sha256": DIGEST, "upload_revision_id": str(REVISION_ID),
        })
        from unittest.mock import AsyncMock
        service.repo.page_for_upload = AsyncMock(return_value=existing)
        with patch("app.services.admin_ocr_service.upload_object") as upload, patch("app.services.admin_ocr_service.extract_text_and_boxes") as ocr:
            result = await service.upload_page(ACTOR_ID, BOOK_ID, object(), upload_id=UPLOAD_ID)
        self.assertIs(result, service.revision_detail.return_value)
        service.repo.stage_page_reservation.assert_not_called()
        service.db.commit.assert_not_awaited()
        upload.assert_not_called()
        ocr.assert_not_called()
        service.repo.page_for_upload.assert_awaited_once_with(BOOK_ID, UPLOAD_ID)

    async def test_upload_identity_cannot_be_reused_for_different_bytes(self):
        service = self.make_service()
        from unittest.mock import AsyncMock
        service.repo.page_for_upload = AsyncMock(return_value=make_page(
            LifecycleStatus="ACTIVE", ProcessingMeta={"image_sha256": "different"}))
        with self.assertRaises(HTTPException) as caught:
            await service.upload_page(ACTOR_ID, BOOK_ID, object(), upload_id=UPLOAD_ID)
        self.assertEqual(caught.exception.status_code, 409)
        service.repo.stage_page_reservation.assert_not_called()

    async def test_pending_upload_is_not_started_again_or_deleted_by_another_request(self):
        service = self.make_service()
        from unittest.mock import AsyncMock
        service.repo.page_for_upload = AsyncMock(return_value=make_page(ProcessingMeta={"image_sha256": DIGEST}))
        with self.assertRaises(HTTPException) as caught:
            await service.upload_page(ACTOR_ID, BOOK_ID, object(), upload_id=UPLOAD_ID)
        self.assertEqual(caught.exception.status_code, 409)
        service.repo.stage_page_reservation.assert_not_called()
        service.repo.delete_page.assert_not_awaited()

    async def test_replacement_replay_does_not_create_another_revision(self):
        page = make_page(LifecycleStatus="ACTIVE")
        service = self.make_service(existing_page=page)
        revision = SimpleNamespace(Id=REVISION_ID, ProcessingMeta={
            "upload_id": str(UPLOAD_ID), "source_image_sha256": DIGEST,
        })
        service.repo.revisions.return_value = [revision]
        service.repo.revision.return_value = revision
        with patch("app.services.admin_ocr_service.upload_object") as upload, patch("app.services.admin_ocr_service.extract_text_and_boxes") as ocr:
            result = await service.replace_page_image(ACTOR_ID, PAGE_ID, object(), upload_id=UPLOAD_ID)
        self.assertIs(result, service.revision_detail.return_value)
        service.repo.stage_revision_bundle.assert_not_called()
        service.db.commit.assert_not_awaited()
        upload.assert_not_called()
        ocr.assert_not_called()

    async def test_historical_preview_uses_selected_revision_source_and_dimensions(self):
        repo = catalog_repo()
        newer_id = UPLOAD_ID
        repo.revisions.return_value = [revision_row(Id=newer_id, ProcessingMeta={
            "source_image_path": "https://example.test/new.png", "source_image_width": 900, "source_image_height": 1200,
        }), revision_row(ProcessingMeta={
            "source_image_path": "https://example.test/old.png", "source_image_width": 600, "source_image_height": 800,
        })]
        result = await AdminCatalogService(repository=repo).image(PAGE, REVISION)
        self.assertEqual(result.preview_url, "https://example.test/old.png")
        self.assertEqual((result.width, result.height), (600, 800))
        self.assertEqual(result.page_revision_id, REVISION)

    async def test_foreign_revision_is_rejected_before_signing(self):
        repo = catalog_repo()
        with patch("app.services.book_service.create_signed_image_url") as sign:
            with self.assertRaises(HTTPException) as caught:
                await AdminCatalogService(repository=repo).image(PAGE, UPLOAD_ID)
        self.assertEqual(caught.exception.status_code, 404)
        sign.assert_not_called()

    async def test_missing_historical_source_is_not_replaced_with_current_page_image(self):
        repo = catalog_repo()
        repo.page.return_value.CurrentVerifiedRevisionId = UPLOAD_ID
        repo.revisions.return_value = [revision_row(Id=UPLOAD_ID), revision_row()]
        with patch("app.services.book_service.create_signed_image_url") as sign:
            with self.assertRaises(HTTPException) as caught:
                await AdminCatalogService(repository=repo).image(PAGE, REVISION)
        self.assertEqual(caught.exception.status_code, 409)
        sign.assert_not_called()
