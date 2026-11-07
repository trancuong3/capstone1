"""PostgreSQL-backed transaction tests for Parent book-content reports.

The integration tests use a dedicated random schema in the CI PostgreSQL service.
They never connect to an application or production database URL.
"""
from __future__ import annotations

import asyncio
import os
import unittest
from types import SimpleNamespace
from uuid import uuid4

TEST_DATABASE_URL = os.getenv("BOOK_CONTENT_QUALITY_TEST_DATABASE_URL")
os.environ.setdefault(
    "DATABASE_URL",
    TEST_DATABASE_URL or "postgresql+asyncpg://test:test@127.0.0.1:1/test",
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException
from sqlalchemy import event, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from starlette.requests import Request

from app.database.integrity import (
    is_book_report_idempotency_violation,
    postgres_integrity_error_metadata,
)
from app.models import Book, BookPage, PageRevision, Profile
from app.models.book_content_quality import (
    BookContentReport,
    BookContentReportHistory,
    BookQualityFinding,
    BookQualityPageScan,
    BookQualityReportFinding,
    BookQualityScanRun,
)
from app.repositories.book_content_quality_repository import (
    BookContentQualityRepository,
)
from app.schemas.book_content_quality import BookContentReportCreate
from app.services.book_content_quality_service import BookContentQualityService

PARENT_ID = uuid4()
BOOK_ID = uuid4()


def report_payload(*, idempotency_key=None, issue_type="SPELLING_ERROR", page_id=None):
    return BookContentReportCreate(
        idempotency_key=idempotency_key or uuid4(),
        issue_type=issue_type,
        description="Phụ huynh báo nội dung trang sách cần kiểm tra.",
        page_id=page_id,
        reported_text="trời mua",
        suggested_correction="trời mưa",
    )


@unittest.skipUnless(
    TEST_DATABASE_URL,
    "Set BOOK_CONTENT_QUALITY_TEST_DATABASE_URL to an isolated PostgreSQL test database",
)
class ParentBookContentQualityPostgresTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.schema = f"viread_bcq_test_{uuid4().hex}"
        self.admin_engine = create_async_engine(
            TEST_DATABASE_URL,
            poolclass=NullPool,
        )
        async with self.admin_engine.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{self.schema}"'))

        self.engine = create_async_engine(
            TEST_DATABASE_URL,
            poolclass=NullPool,
            connect_args={
                "server_settings": {"search_path": self.schema},
                "statement_cache_size": 0,
            },
        )
        self.sessions = async_sessionmaker(
            self.engine,
            expire_on_commit=False,
        )

        async with self.engine.begin() as connection:
            # Minimal referenced application tables, isolated from public schema.
            await connection.execute(text("""
                CREATE TABLE profiles (
                    id uuid PRIMARY KEY,
                    role varchar NOT NULL,
                    displayname varchar,
                    contact_phone varchar,
                    avatar_path varchar,
                    createdat timestamptz NOT NULL DEFAULT now(),
                    active smallint NOT NULL DEFAULT 1
                )
            """))
            await connection.execute(text("""
                CREATE TABLE books (
                    id uuid PRIMARY KEY,
                    name varchar,
                    title varchar NOT NULL,
                    author varchar,
                    mingrade smallint NOT NULL,
                    maxgrade smallint NOT NULL,
                    lifecyclestatus varchar NOT NULL,
                    createdby uuid REFERENCES profiles(id) ON DELETE SET NULL,
                    createdat timestamptz NOT NULL DEFAULT now()
                )
            """))
            await connection.execute(text("""
                CREATE TABLE bookpages (
                    id uuid PRIMARY KEY,
                    bookid uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    pagenumber smallint NOT NULL,
                    imagepath varchar NOT NULL,
                    width smallint NOT NULL,
                    height smallint NOT NULL,
                    featurepath varchar,
                    processingmeta jsonb NOT NULL DEFAULT '{}'::jsonb,
                    currentverifiedrevisionid uuid,
                    lifecyclestatus varchar NOT NULL,
                    createdat timestamptz NOT NULL DEFAULT now()
                )
            """))
            await connection.execute(text("""
                CREATE TABLE pagerevisions (
                    id uuid PRIMARY KEY,
                    pageid uuid NOT NULL REFERENCES bookpages(id) ON DELETE CASCADE,
                    revisionno varchar NOT NULL,
                    verificationstatus varchar NOT NULL,
                    verifiedtext varchar,
                    drafttext varchar,
                    contenthash varchar NOT NULL,
                    processingmeta jsonb NOT NULL DEFAULT '{}'::jsonb,
                    verifiedby uuid REFERENCES profiles(id) ON DELETE SET NULL,
                    verifiedat timestamptz,
                    createdat timestamptz NOT NULL DEFAULT now()
                )
            """))
            await connection.execute(text("""
                ALTER TABLE bookpages
                ADD CONSTRAINT fk_bookpages_currentverifiedrevisionid
                FOREIGN KEY (currentverifiedrevisionid)
                REFERENCES pagerevisions(id) ON DELETE SET NULL
            """))

            # Use the real SQLAlchemy table definitions and real PostgreSQL FKs,
            # UNIQUE constraints and CHECK constraints for the feature tables.
            tables = (
                BookQualityScanRun.__table__,
                BookContentReport.__table__,
                BookQualityPageScan.__table__,
                BookQualityFinding.__table__,
                BookQualityReportFinding.__table__,
                BookContentReportHistory.__table__,
            )
            for table in tables:
                await connection.run_sync(
                    lambda sync_connection, table=table: table.create(
                        sync_connection
                    )
                )

        async with self.sessions() as session:
            async with session.begin():
                session.add(
                    Profile(
                        Id=PARENT_ID,
                        Role="parent",
                        DisplayName="Phụ huynh kiểm thử",
                        Active=1,
                    )
                )
                session.add(
                    Book(
                        Id=BOOK_ID,
                        Title="Sách kiểm thử chất lượng",
                        MinGrade=1,
                        MaxGrade=5,
                        LifecycleStatus="ACTIVE",
                    )
                )

    async def asyncTearDown(self):
        await self.engine.dispose()
        async with self.admin_engine.begin() as connection:
            await connection.execute(
                text(f'DROP SCHEMA IF EXISTS "{self.schema}" CASCADE')
            )
        await self.admin_engine.dispose()

    async def _create_report(self, payload):
        async with self.sessions() as session:
            repository = BookContentQualityRepository(session)
            return await BookContentQualityService(repository).create_parent_report(
                PARENT_ID,
                BOOK_ID,
                payload,
            )

    async def _count(self, model):
        async with self.sessions() as session:
            value = await session.scalar(
                select(func.count()).select_from(model)
            )
            return int(value or 0)

    async def test_parent_report_writes_in_fk_order_and_commits_atomically(self):
        inserted_tables = []

        def capture_insert(_connection, _cursor, statement, _parameters, _context, _many):
            normalized = statement.lower()
            for table in (
                "bookqualityscanruns",
                "bookcontentreports",
                "bookcontentreporthistory",
            ):
                if f"insert into {table}" in normalized:
                    inserted_tables.append(table)

        event.listen(
            self.engine.sync_engine,
            "before_cursor_execute",
            capture_insert,
        )
        try:
            result = await self._create_report(report_payload())
        finally:
            event.remove(
                self.engine.sync_engine,
                "before_cursor_execute",
                capture_insert,
            )

        self.assertEqual(
            inserted_tables,
            [
                "bookqualityscanruns",
                "bookcontentreports",
                "bookcontentreporthistory",
            ],
        )
        self.assertEqual(result.status, "OPEN")
        self.assertEqual(len(result.history), 1)
        self.assertEqual(await self._count(BookQualityScanRun), 1)
        self.assertEqual(await self._count(BookContentReport), 1)
        self.assertEqual(await self._count(BookContentReportHistory), 1)

        async with self.sessions() as session:
            stored_report = await session.get(BookContentReport, result.id)
            stored_history = await session.scalar(
                select(BookContentReportHistory).where(
                    BookContentReportHistory.ReportId == result.id
                )
            )
            self.assertIsNotNone(stored_report)
            self.assertIsNotNone(
                await session.get(BookQualityScanRun, stored_report.ScanRunId)
            )
            self.assertEqual(stored_history.ReportId, stored_report.Id)

    async def test_queued_and_running_scans_are_reused_without_creating_another(self):
        first = await self._create_report(report_payload())
        queued_reuse = await self._create_report(report_payload())
        self.assertEqual(queued_reuse.scan_run_id, first.scan_run_id)

        async with self.sessions() as session:
            await session.execute(
                update(BookQualityScanRun)
                .where(BookQualityScanRun.Id == first.scan_run_id)
                .values(Status="RUNNING")
            )
            await session.commit()

        running_reuse = await self._create_report(report_payload())
        self.assertEqual(running_reuse.scan_run_id, first.scan_run_id)
        self.assertEqual(await self._count(BookQualityScanRun), 1)
        self.assertEqual(await self._count(BookContentReport), 3)
        self.assertEqual(await self._count(BookContentReportHistory), 3)

    async def _seed_page(self, *, verification_status="VERIFIED"):
        page_id = uuid4()
        revision_id = uuid4()
        async with self.sessions() as session:
            page = BookPage(
                Id=page_id,
                BookId=BOOK_ID,
                PageNumber=4,
                ImagePath="book-pages/test-page.png",
                Width=1200,
                Height=1800,
                LifecycleStatus="ACTIVE",
            )
            session.add(page)
            await session.flush([page])

            revision = PageRevision(
                Id=revision_id,
                PageId=page_id,
                RevisionNo="V1",
                VerificationStatus=verification_status,
                VerifiedText="Bé đang đọc một câu chuyện hay.",
                DraftText="Bản OCR nháp không được dùng làm snapshot.",
                ContentHash="verified-content-hash-v1",
            )
            session.add(revision)
            await session.flush([revision])

            page.CurrentVerifiedRevisionId = revision_id
            await session.commit()
        return page_id, revision_id

    async def test_page_report_preserves_only_the_current_verified_revision_snapshot(self):
        page_id, revision_id = await self._seed_page()
        result = await self._create_report(
            report_payload(page_id=page_id)
        )

        self.assertEqual(result.page_id, page_id)
        self.assertEqual(result.page_number, 4)
        self.assertEqual(result.page_revision_id, revision_id)
        self.assertEqual(
            result.verified_text_snapshot,
            "Bé đang đọc một câu chuyện hay.",
        )
        self.assertEqual(
            result.content_hash_snapshot,
            "verified-content-hash-v1",
        )

    async def test_page_report_rejects_unverified_revision_before_writing(self):
        page_id, _revision_id = await self._seed_page(
            verification_status="DRAFT"
        )

        with self.assertRaises(HTTPException) as caught:
            await self._create_report(report_payload(page_id=page_id))

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(await self._count(BookQualityScanRun), 0)
        self.assertEqual(await self._count(BookContentReport), 0)
        self.assertEqual(await self._count(BookContentReportHistory), 0)

    async def test_same_idempotency_key_returns_one_report_for_concurrent_requests(self):
        key = uuid4()
        results = await asyncio.gather(
            self._create_report(report_payload(idempotency_key=key)),
            self._create_report(report_payload(idempotency_key=key)),
        )
        self.assertEqual(results[0].id, results[1].id)
        self.assertEqual(await self._count(BookQualityScanRun), 1)
        self.assertEqual(await self._count(BookContentReport), 1)
        self.assertEqual(await self._count(BookContentReportHistory), 1)

    async def test_check_constraint_failure_rolls_back_scan_report_and_history(self):
        invalid_payload = BookContentReportCreate.model_construct(
            idempotency_key=uuid4(),
            issue_type="NOT_A_VALID_ISSUE",
            description="Valid description for a database constraint test.",
            page_id=None,
            reported_text=None,
            suggested_correction=None,
        )
        with self.assertRaises(IntegrityError) as caught:
            await self._create_report(invalid_payload)

        metadata = postgres_integrity_error_metadata(caught.exception)
        self.assertEqual(metadata.get("sqlstate"), "23514")
        self.assertEqual(
            metadata.get("constraint_name"),
            "ck_bookcontentreports_issue_type",
        )
        self.assertEqual(await self._count(BookQualityScanRun), 0)
        self.assertEqual(await self._count(BookContentReport), 0)
        self.assertEqual(await self._count(BookContentReportHistory), 0)

    async def test_foreign_key_violation_exposes_constraint_metadata_and_rolls_back(self):
        async with self.sessions() as session:
            repository = BookContentQualityRepository(session)
            invalid_run = BookQualityScanRun(
                Id=uuid4(),
                BookId=uuid4(),
                BookTitleSnapshot="Invalid FK test",
                TriggerType="PARENT_REPORT",
                Status="QUEUED",
            )
            with self.assertRaises(IntegrityError) as caught:
                await repository.add_scan_run(invalid_run)
            metadata = postgres_integrity_error_metadata(caught.exception)
            await repository.rollback()

        self.assertEqual(metadata.get("sqlstate"), "23503")
        self.assertEqual(metadata.get("table_name"), "bookqualityscanruns")
        self.assertEqual(
            metadata.get("constraint_name"),
            "bookqualityscanruns_bookid_fkey",
        )
        self.assertEqual(await self._count(BookQualityScanRun), 0)

    async def test_only_the_report_idempotency_constraint_is_treated_as_duplicate(self):
        class FakePostgresError(Exception):
            sqlstate = "23505"
            constraint_name = "uq_bookcontentreports_reporter_idempotency"

        matching = IntegrityError(
            "private SQL text",
            {"private_parameter": "private report body"},
            FakePostgresError("private database message"),
        )
        self.assertTrue(is_book_report_idempotency_violation(matching))

        class UnrelatedUniqueError(Exception):
            sqlstate = "23505"
            constraint_name = "another_unique_constraint"

        unrelated = IntegrityError(
            "private SQL text",
            {"private_parameter": "private report body"},
            UnrelatedUniqueError("private database message"),
        )
        self.assertFalse(is_book_report_idempotency_violation(unrelated))

    async def test_integrity_handler_logs_safe_metadata_without_sql_or_report_text(self):
        from app.sever import database_api_exception_handler

        secret = "private-parent-report-description-DO-NOT-LOG"

        class FakePostgresError(Exception):
            sqlstate = "23503"
            constraint_name = "bookcontentreports_bookid_fkey"
            table_name = "bookcontentreports"
            column_name = "bookid"

        error = IntegrityError(
            "INSERT INTO bookcontentreports VALUES (:private)",
            {"description": secret},
            FakePostgresError(secret),
        )
        request = Request({
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/catalog/00000000-0000-4000-8000-000000000001/reports",
            "raw_path": b"/catalog/00000000-0000-4000-8000-000000000001/reports",
            "query_string": b"",
            "headers": [],
            "server": ("test", 80),
            "client": ("127.0.0.1", 12345),
            "state": {"request_id": "test-integrity-request"},
            "route": SimpleNamespace(path="/catalog/{book_id}/reports"),
        })

        with self.assertLogs("app.sever", level="ERROR") as captured:
            response = await database_api_exception_handler(request, error)

        output = "\n".join(captured.output)
        body = response.body.decode("utf-8")
        self.assertEqual(response.status_code, 500)
        self.assertIn("database_integrity_violation", output)
        self.assertIn('"sqlstate":"23503"', output)
        self.assertIn('"constraint_name":"bookcontentreports_bookid_fkey"', output)
        self.assertIn('"route":"/catalog/{book_id}/reports"', output)
        self.assertNotIn(secret, output)
        self.assertNotIn(secret, body)
        self.assertNotIn("private SQL text", output)
        self.assertNotIn("private SQL text", body)


if __name__ == "__main__":
    unittest.main()
