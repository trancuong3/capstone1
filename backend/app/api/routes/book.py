"""HTTP routes for books, parent catalog, and admin catalog reads."""
from __future__ import annotations

from typing import List, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.schemas import BookCreate, BookPageResponse, BookResponse
from app.schemas.book import (
    AdminCatalogBookDetailResponse,
    AdminCatalogBookResponse,
    AdminPageImageRead,
    AdminPageListRead,
    AdminPageProcessingRead,
    AdminRevisionDetailRead,
    AdminRevisionSummaryRead,
    CatalogBookResponse,
    CatalogPagePreviewResponse,
)
from app.repositories.metadata_quality_repository import MetadataQualityRepository
from app.schemas.metadata_quality import MetadataQualityIssueType, MetadataQualityResponse
from app.services.book_service import AdminCatalogService, BookService, CatalogService
from app.services.metadata_quality_service import MetadataQualityService

router = APIRouter()


@router.get("/admin/metadata-quality", response_model=MetadataQualityResponse)
async def get_admin_metadata_quality(
    search: str | None = Query(default=None, max_length=120),
    issue_type: MetadataQualityIssueType | None = Query(default=None),
    lifecycle_status: Literal["ACTIVE", "RETIRED"] | None = Query(default=None),
    limit: int = Query(default=10, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = MetadataQualityService(MetadataQualityRepository(db))
    return await service.dashboard(
        actor_id,
        search=search,
        issue_type=issue_type,
        lifecycle_status=lifecycle_status,
        limit=limit,
        offset=offset,
    )


@router.get("/", response_model=List[BookResponse])
async def get_books(db: AsyncSession = Depends(get_db)):
    """Return all books through the service/repository flow."""
    return await BookService(db).list_books()


@router.post("/", response_model=BookResponse)
async def create_book(
    book_in: BookCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Create a book after the service verifies admin authorization."""
    return await BookService(db).create_book(actor_id, book_in)


@router.get("/{book_id}/pages", response_model=List[BookPageResponse])
async def get_book_pages(book_id: UUID, db: AsyncSession = Depends(get_db)):
    """Return the pages for a book through the service/repository flow."""
    return await BookService(db).list_pages(book_id)


@router.get("/catalog", response_model=list[CatalogBookResponse])
async def get_parent_catalog(
    search: str | None = Query(default=None),
    author: str | None = Query(default=None),
    grade: int | None = Query(default=None, ge=1, le=5),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = CatalogService(db)
    await service.require_parent(actor_id)
    return await service.list(search, author, grade)


@router.get("/catalog/{book_id}", response_model=CatalogBookResponse)
async def get_parent_catalog_book(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = CatalogService(db)
    await service.require_parent(actor_id)
    return await service.get(book_id)


@router.get("/catalog/{book_id}/preview", response_model=list[CatalogPagePreviewResponse])
async def get_parent_catalog_previews(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = CatalogService(db)
    await service.require_parent(actor_id)
    return await service.previews(book_id)


@router.get("/admin/catalog", response_model=list[AdminCatalogBookResponse])
async def get_admin_catalog(
    search: str | None = None,
    lifecycle_status: Literal["ACTIVE", "RETIRED"] | None = None,
    verification_status: Literal["PROCESSING", "NEEDS_REVIEW", "VERIFIED"] | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminCatalogService(db)
    await service.require_admin(actor_id)
    return await service.list(search, lifecycle_status, verification_status)


@router.get("/admin/catalog/{book_id}", response_model=AdminCatalogBookDetailResponse)
async def get_admin_book(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminCatalogService(db)
    await service.require_admin(actor_id)
    return await service.book_detail(book_id)


@router.get("/admin/catalog/{book_id}/pages", response_model=list[AdminPageListRead])
async def get_admin_pages(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminCatalogService(db)
    await service.require_admin(actor_id)
    return await service.pages(book_id)


@router.get("/admin/pages/{page_id}/image", response_model=AdminPageImageRead)
async def get_admin_image(
    page_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminCatalogService(db)
    await service.require_admin(actor_id)
    return await service.image(page_id)


@router.get("/admin/pages/{page_id}/processing", response_model=AdminPageProcessingRead)
async def get_admin_processing(
    page_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminCatalogService(db)
    await service.require_admin(actor_id)
    return await service.processing_by_page_id(page_id)


@router.get("/admin/pages/{page_id}/revisions", response_model=list[AdminRevisionSummaryRead])
async def get_admin_revisions(
    page_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminCatalogService(db)
    await service.require_admin(actor_id)
    return await service.revisions(page_id)


@router.get(
    "/admin/pages/{page_id}/revisions/{revision_id}",
    response_model=AdminRevisionDetailRead,
)
async def get_admin_revision(
    page_id: UUID,
    revision_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = AdminCatalogService(db)
    await service.require_admin(actor_id)
    return await service.revision(page_id, revision_id)
