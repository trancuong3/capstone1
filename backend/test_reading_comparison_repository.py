"""PostgreSQL query and transaction tests for reading comparison persistence."""

import os
import unittest
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from sqlalchemy.dialects import postgresql

from app.repositories.reading_comparison_repository import ReadingComparisonRepository


SESSION_ID = UUID("10000000-0000-4000-8000-000000000001")
PAGE_ID = UUID("30000000-0000-4000-8000-000000000001")
REVISION_ID = UUID("40000000-0000-4000-8000-000000000001")
class ReadingComparisonRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_final_assessment_serializes_with_retry_and_finish_on_the_same_session(self):
        db = MagicMock(scalar=AsyncMock(return_value=None))
        await ReadingComparisonRepository(db).lock_session(SESSION_ID)
        statement = db.scalar.await_args.args[0]
        query = statement.compile(dialect=postgresql.dialect())
        self.assertIn("FOR UPDATE", str(query))
        self.assertIn(SESSION_ID, query.params.values())
        self.assertTrue(statement.get_execution_options()["populate_existing"])
    async def test_find_exact_scopes_to_session_page_revision_and_transcript(self):
        db = MagicMock()
        db.scalar = AsyncMock(return_value=None)
        repository = ReadingComparisonRepository(db)

        await repository.find_exact(
            SESSION_ID, PAGE_ID, REVISION_ID, "Con mèo"
        )

        statement = db.scalar.await_args.args[0]
        compiled = statement.compile(dialect=postgresql.dialect())
        parameters = list(compiled.params.values())

        self.assertIn("readingcomparisonreports", str(compiled))
        self.assertIn(SESSION_ID, parameters)
        self.assertIn(PAGE_ID, parameters)
        self.assertIn(REVISION_ID, parameters)
        self.assertIn("Con mèo", parameters)

    async def test_create_rolls_back_when_database_commit_fails(self):
        db = MagicMock()
        db.add = MagicMock()
        db.commit = AsyncMock(side_effect=RuntimeError("isolated database failure"))
        db.refresh = AsyncMock()
        db.rollback = AsyncMock()
        repository = ReadingComparisonRepository(db)
        report = MagicMock()

        with self.assertRaisesRegex(RuntimeError, "isolated database failure"):
            await repository.create(report)

        db.add.assert_called_once_with(report)
        db.commit.assert_awaited_once()
        db.refresh.assert_not_awaited()
        db.rollback.assert_awaited_once()

    async def test_delete_rolls_back_when_database_commit_fails(self):
        db = MagicMock()
        db.delete = AsyncMock()
        db.commit = AsyncMock(side_effect=RuntimeError("isolated delete failure"))
        db.rollback = AsyncMock()
        repository = ReadingComparisonRepository(db)
        report = MagicMock()

        with self.assertRaisesRegex(RuntimeError, "isolated delete failure"):
            await repository.delete(report)

        db.delete.assert_awaited_once_with(report)
        db.rollback.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
