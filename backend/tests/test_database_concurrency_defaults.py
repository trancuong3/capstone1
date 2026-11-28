from __future__ import annotations

import importlib
import os
import unittest
from unittest.mock import patch


class DatabaseConcurrencyDefaultsTests(unittest.IsolatedAsyncioTestCase):
    def test_database_concurrency_defaults_allow_mobile_burst(self) -> None:
        import app.database.config as db_config

        saved_attrs = dict(db_config.__dict__)
        saved_limit = os.environ.pop("DATABASE_CONCURRENCY_LIMIT", None)
        saved_wait = os.environ.pop("DATABASE_CONCURRENCY_WAIT_TIMEOUT", None)
        try:
            with patch("dotenv.dotenv_values", return_value={}):
                reloaded = importlib.reload(db_config)
                self.assertGreaterEqual(reloaded.DATABASE_CONCURRENCY_LIMIT, 16)
                self.assertGreaterEqual(reloaded.DATABASE_CONCURRENCY_WAIT_TIMEOUT, 15.0)
        finally:
            if saved_limit is not None:
                os.environ["DATABASE_CONCURRENCY_LIMIT"] = saved_limit
            if saved_wait is not None:
                os.environ["DATABASE_CONCURRENCY_WAIT_TIMEOUT"] = saved_wait
            for key in list(db_config.__dict__.keys()):
                if key not in saved_attrs:
                    delattr(db_config, key)
            for key, value in saved_attrs.items():
                setattr(db_config, key, value)

    async def test_database_concurrency_limiter_acquire_release_and_timeout(self) -> None:
        from app.database.session import (
            DatabaseConcurrencyLimitExceeded,
            DatabaseConcurrencyLimiter,
        )

        limiter = DatabaseConcurrencyLimiter(limit=2, wait_timeout=0.05)
        await limiter.acquire()
        await limiter.acquire()
        self.assertEqual(limiter.active, 2)

        with self.assertRaises(DatabaseConcurrencyLimitExceeded):
            await limiter.acquire()

        limiter.release()
        self.assertEqual(limiter.active, 1)
        await limiter.acquire()
        self.assertEqual(limiter.active, 2)
        limiter.release()
        limiter.release()
        self.assertEqual(limiter.active, 0)
