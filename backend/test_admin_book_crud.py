"""Isolation tests for Admin book metadata and lifecycle write flows."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import book as book_routes
from app.repositories.admin_book_repository import AdminBookRepository
from app.schemas.admin_book import AdminBookWriteRequest
from app.services.admin_book_service import AdminBookService

ADMIN_ID = UUID("11111111-1111-4111-8111-111111111111")
PARENT_ID = UUID("22222222-2222-4222-8222-222222222222")
BOOK_ID = UUID("33333333-3333-4333-8333-333333333333")
CREATED_AT = "2026-10-01T00:00:00Z"


def make_book(**overrides):
    values = {
        "Id": BOOK_ID,
        "Title": "Sách cũ",
        "Author": "Tác giả cũ",
        "MinGrade": 1,
        "MaxGrade": 3,
        "LifecycleStatus": "ACTIVE",
        "CreatedBy": ADMIN_ID,
        "CreatedAt": CREATED_AT,
        "pages": ["page-history"],
        "reading_sessions": ["reading-history"],
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class FakeAdminBookRepository:
    def __init__(self, *, role="admin", book=None):
        self.role_value = role
        self.book = book or make_book()
        self.created = None
        self.updated_values = None
        self.lifecycle_calls = []
        self.create = AsyncMock(side_effect=self._create)
        self.get = AsyncMock(return_value=self.book)
        self.update_metadata = AsyncMock(side_effect=self._update)
        self.set_lifecycle = AsyncMock(side_effect=self._set_lifecycle)

    async def role(self, actor_id):
        return self.role_value

    async def _create(self, *, actor_id, values):
        self.created = {"actor_id": actor_id, **values}
        return make_book(
            Title=values["title"],
            Author=values.get("author"),
            MinGrade=values["min_grade"],
            MaxGrade=values["max_grade"],
            CreatedBy=actor_id,
        )

    async def _update(self, book, *, values):
        self.updated_values = dict(values)
        book.Title = values["title"]
        book.Author = values.get("author")
        book.MinGrade = values["min_grade"]
        book.MaxGrade = values["max_grade"]
        return book

    async def _set_lifecycle(self, book, status):
        self.lifecycle_calls.append(status)
        book.LifecycleStatus = status
        return book


class AdminBookSchemaTests(unittest.TestCase):
    def test_title_is_trimmed_and_blank_title_is_rejected(self):
        payload = AdminBookWriteRequest(
            title="  Truyện của bé  ",
            author="  Tác giả  ",
            min_grade=1,
            max_grade=2,
        )
        self.assertEqual(payload.title, "Truyện của bé")
        self.assertEqual(payload.author, "Tác giả")
        with self.assertRaises(ValidationError):
            AdminBookWriteRequest(
                title=" \t\r\n ",
                author=None,
                min_grade=1,
                max_grade=2,
            )

    def test_author_can_be_empty_and_grade_range_must_be_valid(self):
        payload = AdminBookWriteRequest(
            title="Sách hợp lệ",
            author="   ",
            min_grade=1,
            max_grade=5,
        )
        self.assertIsNone(payload.author)
        for values in (
            {"min_grade": 0, "max_grade": 2},
            {"min_grade": 2, "max_grade": 6},
            {"min_grade": 4, "max_grade": 3},
        ):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                AdminBookWriteRequest(
                    title="Sách",
                    author=None,
                    **values,
                )


class AdminBookServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_admin_can_create_update_or_change_lifecycle(self):
        repository = FakeAdminBookRepository(role="parent")
        service = AdminBookService(repository)
        payload = AdminBookWriteRequest(
            title="Sách", author=None, min_grade=1, max_grade=3
        )
        for operation in (
            service.create(PARENT_ID, payload),
            service.update(PARENT_ID, BOOK_ID, payload),
            service.update_lifecycle(PARENT_ID, BOOK_ID, "RETIRED"),
        ):
            with self.assertRaises(HTTPException) as caught:
                await operation
            self.assertEqual(caught.exception.status_code, 403)
        repository.create.assert_not_awaited()
        repository.update_metadata.assert_not_awaited()
        repository.set_lifecycle.assert_not_awaited()

    async def test_create_uses_authenticated_actor_and_stores_trimmed_metadata(self):
        repository = FakeAdminBookRepository()
        payload = AdminBookWriteRequest(
            title="  Sách mới  ", author="  ", min_grade=1, max_grade=4
        )
        response = await AdminBookService(repository).create(ADMIN_ID, payload)
        self.assertEqual(response.title, "Sách mới")
        self.assertIsNone(response.author)
        self.assertEqual(repository.created["actor_id"], ADMIN_ID)
        self.assertEqual(repository.created["min_grade"], 1)
        self.assertEqual(response.lifecycle_status, "ACTIVE")

    async def test_metadata_update_does_not_change_identity_or_read_history(self):
        row = make_book()
        repository = FakeAdminBookRepository(book=row)
        payload = AdminBookWriteRequest(
            title="  Sách đã sửa ", author=None, min_grade=2, max_grade=4
        )
        response = await AdminBookService(repository).update(ADMIN_ID, BOOK_ID, payload)
        self.assertEqual(response.title, "Sách đã sửa")
        self.assertEqual(row.Id, BOOK_ID)
        self.assertEqual(row.CreatedBy, ADMIN_ID)
        self.assertEqual(row.CreatedAt, CREATED_AT)
        self.assertEqual(row.LifecycleStatus, "ACTIVE")
        self.assertEqual(row.pages, ["page-history"])
        self.assertEqual(row.reading_sessions, ["reading-history"])

    async def test_retire_changes_only_lifecycle_and_preserves_history(self):
        row = make_book()
        repository = FakeAdminBookRepository(book=row)
        result = await AdminBookService(repository).update_lifecycle(
            ADMIN_ID, BOOK_ID, "RETIRED"
        )
        self.assertEqual(result.lifecycle_status, "RETIRED")
        self.assertEqual(repository.lifecycle_calls, ["RETIRED"])
        self.assertEqual(row.pages, ["page-history"])
        self.assertEqual(row.reading_sessions, ["reading-history"])

    async def test_reactivation_rejects_invalid_metadata_without_writing(self):
        row = make_book(Title="  ", MinGrade=0, MaxGrade=6, LifecycleStatus="RETIRED")
        repository = FakeAdminBookRepository(book=row)
        with self.assertRaises(HTTPException) as caught:
            await AdminBookService(repository).update_lifecycle(
                ADMIN_ID, BOOK_ID, "ACTIVE"
            )
        self.assertEqual(caught.exception.status_code, 422)
        repository.set_lifecycle.assert_not_awaited()
        self.assertEqual(row.LifecycleStatus, "RETIRED")

    async def test_missing_book_returns_404(self):
        repository = FakeAdminBookRepository()
        repository.get = AsyncMock(return_value=None)
        payload = AdminBookWriteRequest(
            title="Sách", author=None, min_grade=1, max_grade=3
        )
        with self.assertRaises(HTTPException) as caught:
            await AdminBookService(repository).update(ADMIN_ID, BOOK_ID, payload)
        self.assertEqual(caught.exception.status_code, 404)

    async def test_database_error_response_does_not_expose_database_details(self):
        repository = FakeAdminBookRepository()
        repository.create.side_effect = SQLAlchemyError("private-db-connection-detail")
        payload = AdminBookWriteRequest(
            title="Sách", author=None, min_grade=1, max_grade=3
        )
        with self.assertRaises(HTTPException) as caught:
            await AdminBookService(repository).create(ADMIN_ID, payload)
        self.assertEqual(caught.exception.status_code, 500)
        self.assertNotIn("private-db-connection-detail", str(caught.exception.detail))


class AdminBookAuthHttpTests(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.db.scalar = AsyncMock(return_value="parent")
        self.app = FastAPI()
        self.app.include_router(book_routes.router, prefix="/books")
        self.app.dependency_overrides[get_current_parent_id] = lambda: PARENT_ID
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)

    def test_missing_access_token_returns_401(self):
        self.app.dependency_overrides.pop(get_current_parent_id, None)
        response = self.client.post(
            "/books/admin/catalog",
            json={"title": "Sách", "author": None, "min_grade": 1, "max_grade": 3},
        )
        self.assertEqual(response.status_code, 401)

    def test_parent_cannot_create_update_or_change_book_lifecycle(self):
        payload = {"title": "Sách", "author": None, "min_grade": 1, "max_grade": 3}
        responses = (
            self.client.post("/books/admin/catalog", json=payload),
            self.client.put(f"/books/admin/catalog/{BOOK_ID}", json=payload),
            self.client.patch(
                f"/books/admin/catalog/{BOOK_ID}/status",
                json={"status": "RETIRED"},
            ),
        )
        self.assertEqual([response.status_code for response in responses], [403, 403, 403])


if __name__ == "__main__":
    unittest.main()
