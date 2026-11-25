from __future__ import annotations

import os
import threading
import time
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import APP_ENVIRONMENT
from app.models import Profile

_ROLE_TTL_SECONDS = max(0.0, float(os.getenv("VIREAD_ROLE_CACHE_TTL_SECONDS", "10.0")))
_MAX_CACHE_ENTRIES = 2048
_lock = threading.Lock()
_role_cache: dict[UUID, tuple[float, str | None]] = {}


def invalidate_cached_role(profile_id: UUID | None = None) -> None:
    """Invalidate one cached role or clear the entire process role cache."""
    with _lock:
        if profile_id is None:
            _role_cache.clear()
        else:
            _role_cache.pop(profile_id, None)


_MISSING = object()


def peek_cached_profile_role(profile_id: UUID) -> object:
    """Return cached active role without hitting the database, or `_MISSING` on miss/expiry."""
    now = time.monotonic()
    with _lock:
        entry = _role_cache.get(profile_id)
        if entry is not None and entry[0] > now:
            return entry[1]
    return _MISSING


def put_cached_profile_role(profile_id: UUID, role: str | None) -> None:
    """Populate the bounded profile role cache for testing or lazy lookups."""
    now = time.monotonic()
    with _lock:
        if len(_role_cache) >= _MAX_CACHE_ENTRIES:
            _role_cache.clear()
        _role_cache[profile_id] = (now + _ROLE_TTL_SECONDS, role)


async def get_cached_profile_role(db: AsyncSession, profile_id: UUID) -> str | None:
    """Cache only active profile roles; inactive parents and admins have no access."""
    if APP_ENVIRONMENT == "test" or not isinstance(db, AsyncSession):
        return await db.scalar(select(Profile.Role).where(Profile.Id == profile_id, Profile.Active == 1))

    now = time.monotonic()
    with _lock:
        entry = _role_cache.get(profile_id)
        if entry is not None and entry[0] > now:
            return entry[1]

    role = await db.scalar(select(Profile.Role).where(Profile.Id == profile_id, Profile.Active == 1))
    with _lock:
        if len(_role_cache) >= _MAX_CACHE_ENTRIES:
            _role_cache.clear()
        _role_cache[profile_id] = (now + _ROLE_TTL_SECONDS, role)
    return role


async def get_cached_profile_active_role(profile_id: UUID) -> str | None:
    """Check cached Profile.Active == 1 role first, querying DB lazily only on cache miss."""
    if APP_ENVIRONMENT != "test":
        cached = peek_cached_profile_role(profile_id)
        if cached is not _MISSING:
            return cached  # type: ignore[return-value]

    from app.database.session import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        role = await db.scalar(
            select(Profile.Role).where(Profile.Id == profile_id, Profile.Active == 1)
        )
    if APP_ENVIRONMENT != "test":
        put_cached_profile_role(profile_id, role)
    return role