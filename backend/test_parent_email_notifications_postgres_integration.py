"""Real PostgreSQL coverage for parent email notification tables, RLS, and repository.

Runs automatically in CI's PostgreSQL 16 job via READING_REPORT_TEST_DATABASE_URL
(or PARENT_EMAIL_TEST_DATABASE_URL). Mirrors test_reading_presence_postgres_integration.py.
"""

from __future__ import annotations

import asyncio
import os
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.database.session import Base
from app.models import (
    FluencyAssessment,
    PageRevisionWord,
    ReadingComparisonReport,
    ReadingEvent,
    ReadingGoal,
    ReadingSession,
)
from app.models.parent_email_notification import (
    ParentEmailDelivery,
    ParentEmailPreference,
)
from app.repositories.parent_email_notification_repository import (
    ParentEmailNotificationRepository,
)

BASE_URL = (
    os.getenv("PARENT_EMAIL_TEST_DATABASE_URL")
    or os.getenv("READING_REPORT_TEST_DATABASE_URL")
)
NOW = datetime(2026, 11, 29, 2, 0, tzinfo=timezone.utc)
MIGRATION = (
    Path(__file__).resolve().parent.parent
    / "supabase"
    / "migrations"
    / "20261126120000_parent_email_notifications.sql"
)


def table_closure(*tables):
    seen: set = set()
    pending = list(tables)
    while pending:
        table = pending.pop()
        if table in seen:
            continue
        seen.add(table)
        pending.extend(fk.column.table for fk in table.foreign_keys)
    return list(seen)


def with_database(name: str) -> str:
    return BASE_URL.rsplit("/", 1)[0] + "/" + name


