"""Admin read contracts, authorization and safe projections. No live writes."""
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import SQLAlchemyError
from app.api.deps import get_current_parent_id, get_db
from app.api.routes.book import AdminCatalogRepository, AdminCatalogService, router as book_router
from app.api.routes.system import AdminSystemRepository, AdminSystemService, router as system_router

ACTOR = UUID("11111111-1111-4111-8111-111111111111")
BOOK = UUID("22222222-2222-4222-8222-222222222222")
PAGE = UUID("33333333-3333-4333-8333-333333333333")
REVISION = UUID("44444444-4444-4444-8444-444444444444")
NOW = datetime(2026, 10, 8, tzinfo=timezone.utc)


def book_row():
    return SimpleNamespace(Id=BOOK, Title="Real retired book", Author=None, MinGrade=1, MaxGrade=3, LifecycleStatus="RETIRED")


def page_row(**overrides):
    values = dict(Id=PAGE, BookId=BOOK, PageNumber=2, LifecycleStatus="ACTIVE", CurrentVerifiedRevisionId=REVISION,
                  ImagePath="https://example.test/page.png", Width=800, Height=1000)
    return SimpleNamespace(**(values | overrides))


def revision_row(**overrides):
    values = dict(Id=REVISION, PageId=PAGE, RevisionNo="2", VerificationStatus="VERIFIED", CreatedAt=NOW,
                  VerifiedAt=NOW, VerifiedBy=ACTOR, VerifiedText="Stored verified text", OCRMetadata={"token": "private"})
    return SimpleNamespace(**(values | overrides))


def catalog_repo():
    repo = MagicMock()
    repo.role = AsyncMock(return_value="admin")
    repo.get = AsyncMock(return_value=book_row())
    repo.books = AsyncMock(return_value=[book_row()])
    repo.page = AsyncMock(return_value=page_row())
    repo.pages = AsyncMock(return_value=[page_row()])
    repo.revisions = AsyncMock(return_value=[revision_row()])
    repo.revision = AsyncMock(return_value=revision_row())
    repo.words = AsyncMock(return_value=[])
    repo.is_eligible = AsyncMock(return_value=False)
    return repo


class AdminCatalogTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_can_read_retired_book_and_actual_counts(self):
        repo = catalog_repo()
        result = await AdminCatalogService(repo).list(None, None, None)
        self.assertEqual(result[0].book.lifecycle_status, "RETIRED")
        self.assertEqual(result[0].page_count, 1)
        self.assertEqual(result[0].verified_count, 1)
        self.assertEqual(result[0].processing_count, 0)
        self.assertFalse(result[0].parent_catalog_eligible)

    async def test_catalog_verification_filter_checks_real_latest_status(self):
        self.assertEqual(await AdminCatalogService(catalog_repo()).list(None, None, "PROCESSING"), [])

    async def test_unknown_page_status_is_not_silently_counted_as_zero(self):
        repo = catalog_repo()
        repo.revisions.return_value = [revision_row(VerificationStatus="UNKNOWN")]
        with self.assertRaises(HTTPException) as caught:
            await AdminCatalogService(repo).list(None, None, None)
        self.assertEqual(caught.exception.status_code, 501)

    async def test_actual_empty_pages_differs_from_missing_revision(self):
        repo = catalog_repo()
        repo.pages.return_value = []
        self.assertEqual(await AdminCatalogService(repo).pages(BOOK), [])
        repo.revisions.return_value = []
        with self.assertRaises(HTTPException) as caught:
            await AdminCatalogService(repo).processing(page_row())
        self.assertEqual(caught.exception.status_code, 501)

    async def test_processing_and_history_use_latest_created_order_without_renumbering(self):
        repo = catalog_repo()
        repo.revisions.return_value = [revision_row(RevisionNo="2"), revision_row(Id=ACTOR, RevisionNo="9")]
        result = await AdminCatalogService(repo).processing(page_row())
        self.assertEqual(result.revision_no, 2)
        self.assertEqual(result.page_revision_id, REVISION)
        self.assertEqual(result.ocr_preview_metadata, {})

    async def test_revision_number_requires_bounded_positive_numeric_contract(self):
        for value in ("R1", "0", "-1", "²", "９", "9" * 5000, "9007199254740992"):
            with self.subTest(value=value[:20]):
                with self.assertRaises(HTTPException) as caught:
                    AdminCatalogService.revision_number(revision_row(RevisionNo=value))
                self.assertEqual(caught.exception.status_code, 501)

    async def test_image_uses_actual_dimensions_and_url(self):
        result = await AdminCatalogService(catalog_repo()).image(PAGE)
        self.assertEqual(result.width, 800)
        self.assertEqual(result.preview_url, page_row().ImagePath)

    async def test_malformed_relative_and_credentialed_images_are_safe(self):
        for path in ("bucket/image.png", "https://[bad/image", "https://example.test:bad/image", "https://user:password@example.test/image", "javascript:alert(1)", None):
            repo = catalog_repo()
            repo.page.return_value = page_row(ImagePath=path)
            with self.subTest(path=path):
                with self.assertRaises(HTTPException) as caught:
                    await AdminCatalogService(repo).image(PAGE)
                self.assertEqual(caught.exception.status_code, 503)
                self.assertNotIn("password", caught.exception.detail)

    async def test_invalid_dimensions_and_book_contract_are_unavailable(self):
        repo = catalog_repo()
        repo.page.return_value = page_row(Width=0)
        with self.assertRaises(HTTPException) as caught:
            await AdminCatalogService(repo).image(PAGE)
        self.assertEqual(caught.exception.status_code, 501)
        repo.get.return_value.MinGrade = -1
        with self.assertRaises(HTTPException) as caught:
            await AdminCatalogService(repo).book(BOOK)
        self.assertEqual(caught.exception.status_code, 501)

    async def test_unknown_book_page_and_revision_are_404(self):
        for method, args, missing in (("book", (BOOK,), "get"), ("page", (PAGE,), "page"), ("revision", (PAGE, REVISION), "revision")):
            repo = catalog_repo()
            getattr(repo, missing).return_value = None
            with self.assertRaises(HTTPException) as caught:
                await getattr(AdminCatalogService(repo), method)(*args)
            self.assertEqual(caught.exception.status_code, 404)

    async def test_revision_words_and_verified_text_are_real_but_metadata_is_private(self):
        repo = catalog_repo()
        repo.words.return_value = [SimpleNamespace(WordIndex=0, LineIndex=0, Text="Stored", NormalizedText="stored", BoundingBox={"x": .1, "y": .2, "width": .3, "height": .1}, OCRConfidence=.8)]
        result = await AdminCatalogService(repo).revision(PAGE, REVISION)
        self.assertEqual(result.draft_text, "Stored verified text")
        self.assertEqual(result.words[0].bbox, (.1, .2, .3, .1))
        self.assertEqual(result.ocr_metadata, {})

    async def test_pixel_bbox_is_not_guessed_as_normalized(self):
        repo = catalog_repo()
        repo.words.return_value = [SimpleNamespace(BoundingBox={"x": 120, "y": 20, "width": 40, "height": 20})]
        with self.assertRaises(HTTPException) as caught:
            await AdminCatalogService(repo).revision(PAGE, REVISION)
        self.assertEqual(caught.exception.status_code, 501)

    async def test_revision_sql_scopes_both_page_and_revision(self):
        db = MagicMock(scalar=AsyncMock(return_value=None))
        await AdminCatalogRepository(db).revision(PAGE, REVISION)
        query = db.scalar.await_args.args[0].compile(dialect=postgresql.dialect())
        self.assertIn(PAGE, query.params.values())
        self.assertIn(REVISION, query.params.values())


