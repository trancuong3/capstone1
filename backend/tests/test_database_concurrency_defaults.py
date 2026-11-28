from __future__ import annotations

import asyncio
import importlib
import pytest


def test_database_concurrency_defaults_allow_mobile_burst(monkeypatch):
    monkeypatch.delenv("DATABASE_CONCURRENCY_LIMIT", raising=False)
    monkeypatch.delenv("DATABASE_CONCURRENCY_WAIT_TIMEOUT", raising=False)

    import app.database.config as db_config

    reloaded = importlib.reload(db_config)
    assert reloaded.DATABASE_CONCURRENCY_LIMIT >= 16
    assert reloaded.DATABASE_CONCURRENCY_WAIT_TIMEOUT >= 15.0


def test_database_concurrency_limiter_acquire_release_and_timeout():
    from app.database.session import (
        DatabaseConcurrencyLimitExceeded,
        DatabaseConcurrencyLimiter,
    )

    async def _scenario() -> None:
        limiter = DatabaseConcurrencyLimiter(limit=2, wait_timeout=0.05)
        await limiter.acquire()
        await limiter.acquire()
        assert limiter.active == 2

        with pytest.raises(DatabaseConcurrencyLimitExceeded):
            await limiter.acquire()

        limiter.release()
        assert limiter.active == 1
        await limiter.acquire()
        assert limiter.active == 2
        limiter.release()
        limiter.release()
        assert limiter.active == 0

    asyncio.run(_scenario())
