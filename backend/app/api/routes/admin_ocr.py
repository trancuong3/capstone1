from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.schemas.admin_book import AdminBookWriteRequest
from app.schemas.admin_ocr import (
    AdminOcrCreateDraftRequest,
    AdminOcrDraftRequest,
    AdminOcrVerifyRequest,
)
from app.schemas.book import AdminBookMetadataResponse, AdminPageLifecycleRead, AdminRevisionDetailRead
from app.repositories.admin_book_repository import AdminBookRepository
from app.services.admin_book_service import AdminBookService
from app.services.admin_ocr_service import AdminOcrService

router = APIRouter()


class AdminOcrAiCorrectRequest(BaseModel):
    draft_text: str = Field(..., min_length=1, max_length=500_000)

    @field_validator("draft_text")
    @classmethod
    def text_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("draft_text must not be blank")
        return value


class AdminOcrAiCorrectResponse(BaseModel):
    corrected_text: str


class AdminOcrGenerateQuestionsRequest(BaseModel):
    text: str = Field(..., min_length=1)
    count: int = Field(default=10, ge=1, le=20)


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
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminOcrService(db).upload_page(actor_id, book_id, image)


@router.post(
    "/admin/pages/{page_id}/reupload-ocr",
    response_model=AdminRevisionDetailRead,
    status_code=201,
)
async def reupload_admin_page_image(
    page_id: UUID,
    image: UploadFile = File(...),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Replace the candidate image and OCR only this page; retain the live source until verification."""
    return await AdminOcrService(db).replace_page_image(actor_id, page_id, image)


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
    """Sửa lỗi chính tả và phục hồi dấu thanh văn bản OCR qua Gemini API."""
    return await AdminOcrService(db).ai_correct_text(actor_id, page_id, payload.draft_text)


@router.post("/admin/pages/{page_id}/generate-questions")
async def ai_generate_page_questions(
    page_id: UUID,
    payload: AdminOcrGenerateQuestionsRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Tạo bộ khoảng 10 câu hỏi đọc hiểu cho trẻ em từ nội dung trang qua Gemini API."""
    return await AdminOcrService(db).ai_generate_questions(actor_id, page_id, payload.text, payload.count)