class AdminSystemTests(unittest.IsolatedAsyncioTestCase):
    async def test_non_admin_profiles_are_denied(self):
        for role in ("parent", None, "ADMIN"):
            repo = MagicMock(role=AsyncMock(return_value=role))
            with self.assertRaises(HTTPException) as caught:
                await AdminSystemService(repo).require_admin(ACTOR)
            self.assertEqual(caught.exception.status_code, 403)

    async def test_audit_pagination_and_safe_nullable_projection(self):
        row = SimpleNamespace(Id=REVISION, ActorId=None, ResourceId=None, RequestId=None, Action="book.read", ResourceType="book", CreatedAt=NOW, Metadata={"token": "private", "audio": "private"})
        repo = MagicMock(logs=AsyncMock(return_value=[row, row]))
        result = await AdminSystemService(repo).logs("book.read", "book", "page-2", 1)
        repo.logs.assert_awaited_once_with("book.read", "book", 1, 2)
        self.assertEqual(result.next_cursor, "page-3")
        self.assertIsNone(result.items[0].actor_id)
        self.assertEqual(result.items[0].metadata, {})
        self.assertNotIn("private", result.model_dump_json())

    async def test_empty_audit_is_genuinely_empty(self):
        result = await AdminSystemService(MagicMock(logs=AsyncMock(return_value=[]))).logs(None, None, None, 10)
        self.assertEqual(result.items, [])
        self.assertIsNone(result.next_cursor)

    async def test_audit_cursor_and_size_validated_before_query(self):
        for cursor, limit in (("page-0", 10), ("page-100001", 10), ("page-" + "9" * 5000, 10), ("page-²", 10), ("page-01", 10), (None, 0), (None, 101)):
            repo = MagicMock(logs=AsyncMock())
            with self.assertRaises(HTTPException) as caught:
                await AdminSystemService(repo).logs(None, None, cursor, limit)
            self.assertEqual(caught.exception.status_code, 422)
            repo.logs.assert_not_awaited()

    async def test_audit_sql_exact_filters_and_stable_order(self):
        db = MagicMock(execute=AsyncMock(return_value=MagicMock()))
        db.execute.return_value.scalars.return_value.all.return_value = []
        await AdminSystemRepository(db).logs("book_%", "book", 10, 11)
        query = db.execute.await_args.args[0].compile(dialect=postgresql.dialect())
        self.assertIn("auditlogs.createdat DESC, auditlogs.id DESC", str(query))
        self.assertNotIn("ILIKE", str(query))
        self.assertIn("book_%", query.params.values())
        self.assertIn(10, query.params.values())

    async def test_health_reports_only_services_actually_checked(self):
        repo = MagicMock(probe_database=AsyncMock(return_value=True))
        result = await AdminSystemService(repo).health()
        self.assertEqual(result.overall_status, "HEALTHY")
        self.assertEqual([item.id for item in result.services], ["api", "database"])
        repo.probe_database.assert_awaited_once()

    async def test_probe_uses_select_not_write(self):
        db = MagicMock(scalar=AsyncMock(return_value=1))
        self.assertTrue(await AdminSystemRepository(db).probe_database())
        query = str(db.scalar.await_args.args[0].compile(dialect=postgresql.dialect()))
        self.assertTrue(query.startswith("SELECT"))
        db.commit.assert_not_called()

    async def test_probe_failure_is_degraded_without_private_error(self):
        for failure in (TimeoutError("private"), SQLAlchemyError("private"), OSError("private")):
            repo = MagicMock(probe_database=AsyncMock(side_effect=failure))
            result = await AdminSystemService(repo).health()
            self.assertEqual(result.overall_status, "DEGRADED")
            self.assertEqual(result.services[1].status, "UNAVAILABLE")
            self.assertNotIn("private", result.model_dump_json())


class AdminHttpTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(book_router, prefix="/books")
        self.app.include_router(system_router, prefix="/system")
        self.db = MagicMock(scalar=AsyncMock(return_value="parent"))
        self.db.execute = AsyncMock()
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)
        self.paths = ["/books/admin/catalog", f"/books/admin/catalog/{BOOK}", f"/books/admin/catalog/{BOOK}/pages",
                      f"/books/admin/pages/{PAGE}/image", f"/books/admin/pages/{PAGE}/processing",
                      f"/books/admin/pages/{PAGE}/revisions", f"/books/admin/pages/{PAGE}/revisions/{REVISION}",
                      "/system/admin/audit-logs", "/system/admin/health"]

    def test_all_admin_reads_require_authenticated_identity(self):
        for path in self.paths:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 401)
        self.db.scalar.assert_not_awaited()

    def test_all_admin_reads_check_role_before_data(self):
        self.app.dependency_overrides[get_current_parent_id] = lambda: ACTOR
        for path in self.paths:
            with self.subTest(path=path):
                self.db.scalar.reset_mock()
                self.assertEqual(self.client.get(path).status_code, 403)
                self.assertEqual(self.db.scalar.await_count, 1)
                self.db.execute.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
