"""Live PostgreSQL round-trip coverage for reading comparison report persistence.

The CI job supplies an isolated PostgreSQL database. The test creates a unique
schema with the report model's real FK targets, then exercises the actual
SQLAlchemy repository against that database. It does not touch application data.
"""

from __future__ import annotations

import os
import unittest
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from sqlalchemy import text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.reading_comparison_report import ReadingComparisonReport
from app.repositories.reading_comparison_repository import ReadingComparisonRepository


SESSION_ID = UUID("10000000-0000-4000-8000-000000000001")
PAGE_ID = UUID("30000000-0000-4000-8000-000000000001")
REVISION_ID = UUID("40000000-0000-4000-8000-000000000001")
POSTGRES_TEST_DATABASE_URL = os.getenv("READING_REPORT_TEST_DATABASE_URL")


class ReadingComparisonRepositoryTests(unittest.IsolatedAsyncioTestCase):
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


@unittest.skipUnless(
    POSTGRES_TEST_DATABASE_URL,
    "Set READING_REPORT_TEST_DATABASE_URL to run live PostgreSQL persistence coverage",
)
class ReadingComparisonPostgresRoundTripTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.schema = f"reading_report_test_{uuid4().hex}"
        self.admin_engine = create_async_engine(POSTGRES_TEST_DATABASE_URL)
        async with self.admin_engine.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{self.schema}"'))

        self.engine = create_async_engine(
            POSTGRES_TEST_DATABASE_URL,
            connect_args={"server_settings": {"search_path": self.schema}},
        )

        statements = [
            "CREATE TABLE readingsessions (id uuid PRIMARY KEY)",
            "CREATE TABLE bookpages (id uuid PRIMARY KEY)",
            "CREATE TABLE pagerevisions (id uuid PRIMARY KEY)",
            """
            CREATE TABLE readingcomparisonreports (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                sessionid uuid NOT NULL REFERENCES readingsessions(id) ON DELETE CASCADE,
                pageid uuid NOT NULL REFERENCES bookpages(id) ON DELETE RESTRICT,
                pagerevisionid uuid NOT NULL REFERENCES pagerevisions(id) ON DELETE RESTRICT,
                transcript text NOT NULL,
                distance integer NOT NULL,
                alignment jsonb NOT NULL,
                summary jsonb NOT NULL,
                createdat timestamptz NOT NULL DEFAULT now()
            )
            """,
            "CREATE INDEX ix_readingcomparisonreports_sessionid ON readingcomparisonreports(sessionid)",
            "CREATE INDEX ix_readingcomparisonreports_pageid ON readingcomparisonreports(pageid)",
        ]
        async with self.engine.begin() as connection:
            for statement in statements:
                await connection.execute(text(statement))
            await connection.execute(
                text("INSERT INTO readingsessions (id) VALUES (:id)"),
                {"id": SESSION_ID},
            )
            await connection.execute(
                text("INSERT INTO bookpages (id) VALUES (:id)"),
                {"id": PAGE_ID},
            )
            await connection.execute(
                text("INSERT INTO pagerevisions (id) VALUES (:id)"),
                {"id": REVISION_ID},
            )

        self.session_factory = async_sessionmaker(
            self.engine,
            expire_on_commit=False,
        )

    async def asyncTearDown(self):
        await self.engine.dispose()
        async with self.admin_engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA IF EXISTS "{self.schema}" CASCADE'))
        await self.admin_engine.dispose()

    async def test_report_is_inserted_read_back_and_deleted_without_deleting_session(self):
        alignment = [
            {
                "book_word": "Con",
                "spoken_word": "Con",
                "book_index": 0,
                "spoken_index": 0,
                "status": "MATCH",
            }
        ]
        summary = {
            "missing_words": [],
            "extra_words": [],
            "substitutions": [],
            "repeated_count": 0,
            "repeated_words": [],
            "hesitations": [],
            "hesitation_seconds": None,
        }
        report = ReadingComparisonReport(
            SessionId=SESSION_ID,
            PageId=PAGE_ID,
            PageRevisionId=REVISION_ID,
            Transcript="Con mèo đang ngủ.",
            Distance=0,
            Alignment=alignment,
            Summary=summary,
        )

        async with self.session_factory() as db:
            repository = ReadingComparisonRepository(db)
            persisted = await repository.create(report)
            self.assertIsNotNone(persisted.Id)
            self.assertIsNotNone(persisted.CreatedAt)

        async with self.session_factory() as db:
            repository = ReadingComparisonRepository(db)
            found = await repository.find_exact(
                SESSION_ID,
                PAGE_ID,
                REVISION_ID,
                "Con mèo đang ngủ.",
            )
            listed = await repository.list_for_session(SESSION_ID)

            self.assertIsNotNone(found)
            self.assertEqual(found.Id, persisted.Id)
            self.assertEqual(found.SessionId, SESSION_ID)
            self.assertEqual(found.PageId, PAGE_ID)
            self.assertEqual(found.PageRevisionId, REVISION_ID)
            self.assertEqual(found.Transcript, "Con mèo đang ngủ.")
            self.assertEqual(found.Alignment, alignment)
            self.assertEqual(found.Summary, summary)
            self.assertEqual(len(listed), 1)

            await repository.delete(found)
            self.assertEqual(await repository.list_for_session(SESSION_ID), [])

            session_exists = await db.scalar(
                text("SELECT EXISTS (SELECT 1 FROM readingsessions WHERE id = :id)"),
                {"id": SESSION_ID},
            )
            self.assertTrue(session_exists)


if __name__ == "__main__":
    unittest.main()