@unittest.skipUnless(
    BASE_URL, "Set PARENT_EMAIL_TEST_DATABASE_URL for PostgreSQL coverage"
)
class ParentEmailPostgresTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.database = f"parent_email_test_{uuid4().hex[:12]}"
        admin = create_async_engine(
            BASE_URL, poolclass=NullPool, isolation_level="AUTOCOMMIT"
        )
        async with admin.connect() as connection:
            await connection.execute(text(f'CREATE DATABASE "{self.database}"'))
        await admin.dispose()
        self.engine = create_async_engine(
            with_database(self.database), poolclass=NullPool
        )
        async with self.engine.begin() as connection:
            needed = table_closure(
                ParentEmailPreference.__table__,
                ParentEmailDelivery.__table__,
                ReadingSession.__table__,
                ReadingComparisonReport.__table__,
                FluencyAssessment.__table__,
                ReadingEvent.__table__,
                PageRevisionWord.__table__,
                ReadingGoal.__table__,
            )
            await connection.run_sync(
                lambda sync: Base.metadata.create_all(sync, tables=needed)
            )
        self.sessionmaker = async_sessionmaker(self.engine, expire_on_commit=False)

    async def asyncTearDown(self):
        await self.engine.dispose()
        admin = create_async_engine(
            BASE_URL, poolclass=NullPool, isolation_level="AUTOCOMMIT"
        )
        async with admin.connect() as connection:
            await connection.execute(
                text(f'DROP DATABASE IF EXISTS "{self.database}" WITH (FORCE)')
            )
        await admin.dispose()

    async def test_preferences_upsert_and_concurrent_claim_or_retry_and_pagination(self):
        p1, p2, p3, p_childless = uuid4(), uuid4(), uuid4(), uuid4()
        c1, c2, c3 = uuid4(), uuid4(), uuid4()
        async with self.engine.begin() as conn:
            await conn.execute(text("SET session_replication_role = replica"))
            for idx, pid in enumerate((p_childless, p1, p2, p3)):
                await conn.execute(
                    text(
                        "INSERT INTO profiles (id, role, displayname, active, createdat) "
                        "VALUES (:id, 'parent', :name, 1, :created)"
                    ),
                    {
                        "id": pid,
                        "name": f"Parent {idx}",
                        "created": NOW - timedelta(days=10 - idx),
                    },
                )
            for cid, pid, alias in ((c1, p1, "Bé An"), (c2, p2, "Bé Bo"), (c3, p3, "Bé Chi")):
                await conn.execute(
                    text(
                        "INSERT INTO childprofiles (id, parentid, alias, grade) "
                        "VALUES (:cid, :pid, :alias, 1)"
                    ),
                    {"cid": cid, "pid": pid, "alias": alias},
                )

        async with self.sessionmaker() as session:
            repo = ParentEmailNotificationRepository(session)
            self.assertTrue(await repo.is_storage_ready())
            saved = await repo.upsert_preferences(
                p1, {"WeeklyDigestEnabled": False, "InactivityDays": 7}, NOW
            )
            self.assertFalse(saved.WeeklyDigestEnabled)
            self.assertEqual(saved.InactivityDays, 7)

            updated = await repo.upsert_preferences(
                p1, {"InactivityDays": 10}, NOW + timedelta(minutes=1)
            )
            self.assertFalse(updated.WeeklyDigestEnabled)
            self.assertEqual(updated.InactivityDays, 10)

            page1 = await repo.list_active_parents_with_children(limit=2)
            self.assertEqual([b.parent_id for b in page1], [p1, p2])
            page2 = await repo.list_active_parents_with_children(
                limit=2,
                after_created_at=page1[-1].created_at,
                after_id=page1[-1].parent_id,
            )
            self.assertEqual([b.parent_id for b in page2], [p3])

        # Concurrent claims for same dedupe_key: exactly 1 succeeds
        dedupe = f"weekly_digest:{p1}:2026-W48"

        async def try_claim():
            async with self.sessionmaker() as session:
                return await ParentEmailNotificationRepository(
                    session
                ).claim_or_retry_delivery(
                    parent_id=p1,
                    child_id=None,
                    category="WEEKLY_DIGEST",
                    dedupe_key=dedupe,
                    subject="Weekly",
                    metadata={"week": "2026-W48"},
                    now=NOW,
                )

        claims = await asyncio.gather(*[try_claim() for _ in range(6)])
        winners = [c for c in claims if c is not None]
        self.assertEqual(len(winners), 1)

        # Mark RETRY -> concurrent re-claim after NextAttemptAt: exactly 1 succeeds
        async with self.sessionmaker() as session:
            await ParentEmailNotificationRepository(session).finish_delivery(
                winners[0].Id,
                status="RETRY",
                now=NOW,
                error_code="EMAIL_PROVIDER_UNAVAILABLE",
                next_attempt_at=NOW + timedelta(minutes=15),
            )

        async def try_reclaim(at_time: datetime):
            async with self.sessionmaker() as session:
                return await ParentEmailNotificationRepository(
                    session
                ).claim_or_retry_delivery(
                    parent_id=p1,
                    child_id=None,
                    category="WEEKLY_DIGEST",
                    dedupe_key=dedupe,
                    subject="Weekly",
                    metadata={"week": "2026-W48"},
                    now=at_time,
                )

        early = await try_reclaim(NOW + timedelta(minutes=5))
        self.assertIsNone(early)
        retry_claims = await asyncio.gather(
            *[try_reclaim(NOW + timedelta(minutes=20)) for _ in range(4)]
        )
        retry_winners = [c for c in retry_claims if c is not None]
        self.assertEqual(len(retry_winners), 1)
        self.assertEqual(retry_winners[0].Attempts, 2)

    async def test_snapshot_reads_comparison_reports_and_word_retry_statuses(self):
        import json

        child_id = uuid4()
        session_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        rev_id = uuid4()
        word_failed = uuid4()
        word_uncertain = uuid4()
        word_confirmed = uuid4()
        word_dismissed = uuid4()

        async with self.engine.begin() as conn:
            await conn.execute(text("SET session_replication_role = replica"))
            await conn.execute(
                text(
                    "INSERT INTO childprofiles (id, parentid, alias, grade) "
                    "VALUES (:cid, :pid, 'Bé An', 1)"
                ),
                {"cid": child_id, "pid": uuid4()},
            )
            await conn.execute(
                text(
                    "INSERT INTO readingsessions (id, childid, bookid, state, mode, startedat, endedat) "
                    "VALUES (:sid, :cid, :bid, 'COMPLETED', 'NORMAL', :started, :ended)"
                ),
                {
                    "sid": session_id,
                    "cid": child_id,
                    "bid": book_id,
                    "started": NOW - timedelta(hours=3),
                    "ended": NOW - timedelta(hours=2, minutes=50),
                },
            )
            for wid, idx, word_text in (
                (word_failed, 0, "nghiêng"),
                (word_uncertain, 1, "khúc"),
                (word_confirmed, 2, "đúng"),
                (word_dismissed, 3, "bỏqua"),
            ):
                await conn.execute(
                    text(
                        "INSERT INTO pagerevisionwords (id, pagerevisionid, wordindex, text) "
                        "VALUES (:wid, :rid, :idx, :txt)"
                    ),
                    {"wid": wid, "rid": rev_id, "idx": idx, "txt": word_text},
                )
            for wid, ev_type, ev_status in (
                (word_failed, "WORD_RETRY", "FAILED"),
                (word_uncertain, "WORD_RETRY", "UNCERTAIN"),
                (word_confirmed, "WORD_RETRY", "CONFIRMED"),
                (word_dismissed, "MISPRONUNCIATION", "DISMISSED"),
            ):
                await conn.execute(
                    text(
                        "INSERT INTO readingevents "
                        "(id, sessionid, pageid, pagerevisionid, wordid, type, startms, status, createdat) "
                        "VALUES (:eid, :sid, :pid, :rid, :wid, :etype, 0, :estatus, :created)"
                    ),
                    {
                        "eid": uuid4(),
                        "sid": session_id,
                        "pid": page_id,
                        "rid": rev_id,
                        "wid": wid,
                        "etype": ev_type,
                        "estatus": ev_status,
                        "created": NOW - timedelta(hours=2, minutes=55),
                    },
                )
            summary_payload = {
                "assessment_version": 1,
                "initial_assessment": [
                    {"word_id": str(word_failed), "word_index": 0, "text": "nghiêng", "status": "MISPRONUNCIATION"},
                    {"word_id": str(word_uncertain), "word_index": 1, "text": "khúc", "status": "CORRECT"},
                    {"word_id": str(word_confirmed), "word_index": 2, "text": "đúng", "status": "CORRECT"},
                    {"word_id": str(word_dismissed), "word_index": 3, "text": "bỏqua", "status": "CORRECT"},
                ],
            }
            await conn.execute(
                text(
                    "INSERT INTO readingcomparisonreports "
                    "(id, sessionid, pageid, pagerevisionid, transcript, distance, alignment, summary, createdat) "
                    "VALUES (:id, :sid, :pid, :rid, '', 1, CAST(:alignment AS jsonb), CAST(:summary AS jsonb), :created)"
                ),
                {
                    "id": uuid4(),
                    "sid": session_id,
                    "pid": page_id,
                    "rid": rev_id,
                    "alignment": "[]",
                    "summary": json.dumps(summary_payload),
                    "created": NOW - timedelta(hours=2, minutes=52),
                },
            )

        async with self.sessionmaker() as session:
            repo = ParentEmailNotificationRepository(session)
            from types import SimpleNamespace

            snap = await repo.get_child_activity_snapshot(
                SimpleNamespace(Id=child_id, Alias="Bé An"), NOW
            )
            self.assertEqual(snap.avg_fluency_last_7d, 75.0)
            self.assertEqual(snap.top_difficult_words_last_7d, ("nghiêng", "khúc"))


