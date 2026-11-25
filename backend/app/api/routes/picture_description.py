from __future__ import annotations

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
)
from app.services.picture_description_service import (
    MAX_UPLOAD_BYTES,
    PictureDescriptionService,
)
from app.services.rate_limiter import rate_limit

router = APIRouter(
    dependencies=[Depends(rate_limit("games", default_max=120, default_window=60.0))]
)


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
    source_type: SourceType = Form(...),
    sample_key: str | None = Form(default=None),
    book_page_id: UUID | None = Form(default=None),
    image: UploadFile | None = File(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    upload_bytes: bytes | None = None
    if image is not None:
        upload_bytes = await image.read(MAX_UPLOAD_BYTES + 1)
        if len(upload_bytes) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="INVALID_IMAGE",
            )

    return await _service(db).create_session(
        actor_id,
        child_id=child_id,
        source_type=source_type,
        sample_key=sample_key,
        book_page_id=book_page_id,
        upload_bytes=upload_bytes,
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
