"""HTTP routes for books, parent catalog, and admin catalog reads."""
from __future__ import annotations

import asyncio
import inspect
from typing import Any, List, Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db, require_active_profile_id
from app.database.role_cache import get_cached_profile_role
from app.schemas import BookCreate, BookPageResponse, BookResponse
from app.schemas.book import (
    AdminBookMetadataResponse,
    AdminCatalogBookDetailResponse,
    AdminCatalogBookResponse,
    AdminPageImageRead,
    AdminPageListRead,
    AdminPageProcessingRead,
    AdminRevisionDetailRead,
    AdminRevisionSummaryRead,
    CatalogBookResponse,
    CatalogPagePreviewResponse,
    PublicBookResponse,
)
from app.repositories.metadata_quality_repository import MetadataQualityRepository
from app.repositories.admin_book_repository import AdminBookRepository
from app.schemas.metadata_quality import MetadataQualityIssueType, MetadataQualityResponse
from app.schemas.admin_book import (
    AdminBookLifecycleRequest,
    AdminBookSoftDeleteResponse,
    AdminBookWriteRequest,
)
from app.services.book_service import AdminCatalogService, BookService, CatalogService
from app.services.admin_book_service import AdminBookService
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
    search = search if isinstance(search, str) else None
    issue_type = issue_type if isinstance(issue_type, str) else None
    lifecycle_status = lifecycle_status if isinstance(lifecycle_status, str) else None
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 10
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    service = MetadataQualityService(MetadataQualityRepository(db))
    return await service.dashboard(
        actor_id,
        search=search,
        issue_type=issue_type,
        lifecycle_status=lifecycle_status,
        limit=limit,
        offset=offset,
    )


async def _verify_optional_active_actor(
    request: Request,
    db: AsyncSession,
) -> UUID | None:
    """Cryptographically verify optional Bearer JWT + active profile before minting signed URLs.

    Unauthenticated requests (no Authorization header) return None so public catalog
    metadata stays available without minting Storage signed URLs. Any supplied
    Authorization header MUST verify to an active parent/admin profile or fail closed.
    """
    auth_header = (request.headers.get("authorization") or "").strip()
    if not auth_header:
        return None
    if not auth_header.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )
    token = auth_header[7:].strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )

    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    overrides = getattr(getattr(request, "app", None), "dependency_overrides", None) or {}
    override = overrides.get(require_active_profile_id) or overrides.get(get_current_parent_id)
    if override is not None:
        sig = inspect.signature(override)
        override_kwargs: dict[str, Any] = {}
        for param_name, param in sig.parameters.items():
            if param.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
                continue
            if param_name == "credentials":
                override_kwargs[param_name] = credentials
            elif param_name == "db":
                override_kwargs[param_name] = db
            elif param_name == "request":
                override_kwargs[param_name] = request
        result = override(**override_kwargs)
        actor_id = await result if inspect.isawaitable(result) else result
        actor_uuid = actor_id if isinstance(actor_id, UUID) else UUID(str(actor_id))
        if require_active_profile_id in overrides:
            return actor_uuid
    else:
        actor_uuid = await asyncio.to_thread(get_current_parent_id, credentials)

    role = await get_cached_profile_role(db, actor_uuid)
    if role not in ("parent", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is inactive or unavailable",
        )
    return actor_uuid


def _apply_optional_slice(items: list[Any], limit: int | None, offset: int) -> list[Any]:
    safe_offset = (
        offset
        if isinstance(offset, int) and not isinstance(offset, bool) and offset > 0
        else 0
    )
    safe_limit = (
        limit
        if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0
        else None
    )
    if safe_offset == 0 and safe_limit is None:
        return items
    return items[safe_offset : (safe_offset + safe_limit if safe_limit is not None else None)]


