"""Real PostgreSQL coverage for the presence-alert repository and service.

Proves what the in-memory tests can only simulate: the unique (session, episode)
index, status-guarded UPDATEs and FOR UPDATE SKIP LOCKED claiming under real
concurrency, plus that the shipped migration SQL applies and enables RLS.

Run with a disposable server, e.g.:
  READING_PRESENCE_TEST_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:5432/postgres
A throw-away database is created and dropped by the test.
"""

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
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.database.session import Base
from app.models import ReadingSession
from app.models.reading_presence import ReadingPresenceAlert, ReadingPresenceSetting
from app.repositories.reading_presence_repository import ReadingPresenceRepository
from app.services.reading_presence_service import PresenceLimits, ReadingPresenceService

BASE_URL = os.getenv("READING_PRESENCE_TEST_DATABASE_URL")
NOW = datetime(2026, 11, 22, 3, 0, tzinfo=timezone.utc)
PARENT = UUID("11111111-1111-4111-8111-111111111111")
OTHER = UUID("99999999-9999-4999-8999-999999999999")
CHILD = UUID("22222222-2222-4222-8222-222222222222")
SESSION = UUID("33333333-3333-4333-8333-333333333333")
LIMITS = PresenceLimits(
    grace_seconds=60, ttl_seconds=300, heartbeat_seconds=30,
    session_cooldown_seconds=1800, max_per_parent_per_day=50, max_send_attempts=3,
)
MIGRATION = (
    Path(__file__).resolve().parent.parent
    / "supabase" / "migrations" / "20261122090000_reading_presence_alerts.sql"
)


class Unverified(Exception):
    pass


def table_closure(*tables):
    """The given tables plus everything they reference through foreign keys."""
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


