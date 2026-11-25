"""Safe soft-delete tests for the Admin catalog book flow."""
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import book as book_routes
from app.models import Book
from app.repositories.admin_book_repository import AdminBookRepository
from app.repositories.book_repository import AdminCatalogRepository, CatalogRepository
from app.services.admin_book_service import AdminBookService

ADMIN_ID = UUID("11111111-1111-4111-8111-111111111111")
PARENT_ID = UUID("22222222-2222-4222-8222-222222222222")
CHILD_ID = UUID("44444444-4444-4444-8444-444444444444")
BOOK_ID = UUID("33333333-3333-4333-8333-333333333333")


def make_book(**overrides):
    values = {
        "Id": BOOK_ID,
        "Name": "Tên sách",
        "Title": "Tiêu đề sách",
        "Author": "Tác giả",
        "MinGrade": 1,
        "MaxGrade": 3,
        "LifecycleStatus": "ACTIVE",
        "VisibilityScope": "CATALOG",
        "IsDeleted": False,
        "DeletedAt": None,
        "DeletedBy": None,
        "CreatedBy": ADMIN_ID,
        "CreatedAt": datetime(2026, 10, 1, tzinfo=timezone.utc),
        "pages": ["page-history"],
        "reading_sessions": ["reading-history"],
        "game_sessions": ["game-history"],
        "audit_entries": ["audit-history"],
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class AdminBookSoftDeleteRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_marks_book_in_place_and_preserves_history_references(self):
        book = make_book()
        db = MagicMock()
        db.scalar = AsyncMock(return_value=book)
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        db.rollback = AsyncMock()
        db.delete = AsyncMock()

        result = await AdminBookRepository(db).soft_delete(BOOK_ID, actor_id=ADMIN_ID)

        self.assertTrue(result)
        self.assertEqual(book.Id, BOOK_ID)
        self.assertTrue(book.IsDeleted)
        self.assertIsNotNone(book.DeletedAt)
        self.assertIsNotNone(book.DeletedAt.utcoffset())
        self.assertEqual(book.DeletedBy, ADMIN_ID)
        self.assertEqual(book.pages, ["page-history"])
        self.assertEqual(book.reading_sessions, ["reading-history"])
        self.assertEqual(book.game_sessions, ["game-history"])
        self.assertEqual(book.audit_entries, ["audit-history"])
        db.commit.assert_awaited_once()
        db.refresh.assert_not_awaited()
        db.delete.assert_not_awaited()

        statement = db.scalar.await_args.args[0]
        sql = str(statement.compile(dialect=postgresql.dialect())).lower()
        self.assertIn("for update", sql)
        self.assertIn("books.visibility_scope", sql)

    async def test_repeat_delete_is_idempotent_and_keeps_original_actor_and_time(self):
        deleted_at = datetime(2026, 10, 3, tzinfo=timezone.utc)
        book = make_book(IsDeleted=True, DeletedAt=deleted_at, DeletedBy=PARENT_ID)
        db = MagicMock()
        db.scalar = AsyncMock(return_value=book)
        db.commit = AsyncMock()
        db.refresh = AsyncMock()

        result = await AdminBookRepository(db).soft_delete(BOOK_ID, actor_id=ADMIN_ID)

        self.assertTrue(result)
        self.assertEqual(book.DeletedAt, deleted_at)
        self.assertEqual(book.DeletedBy, PARENT_ID)
        db.commit.assert_not_awaited()
        db.refresh.assert_not_awaited()

    async def test_unknown_or_private_book_is_not_deleted(self):
        db = MagicMock()
        db.scalar = AsyncMock(return_value=None)
        db.commit = AsyncMock()

        result = await AdminBookRepository(db).soft_delete(BOOK_ID, actor_id=ADMIN_ID)

        self.assertFalse(result)
        db.commit.assert_not_awaited()


class AdminBookSoftDeleteAuthorizationTests(unittest.TestCase):
    def make_client(self, *, actor_id=ADMIN_ID, role="admin", book=None):
        db = MagicMock()
        if role == "admin":
            db.scalar = AsyncMock(side_effect=[role, book or make_book()])
        else:
            db.scalar = AsyncMock(return_value=role)
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        db.rollback = AsyncMock()

        app = FastAPI()
        app.include_router(book_routes.router, prefix="/books")
        if actor_id is not None:
            app.dependency_overrides[get_current_parent_id] = lambda: actor_id
        app.dependency_overrides[get_db] = lambda: db
        return TestClient(app), app, db

    def test_missing_authentication_is_401(self):
        client, app, _ = self.make_client(actor_id=None)
        try:
            response = client.delete(f"/books/admin/catalog/{BOOK_ID}")
        finally:
            app.dependency_overrides.clear()
        self.assertEqual(response.status_code, 401)

    def test_parent_and_child_are_forbidden(self):
        for actor_id, role in ((PARENT_ID, "parent"), (CHILD_ID, "child")):
            with self.subTest(role=role):
                client, app, db = self.make_client(actor_id=actor_id, role=role)
                try:
                    response = client.delete(f"/books/admin/catalog/{BOOK_ID}")
                finally:
                    app.dependency_overrides.clear()
                self.assertEqual(response.status_code, 403)
                self.assertEqual(db.scalar.await_count, 1)

    def test_admin_uses_authenticated_actor_and_returns_soft_delete_state(self):
        book = make_book()
        client, app, db = self.make_client(book=book)
        try:
            response = client.delete(f"/books/admin/catalog/{BOOK_ID}")
        finally:
            app.dependency_overrides.clear()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"book_id": str(BOOK_ID), "is_deleted": True})
        self.assertTrue(book.IsDeleted)
        self.assertEqual(book.DeletedBy, ADMIN_ID)
        db.delete.assert_not_called()


class DeletedBookVisibilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_catalog_eligibility_excludes_soft_deleted_books(self):
        statement = select(Book.Id).where(CatalogRepository.eligible_book())
        sql = str(statement.compile(dialect=postgresql.dialect())).lower()
        self.assertIn("books.is_deleted is false", sql)

    async def test_admin_search_excludes_deleted_books(self):
        result = MagicMock()
        result.scalars.return_value.all.return_value = []
        db = MagicMock()
        db.execute = AsyncMock(return_value=result)

        await AdminCatalogRepository(db).books("sách", None)

        statement = db.execute.await_args.args[0]
        sql = str(statement.compile(dialect=postgresql.dialect())).lower()
        self.assertIn("books.is_deleted is false", sql)

    async def test_admin_catalog_rows_exclude_deleted_books(self):
        result = MagicMock()
        result.all.return_value = []
        db = MagicMock()
        db.execute = AsyncMock(return_value=result)

        await AdminCatalogRepository(db).catalog_rows(None, None, None)

        statement = db.execute.await_args.args[0]
        sql = str(statement.compile(dialect=postgresql.dialect())).lower()
        self.assertIn("books.is_deleted is false", sql)


if __name__ == "__main__":
    unittest.main()
