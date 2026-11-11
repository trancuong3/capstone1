from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.schemas.admin_book import AdminBookWriteRequest
from app.schemas.admin_ocr import (
    AdminOcrCreateDraftRequest,
    AdminOcrDraftRequest,
    AdminOcrVerifyRequest,
    AdminOcrWordInput,
)
from app.schemas.book import AdminBookMetadataResponse, AdminPageLifecycleRead, AdminRevisionDetailRead
from app.repositories.admin_book_repository import AdminBookRepository
from app.services.admin_book_service import AdminBookService
from app.services.admin_ocr_service import AdminOcrService
from app.services.admin_ocr_jobs import (
    AdminOcrCorrectionJob,
    OcrCorrectionQueueFull,
    admin_ocr_correction_jobs,
)

router = APIRouter()


class AdminOcrAiCorrectRequest(BaseModel):
    draft_text: str = Field(..., min_length=1, max_length=500_000)
    words: list[AdminOcrWordInput] = Field(min_length=1, max_length=30_000)
    idempotency_key: UUID | None = None

    @field_validator("draft_text")
    @classmethod
    def text_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("draft_text must not be blank")
        return value


class AdminOcrAiCorrectResponse(BaseModel):
    corrected_text: str


class AdminOcrAiCorrectionJobRead(BaseModel):
    job_id: UUID
    page_id: UUID
    status: Literal["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]
    completed_chunks: int = Field(ge=0)
    total_chunks: int = Field(ge=1)
    result: str | None = None
    error: str | None = None
    created_at: datetime
    updated_at: datetime


def _job_read(job: AdminOcrCorrectionJob) -> AdminOcrAiCorrectionJobRead:
    return AdminOcrAiCorrectionJobRead(
        job_id=job.job_id,
        page_id=job.page_id,
        status=job.status,
        completed_chunks=job.completed_chunks,
        total_chunks=job.total_chunks,
        result=job.result,
        error=job.error,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )



@router.post("/admin/catalog", response_model=AdminBookMetadataResponse, status_code=201)
async def create_admin_book(
    payload: AdminBookWriteRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminBookService(AdminBookRepository(db)).create(actor_id, payload)


@router.post("/admin/catalog/{book_id}/pages", response_model=AdminRevisionDetailRead, status_code=201)
async def upload_admin_page(
    book_id: UUID,
    page_number: int | None = Form(default=None, ge=1, le=32767),
    image: UploadFile = File(...),
    upload_id: UUID | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminOcrService(db).upload_page(actor_id, book_id, image, upload_id=upload_id)


@router.post(
    "/admin/pages/{page_id}/reupload-ocr",
    response_model=AdminRevisionDetailRead,
    status_code=201,
)
async def reupload_admin_page_image(
    page_id: UUID,
    image: UploadFile = File(...),
    upload_id: UUID | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Replace the candidate image and OCR only this page; retain the live source until verification."""
    return await AdminOcrService(db).replace_page_image(actor_id, page_id, image, upload_id=upload_id)


@router.post("/admin/pages/{page_id}/revisions/draft", response_model=AdminRevisionDetailRead, status_code=201)
async def create_admin_page_edit_draft(
    page_id: UUID,
    payload: AdminOcrCreateDraftRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminOcrService(db).create_edit_draft(
        actor_id, page_id, payload.expected_source_revision_id
    )


@router.put("/admin/pages/{page_id}/revisions/{revision_id}/draft", response_model=AdminRevisionDetailRead)
async def save_admin_page_draft(
    page_id: UUID,
    revision_id: UUID,
    payload: AdminOcrDraftRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminOcrService(db).save_draft(actor_id, page_id, revision_id, payload)


@router.post("/admin/pages/{page_id}/verify", response_model=AdminRevisionDetailRead)
async def verify_admin_page(
    page_id: UUID,
    payload: AdminOcrVerifyRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminOcrService(db).verify(actor_id, page_id, payload)


@router.delete("/admin/pages/{page_id}", response_model=AdminPageLifecycleRead)
async def retire_admin_page(
    page_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminOcrService(db).retire_page(actor_id, page_id)


@router.post("/admin/pages/{page_id}/reprocess", response_model=AdminRevisionDetailRead, status_code=201)
async def reprocess_admin_page(
    page_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminOcrService(db).reprocess(actor_id, page_id)


@router.post(
    "/admin/pages/{page_id}/ai-correct",
    response_model=AdminOcrAiCorrectResponse,
)
async def ai_correct_page_text(
    page_id: UUID,
    payload: AdminOcrAiCorrectRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Correct OCR text with the configured loopback-only local model."""
    return await AdminOcrService(db).ai_correct_text(
        actor_id, page_id, payload.draft_text, payload.words
    )


@router.post(
    "/admin/pages/{page_id}/ai-correct/jobs",
    response_model=AdminOcrAiCorrectionJobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def start_ai_correct_page_job(
    page_id: UUID,
    payload: AdminOcrAiCorrectRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminOcrService(db)
    prepared = await service.prepare_ai_correction(
        actor_id, page_id, payload.draft_text, payload.words
    )

    async def run_correction(on_progress):
        return await AdminOcrService.run_prepared_ai_correction(
            prepared, on_progress
        )

    try:
        job = admin_ocr_correction_jobs.submit(
            page_id=page_id,
            actor_id=actor_id,
            total_chunks=prepared.total_chunks,
            operation=run_correction,
            idempotency_key=payload.idempotency_key,
        )
    except OcrCorrectionQueueFull as exc:
        raise HTTPException(
            status_code=429,
            detail="AI OCR đang xử lý quá nhiều yêu cầu. Hãy đợi tác vụ hiện tại hoàn tất rồi thử lại.",
            headers={"Retry-After": "5"},
        ) from exc
    return _job_read(job)


@router.get(
    "/admin/pages/{page_id}/ai-correct/jobs/{job_id}",
    response_model=AdminOcrAiCorrectionJobRead,
)
async def get_ai_correct_page_job(
    page_id: UUID,
    job_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    await AdminOcrService(db).require_admin(actor_id)
    job = admin_ocr_correction_jobs.get(job_id, actor_id, page_id)
    if job is None:
        raise HTTPException(status_code=404, detail="AI OCR job not found")
    return _job_read(job)


@router.delete(
    "/admin/pages/{page_id}/ai-correct/jobs/{job_id}",
    response_model=AdminOcrAiCorrectionJobRead,
)
async def cancel_ai_correct_page_job(
    page_id: UUID,
    job_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    await AdminOcrService(db).require_admin(actor_id)
    job = admin_ocr_correction_jobs.cancel(job_id, actor_id, page_id)
    if job is None:
        raise HTTPException(status_code=404, detail="AI OCR job not found")
    return _job_read(job)
