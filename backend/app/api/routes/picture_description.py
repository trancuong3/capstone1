from __future__ import annotations

import json
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.repositories.picture_description_repository import PictureDescriptionRepository
from app.schemas.picture_description import (
    PictureCatalogRead,
    PictureEvaluateRequest,
    PictureEvaluateResponse,
    PictureSessionRead,
    PictureSessionSummaryRead,
    SourceType,
    TeacherGender,
    TeachingMode,
    _normalize_target_words,
)
from app.services.picture_description_service import (
    MAX_UPLOAD_BYTES,
    PictureDescriptionService,
)
from app.services.rate_limiter import rate_limit

router = APIRouter(
    dependencies=[Depends(rate_limit("games", default_max=120, default_window=60.0))]
)


def _parse_target_words_form(raw: str | None) -> list[str]:
    if not raw or not raw.strip():
        return []
    text = raw.strip()
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return _normalize_target_words([str(item) for item in parsed])
        except json.JSONDecodeError:
            pass
    parts = [part.strip() for part in text.replace("\n", ",").split(",")]
    return _normalize_target_words(parts)


def _service(db: AsyncSession) -> PictureDescriptionService:
    return PictureDescriptionService(PictureDescriptionRepository(db))


@router.get("/catalog", response_model=PictureCatalogRead)
async def get_picture_catalog(
    child_id: UUID = Query(...),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).get_catalog(actor_id, child_id)


@router.get("/sessions", response_model=list[PictureSessionSummaryRead])
async def list_picture_sessions(
    child_id: UUID = Query(...),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).list_sessions(actor_id, child_id)


@router.post("/sessions", response_model=PictureSessionRead, status_code=201)
async def create_picture_session(
    child_id: UUID = Form(...),
    source_type: SourceType | None = Form(default=None),
    sample_key: str | None = Form(default=None),
    book_page_id: UUID | None = Form(default=None),
    teaching_mode: TeachingMode = Form(default="OBSERVE"),
    target_words: str | None = Form(default=None),
    refresh_ai_guide: bool = Form(default=False),
    auto_select: bool = Form(default=False),
    teacher_gender: TeacherGender | None = Form(default=None),
    image: UploadFile | None = File(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    resolved_source_type: SourceType | None = (
        source_type if isinstance(source_type, str) else None
    )
    resolved_sample_key = sample_key if isinstance(sample_key, str) else None
    resolved_book_page_id = book_page_id if isinstance(book_page_id, UUID) else None
    resolved_mode: TeachingMode = (
        teaching_mode if isinstance(teaching_mode, str) else "OBSERVE"
    )
    resolved_target_words = target_words if isinstance(target_words, str) else None
    resolved_refresh = refresh_ai_guide if isinstance(refresh_ai_guide, bool) else False
    resolved_auto_select = auto_select if isinstance(auto_select, bool) else False

    upload_bytes: bytes | None = None
    if image is not None and hasattr(image, "read"):
        try:
            upload_bytes = await image.read(MAX_UPLOAD_BYTES + 1)
        finally:
            await image.close()
        if len(upload_bytes) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="INVALID_IMAGE",
            )

    safe_teacher_gender = (
        teacher_gender if isinstance(teacher_gender, str) and teacher_gender in ("female", "male") else None
    )
    return await _service(db).create_session(
        actor_id,
        child_id=child_id,
        source_type=resolved_source_type,
        sample_key=resolved_sample_key,
        book_page_id=resolved_book_page_id,
        upload_bytes=upload_bytes,
        teaching_mode=resolved_mode,
        target_words=_parse_target_words_form(resolved_target_words),
        refresh_ai_guide=resolved_refresh,
        auto_select=resolved_auto_select,
        teacher_gender=safe_teacher_gender,
    )


@router.get("/sessions/{session_id}", response_model=PictureSessionRead)
async def get_picture_session(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).get_session(actor_id, session_id)


@router.post("/sessions/{session_id}/evaluate", response_model=PictureEvaluateResponse)
async def evaluate_picture_description(
    session_id: UUID,
    payload: PictureEvaluateRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).evaluate_attempt(actor_id, session_id, payload)
