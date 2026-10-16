"""Tests for safe, non-destructive Admin page management operations."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException

from app.services.admin_ocr_service import AdminOcrService


ACTOR = UUID("11111111-1111-4111-8111-111111111111")
BOOK = UUID("22222222-2222-4222-8222-222222222222")
PAGE = UUID("33333333-3333-4333-8333-333333333333")
REVISION = UUID("44444444-4444-4444-8444-444444444444")


def make_page(**overrides):
    fields = {
        "Id": PAGE,
        "BookId": BOOK,
        "PageNumber": 2,
        "LifecycleStatus": "ACTIVE",
        "CurrentVerifiedRevisionId": REVISION,
        "ImagePath": "books/source-page.png",
    }
    return SimpleNamespace(**(fields | overrides))


def make_service(page, role="admin"):
    db = MagicMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    db.rollback = AsyncMock()
    service = AdminOcrService(db)
    service.repo.role = AsyncMock(return_value=role)
    service.repo.page = AsyncMock(return_value=page)
    service.repo.set_page_lifecycle_status = MagicMock(
        side_effect=lambda current, status: setattr(current, "LifecycleStatus", status)
    )
    return service, db


class AdminPageRetirementTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_retires_page_without_deleting_source_or_revision_pointer(self):
        page = make_page()
        original_image_path = page.ImagePath
        original_revision_id = page.CurrentVerifiedRevisionId
        service, db = make_service(page)

        result = await service.retire_page(ACTOR, PAGE)

        self.assertEqual(result.page_id, PAGE)
        self.assertEqual(result.book_id, BOOK)
        self.assertEqual(result.page_number, 2)
        self.assertEqual(result.lifecycle_status, "RETIRED")
        self.assertEqual(page.LifecycleStatus, "RETIRED")
        self.assertEqual(page.ImagePath, original_image_path)
        self.assertEqual(page.CurrentVerifiedRevisionId, original_revision_id)
        db.commit.assert_awaited_once()
        db.refresh.assert_awaited_once_with(page)
        db.rollback.assert_not_awaited()

    async def test_non_admin_cannot_retire_page_or_mutate_database(self):
        page = make_page()
        service, db = make_service(page, role="parent")

        with self.assertRaises(HTTPException) as caught:
            await service.retire_page(ACTOR, PAGE)

        self.assertEqual(caught.exception.status_code, 403)
        service.repo.page.assert_not_awaited()
        service.repo.set_page_lifecycle_status.assert_not_called()
        db.commit.assert_not_awaited()

    async def test_missing_page_returns_not_found(self):
        service, db = make_service(None)

        with self.assertRaises(HTTPException) as caught:
            await service.retire_page(ACTOR, PAGE)

        self.assertEqual(caught.exception.status_code, 404)
        db.commit.assert_not_awaited()

    async def test_retiring_an_already_retired_page_is_idempotent(self):
        page = make_page(LifecycleStatus="RETIRED")
        service, db = make_service(page)

        result = await service.retire_page(ACTOR, PAGE)

        self.assertEqual(result.lifecycle_status, "RETIRED")
        db.commit.assert_not_awaited()
        service.repo.set_page_lifecycle_status.assert_not_called()


    async def test_retired_page_cannot_be_edited_or_verified(self):
        for operation in ("save", "verify"):
            page = make_page(LifecycleStatus="RETIRED")
            service, db = make_service(page)
            with self.subTest(operation=operation):
                with self.assertRaises(HTTPException) as caught:
                    if operation == "save":
                        await service.save_draft(ACTOR, PAGE, REVISION, None)
                    else:
                        await service.verify(ACTOR, PAGE, None)
                self.assertEqual(caught.exception.status_code, 409)
                db.commit.assert_not_awaited()
                service.repo.revision.assert_not_awaited()

if __name__ == "__main__":
    unittest.main()