@router.get("/", response_model=List[PublicBookResponse])
async def get_books(
    limit: int | None = Query(default=None, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """Return eligible catalog books without exposing internal admin creator IDs."""
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else None
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    return _apply_optional_slice(await BookService(db).list_books(), limit, offset)


@router.post("/", response_model=BookResponse)
async def create_book(
    book_in: BookCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Create a book after the service verifies admin authorization."""
    return await BookService(db).create_book(actor_id, book_in)


@router.get("/{book_id}/pages", response_model=List[BookPageResponse])
async def get_book_pages(
    book_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Return pages for an eligible catalog book; mint signed URLs only for verified active users."""
    from app.services import storage_service as _storage_service
    from app.services.storage_service import create_cached_signed_image_urls

    verified_actor_id = await _verify_optional_active_actor(request, db)
    pages = await BookService(db).list_pages(
        book_id,
        is_authenticated=verified_actor_id is not None,
    )

    # Snapshot scalar page fields and release the DB read transaction before Storage I/O.
    page_snapshots = [
        (
            page.Id,
            page.BookId,
            page.PageNumber,
            str(getattr(page, "ImagePath", "") or "").strip(),
            page.Width,
            page.Height,
            page.LifecycleStatus,
            page.CurrentVerifiedRevisionId,
            page.CreatedAt,
        )
        for page in pages
    ]
    if hasattr(db, "rollback") and inspect.iscoroutinefunction(db.rollback):
        await db.rollback()

    signed_by_path: dict[str, str] = {}
    if verified_actor_id is not None:
        raw_paths_to_sign: list[str] = []
        for _, _, _, raw_image_path, *_ in page_snapshots:
            if not raw_image_path or "://" in raw_image_path:
                continue
            if raw_image_path not in raw_paths_to_sign:
                raw_paths_to_sign.append(raw_image_path)
        if raw_paths_to_sign:
            try:
                try:
                    signed_urls = await asyncio.to_thread(
                        create_cached_signed_image_urls,
                        raw_paths_to_sign,
                    )
                except TypeError:
                    signed_urls = await asyncio.to_thread(
                        _storage_service.create_signed_image_urls,
                        raw_paths_to_sign,
                    )
                signed_by_path = dict(zip(raw_paths_to_sign, signed_urls))
            except Exception:
                signed_by_path = {}

    sanitized: list[BookPageResponse] = []
    for (
        page_id,
        row_book_id,
        page_number,
        raw_image_path,
        width,
        height,
        lifecycle_status,
        verified_rev_id,
        created_at,
    ) in page_snapshots:
        safe_image_url = ""
        parsed = urlsplit(raw_image_path)
        if parsed.scheme == "https" and parsed.netloc and not parsed.username and not parsed.password:
            safe_image_url = raw_image_path
        elif verified_actor_id is not None and raw_image_path in signed_by_path:
            safe_image_url = signed_by_path[raw_image_path] or ""
        sanitized.append(
            BookPageResponse(
                Id=page_id,
                BookId=row_book_id,
                PageNumber=page_number,
                ImagePath=safe_image_url,
                Width=width,
                Height=height,
                FeaturePath=None,
                ProcessingMeta={},
                LifecycleStatus=lifecycle_status,
                CurrentVerifiedRevisionId=verified_rev_id,
                CreatedAt=created_at,
            )
        )
    return sanitized


@router.get("/catalog", response_model=list[CatalogBookResponse])
async def get_parent_catalog(
    response: Response,
    search: str | None = Query(default=None),
    author: str | None = Query(default=None),
    grade: int | None = Query(default=None, ge=1, le=5),
    include_private: bool = Query(default=False),
    limit: int | None = Query(default=None, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    search = search if isinstance(search, str) else None
    author = author if isinstance(author, str) else None
    grade = grade if isinstance(grade, int) and not isinstance(grade, bool) else None
    include_private = include_private if isinstance(include_private, bool) else False
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else None
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    service = CatalogService(db)
    await service.require_parent(actor_id)
    if include_private:
        response.headers["Cache-Control"] = "private, no-store, max-age=0"
        response.headers["Vary"] = "Authorization"
    items = await service.list(
        search,
        author,
        grade,
        actor_id=actor_id,
        include_private=include_private,
    )
    return _apply_optional_slice(items, limit, offset)


@router.get("/catalog/{book_id}", response_model=CatalogBookResponse)
async def get_parent_catalog_book(
    book_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = CatalogService(db)
    await service.require_parent(actor_id)
    result = await service.get(book_id, actor_id=actor_id)
    if result.visibility_scope == "PARENT_PRIVATE":
        response.headers["Cache-Control"] = "private, no-store, max-age=0"
        response.headers["Vary"] = "Authorization"
    return result


@router.get("/catalog/{book_id}/preview", response_model=list[CatalogPagePreviewResponse])
async def get_parent_catalog_previews(
    book_id: UUID,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = CatalogService(db)
    await service.require_parent(actor_id)
    response.headers["Cache-Control"] = "private, no-store, max-age=0"
    response.headers["Vary"] = "Authorization"
    return await service.previews(
        book_id,
        actor_id=actor_id,
        base_url=str(request.base_url),
    )


@router.post(
    "/admin/catalog",
    response_model=AdminBookMetadataResponse,
    status_code=201,
)
async def create_admin_book(
    payload: AdminBookWriteRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Create an Admin catalog entry through schema, service, and repository layers."""
    return await AdminBookService(AdminBookRepository(db)).create(actor_id, payload)


@router.put(
    "/admin/catalog/{book_id}",
    response_model=AdminBookMetadataResponse,
)
async def update_admin_book(
    book_id: UUID,
    payload: AdminBookWriteRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminBookService(AdminBookRepository(db)).update(actor_id, book_id, payload)


@router.patch(
    "/admin/catalog/{book_id}/status",
    response_model=AdminBookMetadataResponse,
)
async def update_admin_book_status(
    book_id: UUID,
    payload: AdminBookLifecycleRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminBookService(AdminBookRepository(db)).update_lifecycle(
        actor_id, book_id, payload.status
    )


@router.delete(
    "/admin/catalog/{book_id}",
    response_model=AdminBookSoftDeleteResponse,
)
async def delete_admin_book(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await AdminBookService(AdminBookRepository(db)).soft_delete(actor_id, book_id)


@router.get("/admin/catalog", response_model=list[AdminCatalogBookResponse])
async def get_admin_catalog(
    search: str | None = None,
    lifecycle_status: Literal["ACTIVE", "RETIRED"] | None = None,
    verification_status: Literal["PROCESSING", "NEEDS_REVIEW", "VERIFIED"] | None = None,
    limit: int | None = Query(default=None, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    search = search if isinstance(search, str) else None
    lifecycle_status = lifecycle_status if isinstance(lifecycle_status, str) else None
    verification_status = (
        verification_status if isinstance(verification_status, str) else None
    )
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else None
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    service = AdminCatalogService(db)
    await service.require_admin(actor_id)
    items = await service.list(search, lifecycle_status, verification_status)
    return _apply_optional_slice(items, limit, offset)


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
    revision_id: UUID | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    revision_id = revision_id if isinstance(revision_id, (UUID, str)) else None
    service = AdminCatalogService(db)
    await service.require_admin(actor_id)
    return await service.image(page_id, revision_id)


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
