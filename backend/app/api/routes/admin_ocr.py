from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.schemas.admin_book import AdminBookWriteRequest
from app.schemas.admin_ocr import AdminOcrDraftRequest, AdminOcrVerifyRequest
from app.schemas.book import AdminBookMetadataResponse, AdminPageLifecycleRead, AdminRevisionDetailRead
from app.repositories.admin_book_repository import AdminBookRepository
from app.services.admin_book_service import AdminBookService
from app.services.admin_ocr_service import AdminOcrService

router = APIRouter()


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
    return await AdminOcrService(db).upload_page(actor_id, book_id, page_number, image)


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
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminOcrService(db).create_edit_draft(actor_id, page_id)


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
