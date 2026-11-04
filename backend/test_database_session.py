"""Tests for NullPool, asyncpg settings, concurrency bounds and session lifecycle."""

from __future__ import annotations

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

        waiter = __import__("asyncio").create_task(limiter.acquire())
        await __import__("asyncio").sleep(0)
        waiter.cancel()
        with self.assertRaises(__import__("asyncio").CancelledError):
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


if __name__ == "__main__":
    unittest.main()