@unittest.skipUnless(BASE_URL, "Set READING_PRESENCE_TEST_DATABASE_URL for PostgreSQL coverage")
class PresencePostgresTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.database = f"presence_test_{uuid4().hex[:12]}"
        admin = create_async_engine(BASE_URL, poolclass=NullPool, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'CREATE DATABASE "{self.database}"'))
        await admin.dispose()
        self.engine = create_async_engine(with_database(self.database), poolclass=NullPool)
        async with self.engine.begin() as connection:
            needed = table_closure(
                ReadingSession.__table__,
                ReadingPresenceAlert.__table__,
                ReadingPresenceSetting.__table__,
            )
            await connection.run_sync(
                lambda sync: Base.metadata.create_all(sync, tables=needed)
            )
            await connection.execute(text("SET session_replication_role = replica"))
            await connection.execute(text("INSERT INTO profiles (id, role) VALUES (:p, 'PARENT'), (:o, 'PARENT')"), {"p": PARENT, "o": OTHER})
            await connection.execute(text("INSERT INTO childprofiles (id, parentid, alias, grade) VALUES (:c, :p, 'Bé An', 1)"), {"c": CHILD, "p": PARENT})
            await connection.execute(
                text("INSERT INTO readingsessions (id, childid, bookid, state, mode) VALUES (:s, :c, :b, 'LISTENING', 'PAGE')"),
                {"s": SESSION, "c": CHILD, "b": uuid4()},
            )
        self.sessionmaker = async_sessionmaker(self.engine, expire_on_commit=False)

    async def asyncTearDown(self):
        await self.engine.dispose()
        admin = create_async_engine(BASE_URL, poolclass=NullPool, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{self.database}" WITH (FORCE)'))
        await admin.dispose()

    def service(self, session):
        return ReadingPresenceService(ReadingPresenceRepository(session), LIMITS)

    async def arm_one(self, episode=None, now=NOW):
        async with self.sessionmaker() as session:
            service = self.service(session)
            await service.set_email_enabled(PARENT, True, now)
            alert, created = await service.arm(PARENT, SESSION, episode or uuid4(), now)
            return alert.Id, created

    async def test_concurrent_arming_of_one_episode_creates_one_row(self):
        async with self.sessionmaker() as session:
            await self.service(session).set_email_enabled(PARENT, True, NOW)
        episode = uuid4()

        async def arm():
            async with self.sessionmaker() as session:
                return await self.service(session).arm(PARENT, SESSION, episode, NOW)

        results = await asyncio.gather(*[arm() for _ in range(10)], return_exceptions=True)
        failures = [r for r in results if isinstance(r, Exception)]
        self.assertEqual(failures, [])
        self.assertEqual(len({r[0].Id for r in results}), 1)
        async with self.engine.connect() as connection:
            count = await connection.scalar(text("SELECT count(*) FROM readingpresencealerts"))
        self.assertEqual(count, 1)

    async def test_unique_index_rejects_a_duplicate_episode_row(self):
        episode = uuid4()
        await self.arm_one(episode)
        with self.assertRaises(IntegrityError):
            async with self.engine.begin() as connection:
                await connection.execute(
                    text(
                        "INSERT INTO readingpresencealerts (sessionid, parentid, childid, episodeid, dueat, expiresat, lastconfirmedat) "
                        "VALUES (:s, :p, :c, :e, now(), now() + interval '1 min', now())"
                    ),
                    {"s": SESSION, "p": PARENT, "c": CHILD, "e": episode},
                )

    async def test_concurrent_workers_claim_each_due_alert_once_and_send_one_email(self):
        alert_id, _ = await self.arm_one()
        async with self.sessionmaker() as session:
            await self.service(session).confirm(PARENT, alert_id, NOW + timedelta(seconds=55))
        sent: list[dict] = []

        async def resolver(_):
            return "parent@example.test"

        def sender(**kwargs):
            sent.append(kwargs)

        async def worker():
            async with self.sessionmaker() as session:
                return await self.service(session).deliver_due(
                    NOW + timedelta(seconds=61),
                    recipient_resolver=resolver,
                    email_sender=sender,
                    parent_email_unavailable=Unverified,
                )

        delivered = await asyncio.gather(*[worker() for _ in range(6)])
        self.assertEqual(sum(delivered), 1)
        self.assertEqual(len(sent), 1)
        async with self.engine.connect() as connection:
            row = (await connection.execute(text("SELECT status, attempts FROM readingpresencealerts"))).one()
        self.assertEqual((row.status, row.attempts), ("SENT", 1))

    async def test_raw_claim_is_disjoint_across_concurrent_transactions(self):
        for _ in range(4):
            await self.arm_one(now=NOW)
            # separate sessions would hit the per-session cooldown; clear it
            async with self.engine.begin() as connection:
                await connection.execute(text("UPDATE readingpresencealerts SET createdat = createdat - interval '2 hours'"))
        async with self.engine.begin() as connection:
            await connection.execute(text("UPDATE readingpresencealerts SET lastconfirmedat = :t"), {"t": NOW + timedelta(seconds=60)})

        async def claim():
            async with self.sessionmaker() as session:
                rows = await ReadingPresenceRepository(session).claim_due(
                    NOW + timedelta(seconds=61), heartbeat=timedelta(seconds=30), limit=2
                )
                return [row.Id for row in rows]

        groups = await asyncio.gather(*[claim() for _ in range(6)])
        flat = [alert for group in groups for alert in group]
        self.assertEqual(len(flat), len(set(flat)))
        self.assertEqual(len(flat), 4)

    async def test_crashed_worker_is_never_retried_and_expired_alerts_are_not_sent(self):
        alert_id, _ = await self.arm_one()
        async with self.sessionmaker() as session:
            service = self.service(session)
            await service.confirm(PARENT, alert_id, NOW + timedelta(seconds=55))
            claimed = await ReadingPresenceRepository(session).claim_due(
                NOW + timedelta(seconds=61), heartbeat=timedelta(seconds=30)
            )
            self.assertEqual(len(claimed), 1)
        sent: list = []

        async def resolver(_):
            return "parent@example.test"

        async with self.sessionmaker() as session:
            await self.service(session).deliver_due(
                NOW + timedelta(minutes=10), recipient_resolver=resolver,
                email_sender=lambda **kw: sent.append(kw),
            )
        self.assertEqual(sent, [])
        async with self.engine.connect() as connection:
            row = (await connection.execute(text("SELECT status, errorcode FROM readingpresencealerts"))).one()
        self.assertEqual((row.status, row.errorcode), ("FAILED", "UNKNOWN_DELIVERY"))

    async def test_opt_out_session_end_and_foreign_access(self):
        alert_id, _ = await self.arm_one()
        async with self.sessionmaker() as session:
            service = self.service(session)
            from app.services.reading_presence_service import PresenceNotFound
            with self.assertRaises(PresenceNotFound):
                await service.confirm(OTHER, alert_id, NOW)
            with self.assertRaises(PresenceNotFound):
                await service.arm(OTHER, SESSION, uuid4(), NOW)
            await service.set_email_enabled(PARENT, False, NOW)
        async with self.engine.connect() as connection:
            row = (await connection.execute(text("SELECT status, cancelreason FROM readingpresencealerts"))).one()
        self.assertEqual((row.status, row.cancelreason), ("CANCELLED", "OPT_OUT"))

    async def test_settings_default_to_off(self):
        async with self.sessionmaker() as session:
            self.assertFalse(await self.service(session).email_enabled(PARENT))


@unittest.skipUnless(BASE_URL, "Set READING_PRESENCE_TEST_DATABASE_URL for PostgreSQL coverage")
class PresenceMigrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_migration_applies_twice_and_enables_rls(self):
        database = f"presence_mig_{uuid4().hex[:12]}"
        admin = create_async_engine(BASE_URL, poolclass=NullPool, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'CREATE DATABASE "{database}"'))
        engine = create_async_engine(with_database(database), poolclass=NullPool, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as connection:
                for statement in (
                    "CREATE ROLE authenticated NOLOGIN",
                    "CREATE SCHEMA auth",
                    "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ select null::uuid $$",
                    "CREATE TABLE public.profiles (id uuid primary key)",
                    "CREATE TABLE public.childprofiles (id uuid primary key)",
                    "CREATE TABLE public.readingsessions (id uuid primary key)",
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
                rls = (await connection.execute(text(
                    "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('readingpresencesettings','readingpresencealerts') ORDER BY relname"
                ))).all()
                self.assertEqual([(r.relname, r.relrowsecurity) for r in rls], [("readingpresencealerts", True), ("readingpresencesettings", True)])
                unique = await connection.scalar(text(
                    "SELECT count(*) FROM pg_constraint WHERE conname = 'uq_readingpresencealerts_session_episode'"
                ))
                self.assertEqual(unique, 1)
                default = await connection.scalar(text(
                    "SELECT column_default FROM information_schema.columns WHERE table_name='readingpresencesettings' AND column_name='emailenabled'"
                ))
                self.assertEqual(default, "false")
        finally:
            await engine.dispose()
            async with admin.connect() as connection:
                await connection.execute(text(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))
            await admin.dispose()


if __name__ == "__main__":
    unittest.main()
