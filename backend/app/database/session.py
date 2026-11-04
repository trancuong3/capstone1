from __future__ import annotations

import asyncio
import logging
import ssl
from typing import Any

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import declarative_base
from sqlalchemy.pool import NullPool

from app.diagnostic_logging import log_diagnostic

from .config import (
    DATABASE_COMMAND_TIMEOUT,
    DATABASE_CONCURRENCY_LIMIT,
    DATABASE_CONCURRENCY_WAIT_TIMEOUT,
    DATABASE_CONNECT_TIMEOUT,
    DATABASE_SSL_REQUIRED,
    DATABASE_SSL_ROOT_CERT,
    DATABASE_URL,
)

logger = logging.getLogger(__name__)


class DatabaseConcurrencyLimitExceeded(RuntimeError):
    """Raised when a process has no database transaction slot before its deadline."""


class DatabaseConcurrencyLimiter:
    """Bound active database transactions for one application process."""

    def __init__(self, limit: int, wait_timeout: float) -> None:
        self._semaphore = asyncio.BoundedSemaphore(limit)
        self._wait_timeout = wait_timeout
        self._active = 0

    @property
    def active(self) -> int:
        return self._active

    async def acquire(self) -> None:
        try:
            await asyncio.wait_for(
                self._semaphore.acquire(),
                timeout=self._wait_timeout,
            )
        except TimeoutError as error:
            raise DatabaseConcurrencyLimitExceeded(
                "Database concurrency limit reached"
            ) from error
        self._active += 1

    def release(self) -> None:
        if self._active <= 0:
            raise RuntimeError("Database concurrency permit released more than once")
        self._active -= 1
        self._semaphore.release()


database_concurrency_limiter = DatabaseConcurrencyLimiter(
    DATABASE_CONCURRENCY_LIMIT,
    DATABASE_CONCURRENCY_WAIT_TIMEOUT,
)


class ConcurrencyLimitedAsyncSession(AsyncSession):
    """AsyncSession that holds one process permit for each active DB transaction.

    A permit is acquired immediately before the first operation that may access
    PostgreSQL and released on commit, rollback, or close. This is deliberately
    transaction-scoped rather than held for the whole HTTP request, so external
    Storage/OCR work can run after the caller ends its database transaction.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._database_permit_acquired = False

    async def _ensure_database_permit(self) -> None:
        if self._database_permit_acquired:
            return
        try:
            await database_concurrency_limiter.acquire()
        except DatabaseConcurrencyLimitExceeded as error:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="database_concurrency_limit_reached",
                stage="database_concurrency",
                limit=DATABASE_CONCURRENCY_LIMIT,
                wait_timeout_seconds=DATABASE_CONCURRENCY_WAIT_TIMEOUT,
                active=database_concurrency_limiter.active,
            )
            raise error
        self._database_permit_acquired = True

    async def _release_database_permit(self) -> None:
        if self._database_permit_acquired:
            self._database_permit_acquired = False
            database_concurrency_limiter.release()

    async def execute(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().execute(*args, **kwargs)

    async def scalar(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().scalar(*args, **kwargs)

    async def scalars(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().scalars(*args, **kwargs)

    async def get(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().get(*args, **kwargs)

    async def refresh(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().refresh(*args, **kwargs)

    async def flush(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().flush(*args, **kwargs)

    async def delete(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().delete(*args, **kwargs)

    async def merge(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().merge(*args, **kwargs)

    async def connection(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().connection(*args, **kwargs)

    async def run_sync(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().run_sync(*args, **kwargs)

    async def stream(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().stream(*args, **kwargs)

    async def stream_scalars(self, *args: Any, **kwargs: Any):
        await self._ensure_database_permit()
        return await super().stream_scalars(*args, **kwargs)

    async def commit(self) -> None:
        await self._ensure_database_permit()
        try:
            await super().commit()
        except BaseException:
            try:
                await super().rollback()
            finally:
                await self._release_database_permit()
            raise
        else:
            await self._release_database_permit()

    async def rollback(self) -> None:
        try:
            await super().rollback()
        finally:
            await self._release_database_permit()

    async def close(self) -> None:
        try:
            await super().close()
        finally:
            await self._release_database_permit()


# SQLAlchemy's asyncpg dialect owns a prepared-statement cache separate from
# asyncpg's own statement cache. Disable both for Supavisor transaction mode.
database_url = make_url(DATABASE_URL)
database_query = dict(database_url.query)
database_query.pop("sslmode", None)
database_query.pop("sslrootcert", None)
database_query.pop("ssl", None)
database_query["prepared_statement_cache_size"] = "0"
sqlalchemy_database_url = database_url.set(query=database_query)

asyncpg_connect_args: dict[str, Any] = {
    "statement_cache_size": 0,
    "timeout": DATABASE_CONNECT_TIMEOUT,
    "command_timeout": DATABASE_COMMAND_TIMEOUT,
    "server_settings": {
        "application_name": "viread-api",
    },
}

if DATABASE_SSL_REQUIRED:
    # create_default_context enables certificate-chain and hostname validation.
    ssl_context = ssl.create_default_context(cafile=DATABASE_SSL_ROOT_CERT)
    if ssl_context.verify_mode != ssl.CERT_REQUIRED or not ssl_context.check_hostname:
        raise RuntimeError("Database SSL context must verify CA and hostname")
    asyncpg_connect_args["ssl"] = ssl_context

engine = create_async_engine(
    sqlalchemy_database_url,
    echo=False,
    poolclass=NullPool,
    connect_args=asyncpg_connect_args,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=ConcurrencyLimitedAsyncSession,
    expire_on_commit=False,
)

Base = declarative_base()


async def get_db():
    """Yield one request-scoped session; permits are held only during DB transactions."""
    async with AsyncSessionLocal() as session:
        yield session
