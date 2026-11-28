"""FastAPI routes for Feature #8 Offline Reading Pack Manifest & Outbox Sync."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.schemas.offline_reading_pack import (
    OfflineReadingPackManifestResponse,
    OfflineSyncOutboxRequest,
    OfflineSyncOutboxResponse,
)
from app.services.offline_reading_pack_service import (
    MAX_OFFLINE_PACK_TTS_BYTES,
    OfflineReadingPackService,
)

router = APIRouter()


def _apply_no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Vary"] = "Authorization"


@router.get(
    "/children/{child_id}/books/{book_id}/pack-manifest",
    response_model=OfflineReadingPackManifestResponse,
)
async def get_offline_book_pack_manifest(
    child_id: UUID,
    book_id: UUID,
    request: Request,
    response: Response,
    include_inline_tts: bool = Query(default=False),
    max_tts_bytes: int = Query(
        default=MAX_OFFLINE_PACK_TTS_BYTES,
        ge=65_536,
        le=MAX_OFFLINE_PACK_TTS_BYTES,
    ),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> OfflineReadingPackManifestResponse:
    _apply_no_store(response)
    inline_flag = include_inline_tts if isinstance(include_inline_tts, bool) else False
    tts_cap = (
        max_tts_bytes
        if isinstance(max_tts_bytes, int) and not isinstance(max_tts_bytes, bool)
        else MAX_OFFLINE_PACK_TTS_BYTES
    )
    return await OfflineReadingPackService(db).build_pack_manifest(
        actor_id=actor_id,
        child_id=child_id,
        book_id=book_id,
        base_url=str(request.base_url),
        include_inline_tts=inline_flag,
        max_tts_bytes=tts_cap,
    )


@router.get("/children/{child_id}/books/{book_id}/pages/{page_id}/tts-audio")
async def get_offline_pack_page_tts_audio(
    child_id: UUID,
    book_id: UUID,
    page_id: UUID,
    voice_id: str | None = Query(default=None, max_length=80),
    speed: float = Query(default=1.0, ge=0.7, le=1.3),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> Response:
    resolved_voice = voice_id if isinstance(voice_id, str) else None
    resolved_speed = (
        float(speed)
        if isinstance(speed, (int, float)) and not isinstance(speed, bool)
        else 1.0
    )
    audio_bytes, content_type = await OfflineReadingPackService(
        db
    ).get_pack_page_cached_tts(
        actor_id=actor_id,
        child_id=child_id,
        book_id=book_id,
        page_id=page_id,
        voice_id=resolved_voice,
        speed=resolved_speed,
    )
    return Response(
        content=audio_bytes,
        media_type=content_type,
        headers={
            "Cache-Control": "private, no-store",
            "Vary": "Authorization",
        },
    )


@router.post(
    "/children/{child_id}/sync-outbox",
    response_model=OfflineSyncOutboxResponse,
)
async def sync_offline_reading_outbox(
    child_id: UUID,
    payload: OfflineSyncOutboxRequest,
    response: Response,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> OfflineSyncOutboxResponse:
    _apply_no_store(response)
    resolved_header = idempotency_key if isinstance(idempotency_key, str) else None
    return await OfflineReadingPackService(db).sync_outbox_batch(
        actor_id=actor_id,
        child_id=child_id,
        payload=payload,
        idempotency_key=resolved_header,
    )
