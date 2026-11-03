from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import (
    DATABASE_MAX_OVERFLOW,
    DATABASE_POOL_RECYCLE,
    DATABASE_POOL_SIZE,
    DATABASE_POOL_TIMEOUT,
    DATABASE_URL,
)

# The pool is intentionally small for Supabase session-mode pooling. Each
# Uvicorn worker owns its own engine, so size the total across all workers and
# instances rather than treating this as a repository-wide connection budget.
engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    future=True,
    pool_size=DATABASE_POOL_SIZE,
    max_overflow=DATABASE_MAX_OVERFLOW,
    pool_timeout=DATABASE_POOL_TIMEOUT,
    pool_recycle=DATABASE_POOL_RECYCLE,
    pool_pre_ping=True,
    pool_use_lifo=True,
)

AsyncSessionLocal = sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

Base = declarative_base()


async def get_db():
    """Yield one request-scoped session and always close it on dependency exit."""
    async with AsyncSessionLocal() as session:
        yield session
