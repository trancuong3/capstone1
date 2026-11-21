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
from unittest.mock import patch
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
class PresenceDbCase(unittest.IsolatedAsyncioTestCase):
    """Throw-away database, schema and fixtures shared by the PostgreSQL tests."""

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

@unittest.skipUnless(BASE_URL, "Set READING_PRESENCE_TEST_DATABASE_URL for PostgreSQL coverage")
class PresencePostgresTests(PresenceDbCase):
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
class PresenceHttpEndToEndTests(PresenceDbCase):
    """HTTP -> FastAPI -> PostgreSQL -> worker -> real e-mail builder -> file mail sink.

    Only two things are substituted: the Supabase login (dependency override) and
    the verified-address lookup (the sink receives the address the resolver
    returns, never one supplied by the client).
    """

    async def asyncSetUp(self):
        await super().asyncSetUp()
        import tempfile

        import httpx
        from fastapi import FastAPI

        from app.api import deps
        from app.api.router import api_router
        from app.api.routes import reading_presence as route

        self.clock = [NOW]
        self.actor = [PARENT]
        self.sink = tempfile.TemporaryDirectory()
        app = FastAPI()
        app.include_router(api_router)

        async def override_db():
            async with self.sessionmaker() as session:
                yield session

        app.dependency_overrides[deps.get_db] = override_db
        app.dependency_overrides[deps.get_current_parent_id] = lambda: self.actor[0]
        self.patches = [
            patch.object(route, "utcnow", lambda: self.clock[0]),
            patch(
                "app.providers.reading_presence_email_provider.READING_PRESENCE_MAIL_SINK_DIR",
                self.sink.name,
            ),
        ]
        for patcher in self.patches:
            patcher.start()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        for patcher in self.patches:
            patcher.stop()
        self.sink.cleanup()
        await super().asyncTearDown()

    def advance(self, seconds: int):
        self.clock[0] = self.clock[0] + timedelta(seconds=seconds)

    async def run_worker(self, resolver=None):
        from app.providers.reading_presence_email_provider import send_presence_email

        async def verified(_parent):
            return "parent@example.test"

        async with self.sessionmaker() as session:
            return await self.service(session).deliver_due(
                self.clock[0],
                recipient_resolver=resolver or verified,
                email_sender=send_presence_email,
                parent_email_unavailable=Unverified,
            )

    def mails(self):
        return sorted(Path(self.sink.name).glob("*.eml"))

    async def opt_in(self):
        response = await self.client.put(
            "/reading-presence/settings", json={"email_enabled": True}
        )
        self.assertEqual(response.json(), {"email_enabled": True})

    async def arm(self, episode=None):
        return await self.client.post(
            "/reading-presence/alerts",
            json={"session_id": str(SESSION), "episode_id": str(episode or uuid4())},
        )

    async def test_off_by_default_arming_is_refused_and_nothing_is_sent(self):
        self.assertEqual(
            (await self.client.get("/reading-presence/settings")).json(),
            {"email_enabled": False},
        )
        refused = await self.arm()
        self.assertEqual((refused.status_code, refused.json()["detail"]), (409, {"code": "PRESENCE_ALERT_DISABLED"}))
        self.advance(120)
        self.assertEqual(await self.run_worker(), 0)
        self.assertEqual(self.mails(), [])

    async def test_opted_in_absence_sends_exactly_one_neutral_email(self):
        from email import message_from_bytes, policy

        await self.opt_in()
        episode = uuid4()
        first = await self.arm(episode)
        self.assertEqual(first.status_code, 201)
        alert_id = first.json()["id"]
        # Refresh, retry and a second device must all land on the same alert.
        for _ in range(3):
            again = await self.arm(episode)
            self.assertEqual(again.json()["id"], alert_id)
        self.advance(30)
        self.assertEqual((await self.client.post(f"/reading-presence/alerts/{alert_id}/confirm")).status_code, 200)
        self.advance(25)
        await self.client.post(f"/reading-presence/alerts/{alert_id}/confirm")
        self.advance(6)  # 61 s after arming: due
        delivered = await asyncio.gather(self.run_worker(), self.run_worker())
        self.assertEqual(sorted(delivered), [0, 1])
        self.assertEqual(await self.run_worker(), 0)
        files = self.mails()
        self.assertEqual(len(files), 1)
        message = message_from_bytes(files[0].read_bytes(), policy=policy.default)
        body = message.get_content()
        self.assertEqual(message["To"], "parent@example.test")
        self.assertEqual(message["Subject"], "ViRead đã tạm dừng buổi đọc")
        self.assertIn("một lúc không thấy người đọc trong khung hình", body)
        for forbidden in ("transcript", "nguy hiểm", "ở đâu", "ảnh", "ghi âm"):
            self.assertNotIn(forbidden, body.lower())
        stored = (await self.client.post(f"/reading-presence/alerts/{alert_id}/cancel", json={"reason": "RETURNED"})).json()
        self.assertEqual(stored["status"], "SENT")  # too late to cancel: already sent once

    async def test_returning_before_the_time_cancels_and_nothing_is_sent(self):
        await self.opt_in()
        alert_id = (await self.arm()).json()["id"]
        self.advance(20)
        cancelled = await self.client.post(
            f"/reading-presence/alerts/{alert_id}/cancel", json={"reason": "RETURNED"}
        )
        self.assertEqual(cancelled.json()["status"], "CANCELLED")
        self.advance(100)
        self.assertEqual(await self.run_worker(), 0)
        self.assertEqual(self.mails(), [])

    async def test_opting_out_while_waiting_sends_nothing(self):
        await self.opt_in()
        await self.arm()
        self.advance(30)
        off = await self.client.put("/reading-presence/settings", json={"email_enabled": False})
        self.assertEqual(off.json(), {"email_enabled": False})
        self.advance(40)
        self.assertEqual(await self.run_worker(), 0)
        self.assertEqual(self.mails(), [])

    async def test_other_family_unverified_email_and_ended_session_send_nothing(self):
        await self.opt_in()
        alert_id = (await self.arm()).json()["id"]
        self.actor[0] = OTHER
        self.assertEqual((await self.client.post(f"/reading-presence/alerts/{alert_id}/confirm")).status_code, 404)
        self.assertEqual((await self.client.post(f"/reading-presence/alerts/{alert_id}/cancel", json={})).status_code, 404)
        self.assertEqual((await self.arm()).status_code, 404)
        self.actor[0] = PARENT
        self.advance(30)
        await self.client.post(f"/reading-presence/alerts/{alert_id}/confirm")
        self.advance(31)

        async def unverified(_parent):
            raise Unverified()

        self.assertEqual(await self.run_worker(unverified), 0)
        self.assertEqual(self.mails(), [])

        await self.opt_in()
        async with self.engine.begin() as connection:
            await connection.execute(text("UPDATE readingsessions SET state = 'FINISHED', endedat = now()"))
            await connection.execute(text("DELETE FROM readingpresencealerts"))
        self.assertEqual((await self.arm()).status_code, 409)

    async def test_client_cannot_choose_the_recipient(self):
        await self.opt_in()
        response = await self.client.post(
            "/reading-presence/alerts",
            json={"session_id": str(SESSION), "episode_id": str(uuid4()), "email": "evil@example.test"},
        )
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("@", (await self.arm()).text)

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
