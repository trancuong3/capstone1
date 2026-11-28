"""API routes for Wave 1 Feature #4 mounted under `/profiles`:
- `GET /profiles/me/pin-status`
- `PUT /profiles/me/pin`
- `POST /profiles/me/pin/verify`
- `DELETE /profiles/me/pin`
- `GET /profiles/children/{child_id}/reading-passport`
- `GET /profiles/children/{child_id}/encouragement-note`
- `POST /profiles/children/{child_id}/encouragement-note`
- `GET /profiles/children/{child_id}/encouragement-note/{note_id}/audio`
- `DELETE /profiles/children/{child_id}/encouragement-note/{note_id}`
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_parent_id
from app.repositories.family_pedagogy_repository import FamilyPedagogyRepository
from app.schemas.family_pedagogy import (
    ParentEncouragementNoteRead,
    ParentPinStatusRead,
    ParentPinUpsertRequest,
    ParentPinVerifyRequest,
    ParentPinVerifyResponse,
    ReadingPassportRead,
)
from app.services.family_pedagogy_service import (
    MAX_ENCOURAGEMENT_AUDIO_BYTES,
    FamilyPedagogyService,
)
from app.services.rate_limiter import rate_limit

router = APIRouter()


def _service(db: AsyncSession) -> FamilyPedagogyService:
    return FamilyPedagogyService(FamilyPedagogyRepository(db))


@router.get("/me/pin-status", response_model=ParentPinStatusRead)
async def get_parent_pin_status(
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> ParentPinStatusRead:
    return await _service(db).get_pin_status(parent_id)


@router.put("/me/pin", response_model=ParentPinStatusRead)
async def upsert_parent_pin(
    payload: ParentPinUpsertRequest,
    parent_id: UUID = Depends(require_parent_id),
    _rate_limited: None = Depends(
        rate_limit("parent_pin_write", default_max=15, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
) -> ParentPinStatusRead:
    return await _service(db).upsert_pin(parent_id, payload)


@router.post("/me/pin/verify", response_model=ParentPinVerifyResponse)
async def verify_parent_pin(
    payload: ParentPinVerifyRequest,
    parent_id: UUID = Depends(require_parent_id),
    _rate_limited: None = Depends(
        rate_limit("parent_pin_verify", default_max=20, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
) -> ParentPinVerifyResponse:
    return await _service(db).verify_pin(parent_id, payload.pin)


@router.delete("/me/pin", response_model=ParentPinStatusRead)
async def delete_parent_pin(
    payload: ParentPinVerifyRequest,
    parent_id: UUID = Depends(require_parent_id),
    _rate_limited: None = Depends(
        rate_limit("parent_pin_delete", default_max=10, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
) -> ParentPinStatusRead:
    return await _service(db).delete_pin(parent_id, payload.pin)


@router.get(
    "/children/{child_id}/reading-passport",
    response_model=ReadingPassportRead,
)
async def get_child_reading_passport(
    child_id: UUID,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> ReadingPassportRead:
    return await _service(db).get_reading_passport(child_id, parent_id)


@router.get(
    "/children/{child_id}/encouragement-note",
    response_model=ParentEncouragementNoteRead | None,
)
async def get_child_encouragement_note(
    child_id: UUID,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> ParentEncouragementNoteRead | None:
    return await _service(db).get_encouragement_note(child_id, parent_id)


@router.post(
    "/children/{child_id}/encouragement-note",
    response_model=ParentEncouragementNoteRead,
    status_code=status.HTTP_201_CREATED,
)
async def upload_child_encouragement_note(
    child_id: UUID,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    duration_ms: int | None = Form(default=None),
    parent_id: UUID = Depends(require_parent_id),
    _rate_limited: None = Depends(
        rate_limit("parent_encouragement_upload", default_max=15, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
) -> ParentEncouragementNoteRead:
    try:
        audio_bytes = await file.read(MAX_ENCOURAGEMENT_AUDIO_BYTES + 1)
        content_type = file.content_type
    finally:
        await file.close()

    safe_title = title if isinstance(title, str) else None
    safe_duration = (
        duration_ms
        if isinstance(duration_ms, int) and not isinstance(duration_ms, bool)
        else None
    )
    return await _service(db).upload_encouragement_note(
        child_id=child_id,
        parent_id=parent_id,
        audio_bytes=audio_bytes,
        declared_content_type=content_type,
        title=safe_title,
        duration_ms=safe_duration,
    )


@router.get("/children/{child_id}/encouragement-note/{note_id}/audio")
async def stream_child_encouragement_audio(
    child_id: UUID,
    note_id: UUID,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> Response:
    audio_bytes, mime_type = await _service(db).download_encouragement_audio(
        child_id, note_id, parent_id
    )
    return Response(
        content=audio_bytes,
        media_type=mime_type,
        headers={"Cache-Control": "private, no-store"},
    )


@router.delete(
    "/children/{child_id}/encouragement-note/{note_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_child_encouragement_note(
    child_id: UUID,
    note_id: UUID,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> Response:
    await _service(db).delete_encouragement_note(child_id, note_id, parent_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
