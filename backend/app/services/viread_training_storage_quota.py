from __future__ import annotations

import os
import threading
import time

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import APP_ENVIRONMENT

DEFAULT_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024
DEFAULT_DATABASE_LIMIT_BYTES = 500 * 1024 * 1024
MAX_STORAGE_OBJECT_BYTES = 40 * 1024 * 1024
_QUOTA_CACHE_TTL = 60.0

_quota_lock = threading.Lock()
_storage_cache: tuple[float, int] = (0.0, 0)
_db_size_cache: tuple[float, int] = (0.0, 0)


async def ensure_storage_capacity(
    db: AsyncSession, incoming_bytes: int, *, existing_object_path: str | None = None,
) -> dict[str, int]:
    """Keep artifacts below the configured project storage budget and per-object cap."""
    global _storage_cache
    if incoming_bytes < 0 or incoming_bytes > MAX_STORAGE_OBJECT_BYTES:
        raise HTTPException(status_code=413, detail="Training Storage object must be at most 40 MiB")
    configured = os.getenv("VIREAD_OCR_STORAGE_LIMIT_BYTES", str(DEFAULT_STORAGE_LIMIT_BYTES)).strip()
    try:
        limit = int(configured)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="VIREAD_OCR_STORAGE_LIMIT_BYTES must be an integer") from exc
    if limit <= 0:
        raise HTTPException(status_code=503, detail="VIREAD_OCR_STORAGE_LIMIT_BYTES must be positive")

    now = time.monotonic()
    use_cache = APP_ENVIRONMENT != "test" and existing_object_path is None
    used: int | None = None
    if use_cache:
        with _quota_lock:
            expires_at, cached_used = _storage_cache
            if expires_at > now and (cached_used + incoming_bytes) < int(limit * 0.95):
                used = cached_used
                _storage_cache = (expires_at, cached_used + incoming_bytes)

    if used is None:
        exclude_path = " WHERE name <> :existing_path" if existing_object_path else ""
        result = await db.execute(text(f"""
            SELECT COALESCE(SUM(
                CASE WHEN metadata->>'size' ~ '^[0-9]+$'
                     THEN (metadata->>'size')::bigint ELSE 0 END
            ), 0)::bigint AS used_bytes
            FROM storage.objects
            {exclude_path}
        """), {"existing_path": existing_object_path} if existing_object_path else {})
        row = result.mappings().first()
        used = int(row["used_bytes"] if row else 0)
        if use_cache:
            with _quota_lock:
                _storage_cache = (now + _QUOTA_CACHE_TTL, used + incoming_bytes)

    if used + incoming_bytes > limit:
        raise HTTPException(status_code=413, detail="Supabase Storage budget would be exceeded; no artifacts were removed")
    return {"used_bytes": used, "incoming_bytes": incoming_bytes, "limit_bytes": limit,
            "remaining_bytes": max(0, limit - used)}


async def ensure_database_capacity(db: AsyncSession, estimated_incoming_bytes: int) -> dict[str, int]:
    global _db_size_cache
    configured = os.getenv("VIREAD_OCR_DATABASE_LIMIT_BYTES", str(DEFAULT_DATABASE_LIMIT_BYTES)).strip()
    try:
        limit = int(configured)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="VIREAD_OCR_DATABASE_LIMIT_BYTES must be an integer") from exc
    if limit <= 0 or estimated_incoming_bytes < 0:
        raise HTTPException(status_code=503, detail="VIREAD_OCR_DATABASE_LIMIT_BYTES or estimated size is invalid")

    now = time.monotonic()
    use_cache = APP_ENVIRONMENT != "test"
    used: int | None = None
    if use_cache:
        with _quota_lock:
            expires_at, cached_used = _db_size_cache
            if expires_at > now and (cached_used + estimated_incoming_bytes) < int(limit * 0.95):
                used = cached_used
                _db_size_cache = (expires_at, cached_used + estimated_incoming_bytes)

    if used is None:
        result = await db.execute(text("SELECT pg_database_size(current_database())::bigint AS used_bytes"))
        row = result.mappings().first()
        used = int(row["used_bytes"] if row else 0)
        if use_cache:
            with _quota_lock:
                _db_size_cache = (now + _QUOTA_CACHE_TTL, used + estimated_incoming_bytes)

    if used + estimated_incoming_bytes > limit:
        raise HTTPException(status_code=413, detail="Supabase database budget would be exceeded; no data was deleted")
    return {"used_bytes": used, "incoming_bytes": estimated_incoming_bytes, "limit_bytes": limit,
            "remaining_bytes": max(0, limit - used)}