@unittest.skipUnless(
    BASE_URL, "Set PARENT_EMAIL_TEST_DATABASE_URL for PostgreSQL coverage"
)
class ParentEmailMigrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_migration_applies_twice_idempotently_and_enables_rls(self):
        database = f"parent_email_mig_{uuid4().hex[:12]}"
        admin = create_async_engine(
            BASE_URL, poolclass=NullPool, isolation_level="AUTOCOMMIT"
        )
        async with admin.connect() as connection:
            await connection.execute(text(f'CREATE DATABASE "{database}"'))
        engine = create_async_engine(
            with_database(database), poolclass=NullPool, isolation_level="AUTOCOMMIT"
        )
        try:
            async with engine.connect() as connection:
                for statement in (
                    "CREATE ROLE authenticated NOLOGIN",
                    "CREATE SCHEMA auth",
                    "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ select null::uuid $$",
                    "CREATE TABLE public.profiles (id uuid primary key)",
                    "CREATE TABLE public.childprofiles (id uuid primary key)",
                ):
                    try:
                        await connection.execute(text(statement))
                    except Exception:
                        if "ROLE" not in statement:
                            raise
                sql = MIGRATION.read_text(encoding="utf-8")
                raw = await connection.get_raw_connection()
                await raw.driver_connection.execute(sql)
                await raw.driver_connection.execute(sql)  # idempotent
                rls = (
                    await connection.execute(
                        text(
                            "SELECT relname, relrowsecurity FROM pg_class "
                            "WHERE relname IN ('parentemailpreferences','parentemaildeliveries') "
                            "ORDER BY relname"
                        )
                    )
                ).all()
                self.assertEqual(
                    [(r.relname, r.relrowsecurity) for r in rls],
                    [
                        ("parentemaildeliveries", True),
                        ("parentemailpreferences", True),
                    ],
                )
                unique = await connection.scalar(
                    text(
                        "SELECT count(*) FROM pg_constraint "
                        "WHERE conname = 'uq_parentemaildeliveries_dedupekey'"
                    )
                )
                self.assertEqual(unique, 1)
        finally:
            await engine.dispose()
            async with admin.connect() as connection:
                await connection.execute(
                    text(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
                )
            await admin.dispose()


if __name__ == "__main__":
    unittest.main()
