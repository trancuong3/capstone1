from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.diagnostic_logging import log_diagnostic
from app.schemas.admin_ocr import (
    AdminOcrCreateDraftRequest,
    AdminOcrDraftRequest,
    AdminOcrVerifyRequest,
    AdminOcrWordInput,
)
from app.schemas.admin_ai_workflow import (
    AdminAiCandidateUpdate,
    AdminAiImageSafetyDecision,
    AdminAiSafetyDecision,
    AdminAiWorkflowCreate,
    AdminAiWorkflowRead,
)
from app.schemas.book import (
    AdminDocumentUploadResponse,
    AdminPageLifecycleRead,
    AdminRevisionDetailRead,
)
from app.services.admin_ocr_service import AdminOcrService
from app.services.admin_ocr_jobs import (
    AdminOcrCorrectionJob,
    OcrCorrectionQueueFull,
    admin_ocr_correction_jobs,
)
from app.services.admin_ai_workflow_service import AdminAiWorkflowService

router = APIRouter()
logger = logging.getLogger(__name__)


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



@router.post("/admin/catalog/{book_id}/pages", response_model=AdminRevisionDetailRead, status_code=201)
async def upload_admin_page(
    book_id: UUID,
    page_number: int | None = Form(default=None, ge=1, le=32767),
    image: UploadFile = File(...),
    upload_id: UUID | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    resolved_page_number = (
        page_number if isinstance(page_number, int) and not isinstance(page_number, bool) else None
    )
    resolved_upload_id = upload_id if isinstance(upload_id, UUID) else None
    detail = await AdminOcrService(db).upload_page(
        actor_id, book_id, image, upload_id=resolved_upload_id, page_number=resolved_page_number
    )
    # OCR is complete and persisted at this point. Enqueue this page's durable
    # proofreading workflow immediately so book processing can advance page by
    # page; the worker performs inference after this request's transaction.
    if detail.verification_status == "NEEDS_REVIEW" and detail.draft_text:
        try:
            workflow_request = AdminAiWorkflowCreate(
                page_revision_id=detail.page_revision_id,
                idempotency_key=detail.page_revision_id,
                draft_text=detail.draft_text,
                words=[
                    AdminOcrWordInput(
                        word_index=word.word_index,
                        line_index=word.line_index,
                        text=word.text,
                        normalized_text=word.normalized_text,
                        bbox=word.bbox,
                        ocr_confidence=word.ocr_confidence,
                    )
                    for word in detail.words
                ],
            )
            await AdminAiWorkflowService(db).start(
                actor_id, detail.page_id, workflow_request
            )
        except Exception as exc:
            # Keep successful OCR available for Admin review if automatic
            # proofreading cannot be safely prepared (for example bad alignment).
            log_diagnostic(
                logger,
                logging.WARNING,
                event="admin_ai_workflow_auto_enqueue_failed",
                stage="post_ocr_enqueue",
                page_id=str(detail.page_id),
                page_revision_id=str(detail.page_revision_id),
                http_status=exc.status_code if isinstance(exc, HTTPException) else None,
                exception=exc,
            )
    return detail


@router.post(
    "/admin/catalog/{book_id}/documents",
    response_model=AdminDocumentUploadResponse,
    status_code=201,
)
async def upload_admin_document(
    book_id: UUID,
    document: UploadFile = File(...),
    upload_id: UUID | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    resolved_upload_id = upload_id if isinstance(upload_id, UUID) else None
    return await AdminOcrService(db).upload_document(
        actor_id, book_id, document, upload_id=resolved_upload_id
    )


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
    resolved_upload_id = upload_id if isinstance(upload_id, UUID) else None
    return await AdminOcrService(db).replace_page_image(
        actor_id, page_id, image, upload_id=resolved_upload_id
    )


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


@router.post("/admin/catalog/{book_id}/pages/jobs", status_code=202)
async def enqueue_admin_page_ocr_job(
    book_id: UUID,
    image: UploadFile = File(...),
    upload_id: UUID | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    resolved_upload_id = upload_id if isinstance(upload_id, UUID) else None
    return await AdminOcrService(db).enqueue_upload_page_job(
        actor_id, book_id, image, upload_id=resolved_upload_id
    )


@router.post("/admin/catalog/{book_id}/documents/jobs", status_code=202)
async def enqueue_admin_document_ocr_jobs(
    book_id: UUID,
    document: UploadFile = File(...),
    upload_id: UUID | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    resolved_upload_id = upload_id if isinstance(upload_id, UUID) else None
    return await AdminOcrService(db).enqueue_upload_document_jobs(
        actor_id, book_id, document, upload_id=resolved_upload_id
    )


@router.post("/admin/pages/{page_id}/reupload-ocr/jobs", status_code=202)
async def enqueue_admin_reupload_ocr_job(
    page_id: UUID,
    image: UploadFile = File(...),
    upload_id: UUID | None = Form(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    resolved_upload_id = upload_id if isinstance(upload_id, UUID) else None
    return await AdminOcrService(db).enqueue_reupload_ocr_job(
        actor_id, page_id, image, upload_id=resolved_upload_id
    )


@router.post("/admin/pages/{page_id}/reprocess/jobs", status_code=202)
async def enqueue_admin_reprocess_ocr_job(
    page_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminOcrService(db).enqueue_reprocess_job(actor_id, page_id)


@router.get("/admin/ocr-jobs/{job_id}")
async def get_admin_ocr_job_status(
    job_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    from app.services.ocr_inference_job_service import OcrInferenceJobService

    await AdminOcrService(db).require_admin(actor_id)
    return await OcrInferenceJobService(db).get_job_status_payload(
        job_id,
        admin_only=True,
    )


@router.get("/admin/catalog/{book_id}/ocr-jobs")
async def list_admin_book_ocr_jobs(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    from app.services.ocr_inference_job_service import OcrInferenceJobService

    await AdminOcrService(db).require_admin(actor_id)
    return await OcrInferenceJobService(db).list_book_jobs_payload(
        book_id,
        admin_only=True,
    )


@router.post("/admin/ocr-jobs/{job_id}/retry")
async def retry_admin_ocr_job(
    job_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    from app.services.ocr_inference_job_service import OcrInferenceJobService

    await AdminOcrService(db).require_admin(actor_id)
    return await OcrInferenceJobService(db).retry_job(
        job_id,
        admin_only=True,
    )


@router.delete("/admin/ocr-jobs/{job_id}")
async def cancel_admin_ocr_job(
    job_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    from app.services.ocr_inference_job_service import OcrInferenceJobService

    await AdminOcrService(db).require_admin(actor_id)
    return await OcrInferenceJobService(db).cancel_job(
        job_id,
        admin_only=True,
    )


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


async def _sync_admin_ocr_job_to_db(job: AdminOcrCorrectionJob) -> None:
    """Best-effort durable status sync using an isolated DB session (never touches request session)."""
    try:
        from app.database.session import AsyncSessionLocal

        async with AsyncSessionLocal() as bg_db:
            await admin_ocr_correction_jobs.persist_job_mirror(bg_db, job)
    except Exception:
        logger.debug("admin_ocr_job_bg_mirror_skipped job_id=%s", job.job_id)


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
    book_id, durable_supported = (
        await admin_ocr_correction_jobs.resolve_page_book_id_with_support(db, page_id)
    )
    input_hash = hashlib.sha256(
        f"admin-ai-correct:{page_id}:{payload.draft_text}".encode("utf-8")
    ).hexdigest()

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
            book_id=book_id,
            input_hash=input_hash,
            durable_sync=_sync_admin_ocr_job_to_db if durable_supported else None,
        )
    except OcrCorrectionQueueFull as exc:
        raise HTTPException(
            status_code=429,
            detail="AI OCR đang xử lý quá nhiều yêu cầu. Hãy đợi tác vụ hiện tại hoàn tất rồi thử lại.",
            headers={"Retry-After": "5"},
        ) from exc
    if durable_supported:
        await admin_ocr_correction_jobs.persist_job_mirror(db, job)
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
    job = await admin_ocr_correction_jobs.get_durable(db, job_id, actor_id, page_id)
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
    job = await admin_ocr_correction_jobs.cancel_durable(db, job_id, actor_id, page_id)
    if job is None:
        raise HTTPException(status_code=404, detail="AI OCR job not found")
    return _job_read(job)


@router.post(
    "/admin/pages/{page_id}/ai-workflows",
    response_model=AdminAiWorkflowRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def start_admin_ai_workflow(
    page_id: UUID,
    payload: AdminAiWorkflowCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Persist one idempotent workflow request; workers perform inference later."""
    return await AdminAiWorkflowService(db).start(actor_id, page_id, payload)


@router.get(
    "/admin/pages/{page_id}/revisions/{revision_id}/ai-workflows/latest",
    response_model=AdminAiWorkflowRead | None,
)
async def get_latest_admin_ai_workflow(
    page_id: UUID,
    revision_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminAiWorkflowService(db).get_latest(actor_id, page_id, revision_id)


@router.get(
    "/admin/pages/{page_id}/ai-workflows/{workflow_id}",
    response_model=AdminAiWorkflowRead,
)
async def get_admin_ai_workflow(
    page_id: UUID,
    workflow_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminAiWorkflowService(db).get(actor_id, page_id, workflow_id)


@router.patch(
    "/admin/pages/{page_id}/ai-workflows/{workflow_id}/candidate",
    response_model=AdminAiWorkflowRead,
)
async def update_admin_ai_candidate(
    page_id: UUID,
    workflow_id: UUID,
    payload: AdminAiCandidateUpdate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminAiWorkflowService(db).update_candidate(
        actor_id, page_id, workflow_id, payload
    )


@router.post(
    "/admin/pages/{page_id}/ai-workflows/{workflow_id}/retry",
    response_model=AdminAiWorkflowRead,
)
async def retry_admin_ai_workflow(
    page_id: UUID,
    workflow_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminAiWorkflowService(db).retry(actor_id, page_id, workflow_id)


@router.post(
    "/admin/pages/{page_id}/ai-workflows/{workflow_id}/safety-decision",
    response_model=AdminAiWorkflowRead,
)
async def decide_admin_ai_safety(
    page_id: UUID,
    workflow_id: UUID,
    payload: AdminAiSafetyDecision,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminAiWorkflowService(db).decide_safety(
        actor_id, page_id, workflow_id, payload
    )


@router.post(
    "/admin/pages/{page_id}/ai-workflows/{workflow_id}/image-safety-decision",
    response_model=AdminAiWorkflowRead,
)
async def decide_admin_ai_image_safety(
    page_id: UUID,
    workflow_id: UUID,
    payload: AdminAiImageSafetyDecision,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminAiWorkflowService(db).decide_image_safety(
        actor_id, page_id, workflow_id, payload
    )
