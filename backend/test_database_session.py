"""Tests for QueuePool/NullPool selection, asyncpg settings, concurrency bounds and session lifecycle."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import subprocess
import sys
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

BACKEND_ROOT = Path(__file__).resolve().parent

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

    def test_remote_transaction_pooler_uses_bounded_queue_pool(self):
        import certifi

        env = os.environ.copy()
        env["APP_ENVIRONMENT"] = "production"
        env["DATABASE_POOLER_MODE"] = "transaction"
        env["DATABASE_SSL_REQUIRED"] = "true"
        env["DATABASE_SSL_ROOT_CERT"] = certifi.where()
        env["DATABASE_URL"] = "postgresql+asyncpg://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres"
        env["SUPABASE_URL"] = "https://x.supabase.co"
        env["SUPABASE_KEY"] = "test-key"
        env.pop("DATABASE_CONCURRENCY_LIMIT", None)
        env.pop("DATABASE_FORCE_NULL_POOL", None)
        code = (
            "import sys; sys.path.insert(0, r'" + str(BACKEND_ROOT) + "');"
            "from sqlalchemy.pool import NullPool, QueuePool;"
            "from app.database import session;"
            "pool = session.engine.pool;"
            "assert isinstance(pool, QueuePool) and not isinstance(pool, NullPool), type(pool);"
            "assert pool.size() == 2, pool.size();"
            "assert pool._max_overflow == 2, pool._max_overflow;"
            "assert pool._recycle == 300, pool._recycle;"
            "assert pool._pre_ping is True, pool._pre_ping;"
            "assert pool._pool.use_lifo is True, pool._pool.use_lifo;"
            "assert session.asyncpg_connect_args['statement_cache_size'] == 0;"
            "assert session.sqlalchemy_database_url.query['prepared_statement_cache_size'] == '0';"
            "print('QUEUEPOOL_OK')"
        )
        proc = subprocess.run(
            [sys.executable, "-c", code],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr or proc.stdout)
        self.assertIn("QUEUEPOOL_OK", proc.stdout)

        env_forced = {**env, "DATABASE_FORCE_NULL_POOL": "true"}
        code_null = (
            "import sys; sys.path.insert(0, r'" + str(BACKEND_ROOT) + "');"
            "from sqlalchemy.pool import NullPool;"
            "from app.database import session;"
            "assert isinstance(session.engine.pool, NullPool), type(session.engine.pool);"
            "print('FORCE_NULLPOOL_OK')"
        )
        proc_null = subprocess.run(
            [sys.executable, "-c", code_null],
            env=env_forced,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc_null.returncode, 0, msg=proc_null.stderr or proc_null.stdout)
        self.assertIn("FORCE_NULLPOOL_OK", proc_null.stdout)

    def test_test_env_and_local_loopback_keep_null_pool(self):
        import certifi

        # Case 1: APP_ENVIRONMENT=test even with remote transaction pooler -> NullPool
        env_test = os.environ.copy()
        env_test["APP_ENVIRONMENT"] = "test"
        env_test["DATABASE_POOLER_MODE"] = "transaction"
        env_test["DATABASE_SSL_REQUIRED"] = "true"
        env_test["DATABASE_SSL_ROOT_CERT"] = certifi.where()
        env_test["DATABASE_URL"] = "postgresql+asyncpg://u:p@db.example.com:6543/postgres"
        env_test["SUPABASE_URL"] = "https://x.supabase.co"
        env_test["SUPABASE_KEY"] = "test-key"

        # Case 2: development + local loopback -> NullPool
        env_local = os.environ.copy()
        env_local["APP_ENVIRONMENT"] = "development"
        env_local["DATABASE_POOLER_MODE"] = "local"
        env_local["DATABASE_SSL_REQUIRED"] = "false"
        env_local["DATABASE_URL"] = "postgresql+asyncpg://u:p@127.0.0.1:5432/postgres"
        env_local["SUPABASE_URL"] = "https://x.supabase.co"
        env_local["SUPABASE_KEY"] = "test-key"

        code = (
            "import sys; sys.path.insert(0, r'" + str(BACKEND_ROOT) + "');"
            "from sqlalchemy.pool import NullPool;"
            "from app.database import session;"
            "assert isinstance(session.engine.pool, NullPool), type(session.engine.pool);"
            "print('NULLPOOL_OK')"
        )
        for label, env in (("test_env", env_test), ("local_loopback", env_local)):
            with self.subTest(case=label):
                proc = subprocess.run(
                    [sys.executable, "-c", code],
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(proc.returncode, 0, msg=proc.stderr or proc.stdout)
                self.assertIn("NULLPOOL_OK", proc.stdout)


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


if __name__ == "__main__":
    unittest.main()
