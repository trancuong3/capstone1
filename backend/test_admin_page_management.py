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

from sqlalchemy.dialects import postgresql

from app.repositories.book_repository import AdminCatalogRepository
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
    service.repo.book = AsyncMock(return_value=SimpleNamespace(Id=BOOK, LifecycleStatus="ACTIVE"))
    service.repo.page = AsyncMock(return_value=page)
    service.repo.active_pages_for_renumber = AsyncMock(return_value=[])
    service.repo.flush = AsyncMock()
    service.repo.set_page_number = MagicMock(
        side_effect=lambda current, number: setattr(current, "PageNumber", number)
    )
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

    async def test_retiring_middle_page_renumbers_following_active_pages(self):
        retired = make_page(PageNumber=2)
        first = make_page(
            Id=UUID("77777777-7777-4777-8777-777777777777"),
            PageNumber=1,
        )
        third = make_page(
            Id=UUID("55555555-5555-4555-8555-555555555555"),
            PageNumber=3,
        )
        fourth = make_page(
            Id=UUID("66666666-6666-4666-8666-666666666666"),
            PageNumber=4,
        )
        service, db = make_service(retired)
        service.repo.active_pages_for_renumber = AsyncMock(
            return_value=[first, third, fourth]
        )

        result = await service.retire_page(ACTOR, PAGE)

        self.assertEqual(result.lifecycle_status, "RETIRED")
        self.assertEqual(retired.LifecycleStatus, "RETIRED")
        self.assertEqual(retired.PageNumber, 2)
        self.assertEqual([first.PageNumber, third.PageNumber, fourth.PageNumber], [1, 2, 3])
        db.commit.assert_awaited_once()
        service.repo.flush.assert_awaited()
        self.assertEqual(service.repo.flush.await_count, 3)
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


class RetiredPageWriteProtectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_retired_page_cannot_create_edit_draft(self):
        service, db = make_service(make_page(LifecycleStatus="RETIRED"))
        service.repo.revision = AsyncMock()

        with self.assertRaises(HTTPException) as caught:
            await service.create_edit_draft(ACTOR, PAGE)

        self.assertEqual(caught.exception.status_code, 409)
        service.repo.revision.assert_not_awaited()
        db.commit.assert_not_awaited()

    async def test_retired_page_cannot_save_draft_or_verify(self):
        for operation in ("save_draft", "verify"):
            with self.subTest(operation=operation):
                service, db = make_service(make_page(LifecycleStatus="RETIRED"))
                service.repo.revision = AsyncMock()
                if operation == "save_draft":
                    call = service.save_draft(ACTOR, PAGE, REVISION, None)
                else:
                    call = service.verify(ACTOR, PAGE, None)

                with self.assertRaises(HTTPException) as caught:
                    await call

                self.assertEqual(caught.exception.status_code, 409)
                service.repo.revision.assert_not_awaited()
                db.commit.assert_not_awaited()


class AdminCatalogActivePageListTests(unittest.IsolatedAsyncioTestCase):
    async def test_max_page_number_query_uses_active_pages_only(self):
        db = MagicMock()
        db.scalar = AsyncMock(return_value=4)

        result = await AdminCatalogRepository(db).max_page_number(BOOK)

        self.assertEqual(result, 4)
        statement = db.scalar.await_args.args[0]
        compiled = statement.compile(dialect=postgresql.dialect())
        self.assertIn("max(bookpages.pagenumber)", str(compiled))
        self.assertIn("lifecyclestatus", str(compiled).lower())
        self.assertIn("ACTIVE", compiled.params.values())
        self.assertIn(BOOK, compiled.params.values())

    async def test_admin_page_list_query_excludes_retired_pages(self):
        db = MagicMock()
        active_page = make_page()
        result = MagicMock()
        result.scalars.return_value.all.return_value = [active_page]
        db.execute = AsyncMock(return_value=result)

        pages = await AdminCatalogRepository(db).pages(BOOK)

        self.assertEqual(pages, [active_page])
        statement = db.execute.await_args.args[0]
        compiled = statement.compile(dialect=postgresql.dialect())
        self.assertIn("lifecyclestatus", str(compiled))
        self.assertIn("ACTIVE", compiled.params.values())



class ActivePageRenumberingTests(unittest.IsolatedAsyncioTestCase):
    async def test_service_renumbers_active_pages_in_existing_order(self):
        page1 = make_page(PageNumber=1)
        page3 = make_page(
            Id=UUID("55555555-5555-4555-8555-555555555555"),
            PageNumber=3,
        )
        page4 = make_page(
            Id=UUID("66666666-6666-4666-8666-666666666666"),
            PageNumber=4,
        )
        service, _ = make_service(page1)
        service.repo.active_pages_for_renumber = AsyncMock(
            return_value=[page1, page3, page4]
        )
        service.repo.flush = AsyncMock()

        changed = await service._renumber_active_pages(BOOK, lock=True)

        self.assertTrue(changed)
        self.assertEqual([page1.PageNumber, page3.PageNumber, page4.PageNumber], [1, 2, 3])
        service.repo.set_page_number.assert_any_call(page3, 2)
        service.repo.set_page_number.assert_any_call(page4, 3)
        self.assertEqual(service.repo.flush.await_count, 2)


if __name__ == "__main__":
    unittest.main()
