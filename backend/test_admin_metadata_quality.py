"""Unit/API contract tests for the read-only Admin metadata quality dashboard."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import book as book_routes
from app.repositories.metadata_quality_repository import MetadataQualityRepository
from app.services.metadata_quality_service import MetadataQualityService

ADMIN_ID = UUID("11111111-1111-4111-8111-111111111111")
PARENT_ID = UUID("22222222-2222-4222-8222-222222222222")
BOOK_ID = UUID("33333333-3333-4333-8333-333333333333")


class FakeMetadataQualityRepository:
    def __init__(self, role="admin", rows=None):
        self.role_value = role
        self.rows = rows or []
        self.summary_called = False

    async def role(self, actor_id):
        return self.role_value

    async def summary_counts(self):
        self.summary_called = True
        return {
            "total_books": 8,
            "books_with_issues": 3,
            "missing_title": 1,
            "missing_author": 2,
            "invalid_grade_range": 1,
            "possible_duplicate_groups": 1,
            "books_in_duplicate_groups": 2,
        }

    async def list_issues(self, **kwargs):
        return self.rows, len(self.rows)


def make_client():
    app = FastAPI()
    app.include_router(book_routes.router, prefix="/books")

    async def fake_db():
        return object()

    app.dependency_overrides[get_db] = fake_db
    return TestClient(app)


class MetadataQualityRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_summary_uses_global_aggregates_and_excludes_blank_authors_from_duplicate_groups(self):
        row = SimpleNamespace(
            total_books=10,
            books_with_issues=4,
            missing_title=1,
            missing_author=2,
            invalid_grade_range=1,
            books_in_duplicate_groups=3,
        )
        db = SimpleNamespace(
            execute=AsyncMock(return_value=SimpleNamespace(one=lambda: row)),
            scalar=AsyncMock(return_value=1),
        )

        summary = await MetadataQualityRepository(db).summary_counts()

        self.assertEqual(
            summary,
            {
                "total_books": 10,
                "books_with_issues": 4,
                "missing_title": 1,
                "missing_author": 2,
                "invalid_grade_range": 1,
                "possible_duplicate_groups": 1,
                "books_in_duplicate_groups": 3,
            },
        )
        self.assertEqual(db.execute.await_count, 1)
        self.assertEqual(db.scalar.await_count, 1)
        group_statement = db.scalar.await_args.args[0]
        compiled_group = group_statement.compile(dialect=postgresql.dialect())
        group_sql = str(compiled_group).lower()
        self.assertIn("books.title", group_sql)
        self.assertIn("books.author", group_sql)
        self.assertIn("having count(books.id) > ", group_sql)
        self.assertIn(
            r"^[[:space:]]+|[[:space:]]+$",
            compiled_group.params.values(),
        )

    async def test_duplicate_candidate_requires_non_empty_title_and_author(self):
        statement = MetadataQualityRepository._possible_duplicate()
        compiled = statement.compile(dialect=postgresql.dialect())
        sql = str(compiled).lower()

        # Both the current and candidate records must have non-empty normalized
        # title and author values before they can be treated as duplicate candidates.
        self.assertGreaterEqual(sql.count("length("), 4)
        self.assertIn("books.author", sql)
        self.assertIn("books.title", sql)
        self.assertIn(
            r"^[[:space:]]+|[[:space:]]+$",
            compiled.params.values(),
        )


class MetadataQualityServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_parent_cannot_read_admin_dashboard(self):
        repository = FakeMetadataQualityRepository(role="parent")
        with self.assertRaises(HTTPException) as caught:
            await MetadataQualityService(repository).dashboard(
                PARENT_ID,
                search=None,
                issue_type=None,
                lifecycle_status=None,
                limit=10,
                offset=0,
            )
        self.assertEqual(caught.exception.status_code, 403)
        self.assertFalse(repository.summary_called)

    async def test_dashboard_classifies_issues_without_mutating_book(self):
        book = SimpleNamespace(
            Id=BOOK_ID,
            Title=" \t\r\n ",
            Author="\n\t",
            MinGrade=5,
            MaxGrade=2,
            LifecycleStatus="ACTIVE",
        )
        repository = FakeMetadataQualityRepository(
            rows=[(book, True)]
        )
        result = await MetadataQualityService(repository).dashboard(
            ADMIN_ID,
            search=None,
            issue_type=None,
            lifecycle_status=None,
            limit=10,
            offset=0,
        )
        self.assertEqual(result.summary.total_books, 8)
        self.assertEqual(result.summary.books_with_issues, 3)
        self.assertEqual(result.summary.possible_duplicate_groups, 1)
        self.assertEqual(
            set(result.items[0].issues),
            {"MISSING_TITLE", "MISSING_AUTHOR", "INVALID_GRADE_RANGE", "POSSIBLE_DUPLICATE"},
        )
        self.assertEqual(book.Title, "   ")
        self.assertEqual(result.total, 1)

    def test_endpoint_requires_authentication(self):
        with make_client() as client:
            response = client.get("/books/admin/metadata-quality")
        self.assertEqual(response.status_code, 401)

    async def test_grade_values_outside_one_to_five_are_invalid(self):
        book = SimpleNamespace(
            Id=BOOK_ID,
            Title="Truyện kiểm thử",
            Author="Tác giả",
            MinGrade=0,
            MaxGrade=6,
            LifecycleStatus="ACTIVE",
        )
        repository = FakeMetadataQualityRepository(rows=[(book, False)])

        result = await MetadataQualityService(repository).dashboard(
            ADMIN_ID,
            search=None,
            issue_type=None,
            lifecycle_status=None,
            limit=10,
            offset=0,
        )

        self.assertEqual(result.items[0].issues, ["INVALID_GRADE_RANGE"])
        self.assertEqual(book.MinGrade, 0)
        self.assertEqual(book.MaxGrade, 6)


if __name__ == "__main__":
    unittest.main()
