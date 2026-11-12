from __future__ import annotations

import os

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

DEFAULT_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024
DEFAULT_DATABASE_LIMIT_BYTES = 500 * 1024 * 1024
MAX_STORAGE_OBJECT_BYTES = 40 * 1024 * 1024


async def ensure_storage_capacity(
    db: AsyncSession, incoming_bytes: int, *, existing_object_path: str | None = None,
) -> dict[str, int]:
    """Keep artifacts below the configured project storage budget and per-object cap."""
    if incoming_bytes < 0 or incoming_bytes > MAX_STORAGE_OBJECT_BYTES:
        raise HTTPException(status_code=413, detail="Training Storage object must be at most 40 MiB")
    configured = os.getenv("VIREAD_OCR_STORAGE_LIMIT_BYTES", str(DEFAULT_STORAGE_LIMIT_BYTES)).strip()
    try:
        limit = int(configured)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="VIREAD_OCR_STORAGE_LIMIT_BYTES must be an integer") from exc
    if limit <= 0:
        raise HTTPException(status_code=503, detail="VIREAD_OCR_STORAGE_LIMIT_BYTES must be positive")
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
    if used + incoming_bytes > limit:
        raise HTTPException(status_code=413, detail="Supabase Storage budget would be exceeded; no artifacts were removed")
    return {"used_bytes": used, "incoming_bytes": incoming_bytes, "limit_bytes": limit,
            "remaining_bytes": max(0, limit - used)}


async def ensure_database_capacity(db: AsyncSession, estimated_incoming_bytes: int) -> dict[str, int]:
    configured = os.getenv("VIREAD_OCR_DATABASE_LIMIT_BYTES", str(DEFAULT_DATABASE_LIMIT_BYTES)).strip()
    try:
        limit = int(configured)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="VIREAD_OCR_DATABASE_LIMIT_BYTES must be an integer") from exc
    if limit <= 0 or estimated_incoming_bytes < 0:
        raise HTTPException(status_code=503, detail="VIREAD_OCR_DATABASE_LIMIT_BYTES or estimated size is invalid")
    result = await db.execute(text("SELECT pg_database_size(current_database())::bigint AS used_bytes"))
    row = result.mappings().first()
    used = int(row["used_bytes"] if row else 0)
    if used + estimated_incoming_bytes > limit:
        raise HTTPException(status_code=413, detail="Supabase database budget would be exceeded; no data was deleted")
    return {"used_bytes": used, "incoming_bytes": estimated_incoming_bytes, "limit_bytes": limit,
            "remaining_bytes": max(0, limit - used)}
