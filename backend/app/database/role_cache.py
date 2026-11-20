from __future__ import annotations

import threading
import time
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import APP_ENVIRONMENT
from app.models import Profile

_ROLE_TTL_SECONDS = 60.0
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