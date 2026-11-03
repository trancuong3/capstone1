"""Connection-pool limits and request-scoped async DB session lifecycle tests."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test"
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.database.config import (
    DATABASE_MAX_OVERFLOW,
    DATABASE_POOL_RECYCLE,
    DATABASE_POOL_SIZE,
    DATABASE_POOL_TIMEOUT,
)
from app.database.session import AsyncSessionLocal, engine, get_db


class DatabasePoolConfigurationTests(unittest.TestCase):
    def test_pool_is_small_and_checks_connections_before_checkout(self):
        self.assertGreaterEqual(DATABASE_POOL_SIZE, 1)
        self.assertGreaterEqual(DATABASE_MAX_OVERFLOW, 0)
        self.assertLessEqual(DATABASE_POOL_SIZE + DATABASE_MAX_OVERFLOW, 15)
        self.assertGreaterEqual(DATABASE_POOL_TIMEOUT, 1.0)
        self.assertGreaterEqual(DATABASE_POOL_RECYCLE, 60)
        self.assertEqual(engine.pool.size(), DATABASE_POOL_SIZE)
        self.assertEqual(engine.pool._max_overflow, DATABASE_MAX_OVERFLOW)
        self.assertEqual(engine.pool._timeout, DATABASE_POOL_TIMEOUT)
        self.assertEqual(engine.pool._recycle, DATABASE_POOL_RECYCLE)
        self.assertTrue(engine.pool._pre_ping)

    def test_each_session_factory_call_creates_a_distinct_session(self):
        first = AsyncSessionLocal()
        second = AsyncSessionLocal()
        try:
            self.assertIsNot(first, second)
        finally:
            import asyncio

            asyncio.run(first.close())
            asyncio.run(second.close())


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


if __name__ == "__main__":
    unittest.main()
