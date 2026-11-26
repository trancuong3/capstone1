"""Tests for NullPool, asyncpg settings, concurrency bounds and session lifecycle."""

from __future__ import annotations

import asyncio
import os
import unittest
from unittest.mock import patch

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test"
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")

from sqlalchemy.pool import NullPool

from app.database.config import (
    DATABASE_CONCURRENCY_LIMIT,
    DATABASE_CONCURRENCY_WAIT_TIMEOUT,
    DATABASE_POOLER_MODE,
)
from app.database.session import (
    AsyncSessionLocal,
    ConcurrencyLimitedAsyncSession,
    DatabaseConcurrencyLimitExceeded,
    DatabaseConcurrencyLimiter,
    asyncpg_connect_args,
    database_concurrency_limiter,
    engine,
    get_db,
    probe_database_connection,
)


class DatabaseEngineConfigurationTests(unittest.TestCase):
    def test_engine_uses_null_pool(self):
        self.assertIsInstance(engine.pool, NullPool)

    def test_both_prepared_statement_caches_are_disabled(self):
        self.assertEqual(
            str(engine.sync_engine.url.query["prepared_statement_cache_size"]),
            "0",
        )
        self.assertEqual(asyncpg_connect_args["statement_cache_size"], 0)

    def test_asyncpg_timeouts_are_configured(self):
        self.assertGreater(asyncpg_connect_args["timeout"], 0)
        self.assertGreater(asyncpg_connect_args["command_timeout"], 0)

    def test_local_ci_mode_does_not_require_supabase_ssl(self):
        self.assertEqual(DATABASE_POOLER_MODE, "local")
        self.assertNotIn("ssl", asyncpg_connect_args)

    def test_concurrency_configuration_has_safe_bounds(self):
        self.assertGreaterEqual(DATABASE_CONCURRENCY_LIMIT, 1)
        self.assertGreaterEqual(DATABASE_CONCURRENCY_WAIT_TIMEOUT, 0.1)


class DatabaseConcurrencyLimiterTests(unittest.IsolatedAsyncioTestCase):
    async def test_limit_waits_then_times_out_without_over_acquiring(self):
        limiter = DatabaseConcurrencyLimiter(limit=1, wait_timeout=0.01)
        await limiter.acquire()
        self.assertEqual(limiter.active, 1)

        with self.assertRaises(DatabaseConcurrencyLimitExceeded):
            await limiter.acquire()

        self.assertEqual(limiter.active, 1)
        limiter.release()
        self.assertEqual(limiter.active, 0)

        await limiter.acquire()
        self.assertEqual(limiter.active, 1)
        limiter.release()
        self.assertEqual(limiter.active, 0)

    async def test_limiter_does_not_leak_permits_after_cancelled_waiter(self):
        limiter = DatabaseConcurrencyLimiter(limit=1, wait_timeout=1)
        await limiter.acquire()

        waiter = asyncio.create_task(limiter.acquire())
        await asyncio.sleep(0)
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter

        self.assertEqual(limiter.active, 1)
        limiter.release()
        await limiter.acquire()
        limiter.release()
        self.assertEqual(limiter.active, 0)

    async def test_session_close_releases_an_acquired_database_permit(self):
        session = ConcurrencyLimitedAsyncSession(bind=engine)
        before = database_concurrency_limiter.active
        await session._ensure_database_permit()
        self.assertEqual(database_concurrency_limiter.active, before + 1)

        await session.close()

        self.assertEqual(database_concurrency_limiter.active, before)

    async def test_session_commit_releases_an_acquired_database_permit(self):
        session = ConcurrencyLimitedAsyncSession(bind=engine)
        before = database_concurrency_limiter.active
        await session._ensure_database_permit()

        await session.commit()

        self.assertEqual(database_concurrency_limiter.active, before)
        await session.close()

    async def test_session_rollback_releases_an_acquired_database_permit(self):
        session = ConcurrencyLimitedAsyncSession(bind=engine)
        before = database_concurrency_limiter.active
        await session._ensure_database_permit()

        await session.rollback()

        self.assertEqual(database_concurrency_limiter.active, before)
        await session.close()


class RequestScopedSessionDependencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_dependency_closes_its_session_when_request_scope_ends(self):
        session = object()

        class FakeSessionContext:
            entered = False
            exited = False

            async def __aenter__(self):
                self.entered = True
                return session

            async def __aexit__(self, *_args):
                self.exited = True
                return False

        context = FakeSessionContext()
        with patch("app.database.session.AsyncSessionLocal", return_value=context):
            dependency = get_db()
            yielded_session = await anext(dependency)
            self.assertIs(yielded_session, session)
            self.assertTrue(context.entered)
            self.assertFalse(context.exited)
            await dependency.aclose()

        self.assertTrue(context.exited)

    async def test_each_session_factory_call_creates_a_distinct_session(self):
        first = AsyncSessionLocal()
        second = AsyncSessionLocal()
        try:
            self.assertIsNot(first, second)
        finally:
            await first.close()
            await second.close()


class DatabaseConnectionProbeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        from app.database.session import clear_database_dns_cache

        clear_database_dns_cache()

    def tearDown(self) -> None:
        from app.database.session import clear_database_dns_cache

        clear_database_dns_cache()

    async def test_probe_database_connection_runs_select_1_without_exposing_secrets(self):
        class FakeProbeSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def scalar(self, statement):
                assert str(statement) == "SELECT 1"
                return 1

        with patch(
            "app.database.session.AsyncSessionLocal",
            return_value=FakeProbeSession(),
        ):
            result = await probe_database_connection(timeout=1.0)

        self.assertTrue(result["ok"])
        self.assertTrue(result["dns_resolved"])
        self.assertEqual(result["pool_class"], "NullPool")
        self.assertIsNone(result["error_type"])
        serialized = str(result)
        self.assertNotIn("postgresql+asyncpg://", serialized)
        self.assertNotIn("test:test@", serialized)

    async def test_probe_database_connection_reports_dns_failure_safely(self):
        import socket

        loop = asyncio.get_running_loop()
        with patch.object(
            loop,
            "getaddrinfo",
            side_effect=socket.gaierror(-2, "Name or service not known"),
        ):
            result = await probe_database_connection(timeout=1.0)

        self.assertFalse(result["ok"])
        self.assertFalse(result["dns_resolved"])
        self.assertEqual(result["error_type"], "gaierror")

    async def test_probe_database_connection_uses_autocommit_for_real_async_session(self):
        from sqlalchemy.ext.asyncio import AsyncSession

        captured_options: list[dict[str, object]] = []

        class FakeRealAsyncSession(AsyncSession):
            def __init__(self) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def connection(self, *, execution_options=None, **_kwargs):
                captured_options.append(dict(execution_options or {}))
                return object()

            async def scalar(self, statement, *_args, **_kwargs):
                assert str(statement) == "SELECT 1"
                return 1

        with patch(
            "app.database.session.AsyncSessionLocal",
            return_value=FakeRealAsyncSession(),
        ):
            result = await probe_database_connection(timeout=1.0)

        self.assertTrue(result["ok"])
        self.assertEqual(captured_options, [{"isolation_level": "AUTOCOMMIT"}])

    async def test_evict_closed_asyncpg_connection_and_probe_stale_retry(self):
        from types import SimpleNamespace
        from sqlalchemy.exc import DisconnectionError, InterfaceError
        from app.database.session import _evict_closed_asyncpg_connection

        open_conn = SimpleNamespace(_connection=SimpleNamespace(is_closed=lambda: False))
        closed_conn = SimpleNamespace(_connection=SimpleNamespace(is_closed=lambda: True))
        # Healthy connection passes with 0 RTT
        _evict_closed_asyncpg_connection(open_conn, None, None)
        # Closed idle socket triggers DisconnectionError so SQLAlchemy transparently reconnects
        with self.assertRaises(DisconnectionError):
            _evict_closed_asyncpg_connection(closed_conn, None, None)

        # probe_database_connection retries once if a pooled socket disconnected mid-flight
        attempts = {"count": 0}

        class FlakySession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def scalar(self, statement, *_args, **_kwargs):
                assert str(statement) == "SELECT 1"
                attempts["count"] += 1
                if attempts["count"] == 1:
                    raise InterfaceError("SELECT 1", {}, RuntimeError("connection is closed"))
                return 1

        with patch("app.database.session.AsyncSessionLocal", side_effect=lambda: FlakySession()):
            result = await probe_database_connection(timeout=1.0)

        self.assertTrue(result["ok"])
        self.assertEqual(attempts["count"], 2)


if __name__ == "__main__":
    unittest.main()
