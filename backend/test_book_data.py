"""Scoped Parent catalog tests. No live database or Supabase calls."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql
from app.api.deps import get_current_parent_id, get_db
from app.api.routes.book import CatalogRepository, CatalogService, router
from app.schemas.book import CatalogBookResponse

ACTOR = UUID("11111111-1111-4111-8111-111111111111")
BOOK = UUID("22222222-2222-4222-8222-222222222222")
PAGE = UUID("33333333-3333-4333-8333-333333333333")
REVISION = UUID("44444444-4444-4444-8444-444444444444")

def book_row():
    return SimpleNamespace(Id=BOOK, Title="Tên sách database", Author=None, MinGrade=1, MaxGrade=3, LifecycleStatus="ACTIVE")


class CatalogTests(unittest.IsolatedAsyncioTestCase):
    async def test_parent_role_is_checked_at_backend(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        with self.assertRaises(HTTPException) as caught:
            await CatalogService(repository).require_parent(ACTOR)
        self.assertEqual(caught.exception.status_code, 403)
        repository.role.assert_awaited_once_with(ACTOR)

    async def test_response_maps_orm_without_admin_fields(self):
        response = CatalogBookResponse.model_validate(book_row()).model_dump()
        self.assertEqual(response["id"], BOOK)
        self.assertEqual(response["title"], "Tên sách database")
        self.assertNotIn("CreatedBy", response)

    async def test_catalog_query_checks_active_current_verified_same_page(self):
        db = MagicMock()
        db.execute = AsyncMock(return_value=MagicMock())
        db.execute.return_value.scalars.return_value.all.return_value = []
        await CatalogRepository(db).list("mèo_%", "Tác giả", 2)
        query = db.execute.await_args.args[0].compile(dialect=postgresql.dialect())
        sql = str(query)
        self.assertIn("EXISTS", sql)
        self.assertIn("pagerevisions.pageid = bookpages.id", sql)
        self.assertIn("bookpages.currentverifiedrevisionid", sql)
        self.assertIn("books.mingrade <=", sql)
        self.assertIn("books.maxgrade >=", sql)
        self.assertIn("ACTIVE", query.params.values())
        self.assertIn("VERIFIED", query.params.values())
        self.assertIn("%mèo\\_\\%%", query.params.values())

    async def test_missing_book_returns_404(self):
        repository = MagicMock()
        repository.get = AsyncMock(return_value=None)
        with self.assertRaises(HTTPException) as caught:
            await CatalogService(repository).get(BOOK)
        self.assertEqual(caught.exception.status_code, 404)

    async def test_ineligible_book_returns_existing_content_inactive_code(self):
        repository = MagicMock()
        repository.get = AsyncMock(return_value=book_row())
        repository.is_eligible = AsyncMock(return_value=False)
        with self.assertRaises(HTTPException) as caught:
            await CatalogService(repository).get(BOOK)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail, {"code": "CONTENT_INACTIVE"})

    async def test_relative_image_does_not_create_a_fake_preview_url(self):
        repository = MagicMock()
        repository.get = AsyncMock(return_value=book_row())
        repository.is_eligible = AsyncMock(return_value=True)
        repository.previews = AsyncMock(return_value=[SimpleNamespace(ImagePath="bucket/page.png")])
        with self.assertRaises(HTTPException) as caught:
            await CatalogService(repository).previews(BOOK)
        self.assertEqual(caught.exception.status_code, 503)

    async def test_absolute_preview_maps_actual_verified_revision(self):
        repository = MagicMock()
        repository.get = AsyncMock(return_value=book_row())
        repository.is_eligible = AsyncMock(return_value=True)
        repository.previews = AsyncMock(return_value=[SimpleNamespace(
            Id=PAGE, PageNumber=2, ImagePath="https://example.test/page.png",
            LifecycleStatus="ACTIVE", CurrentVerifiedRevisionId=REVISION,
        )])
        rows = await CatalogService(repository).previews(BOOK)
        self.assertEqual(rows[0].current_verified_revision_id, REVISION)
        self.assertEqual(rows[0].page_number, 2)

    async def test_malformed_and_credentialed_urls_are_safely_unavailable(self):
        for image_path in ("https://[bad/page.png", "https://example.test:bad/page.png", "https://user:password@example.test/page.png", "javascript:alert(1)"):
            with self.subTest(image_path=image_path):
                repository = MagicMock()
                repository.get = AsyncMock(return_value=book_row())
                repository.is_eligible = AsyncMock(return_value=True)
                repository.previews = AsyncMock(return_value=[SimpleNamespace(ImagePath=image_path)])
                with self.assertRaises(HTTPException) as caught:
                    await CatalogService(repository).previews(BOOK)
                self.assertEqual(caught.exception.status_code, 503)

    async def test_preview_query_filters_revision_page_and_lifecycle(self):
        db = MagicMock()
        db.execute = AsyncMock(return_value=MagicMock())
        db.execute.return_value.scalars.return_value.all.return_value = []
        await CatalogRepository(db).previews(BOOK)
        query = db.execute.await_args.args[0].compile(dialect=postgresql.dialect())
        self.assertIn("pagerevisions.pageid = bookpages.id", str(query))
        self.assertIn("VERIFIED", query.params.values())
        self.assertIn("ACTIVE", query.params.values())
        self.assertIn(BOOK, query.params.values())


class CatalogHttpTests(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.db.scalar = AsyncMock(return_value="parent")
        self.db.execute = AsyncMock(return_value=MagicMock())
        self.db.execute.return_value.scalars.return_value.all.return_value = [book_row()]
        self.app = FastAPI()
        self.app.include_router(router, prefix="/books")
        self.app.dependency_overrides[get_current_parent_id] = lambda: ACTOR
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)

    def test_get_catalog_serializes_public_dto(self):
        response = self.client.get("/books/catalog?grade=2")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[0]["title"], "Tên sách database")
        self.assertEqual(response.json()[0]["id"], str(BOOK))

    def test_get_catalog_validates_grade(self):
        self.assertEqual(self.client.get("/books/catalog?grade=6").status_code, 422)

    def test_get_catalog_requires_parent_role(self):
        self.db.scalar.return_value = "admin"
        self.assertEqual(self.client.get("/books/catalog").status_code, 403)

    def test_get_catalog_requires_token_without_test_override(self):
        del self.app.dependency_overrides[get_current_parent_id]
        self.assertEqual(self.client.get("/books/catalog").status_code, 401)

    def test_every_parent_read_endpoint_checks_role_before_reading_books(self):
        self.db.scalar.return_value = "admin"
        for path in ("/books/catalog", f"/books/catalog/{BOOK}", f"/books/catalog/{BOOK}/preview"):
            self.assertEqual(self.client.get(path).status_code, 403)
        self.db.execute.assert_not_awaited()

    def test_detail_and_preview_require_token(self):
        del self.app.dependency_overrides[get_current_parent_id]
        self.assertEqual(self.client.get(f"/books/catalog/{BOOK}").status_code, 401)
        self.assertEqual(self.client.get(f"/books/catalog/{BOOK}/preview").status_code, 401)


if __name__ == "__main__":
    unittest.main()
