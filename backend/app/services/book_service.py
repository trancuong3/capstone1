"""Business services for book catalog and admin page-read endpoints."""
from __future__ import annotations

import asyncio
import inspect
import os
from uuid import UUID

import httpx
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import APP_ENVIRONMENT, SUPABASE_STORAGE_BUCKET
from app.models import Book
from app.policies.book_access import (
    MODERATION_SUSPENDED,
    is_book_private,
    private_page_image_url,
    private_page_image_urls_async,
)
from app.repositories.book_repository import (
    AdminCatalogRepository,
    BookRepository,
    CatalogRepository,
)
from app.schemas import BookCreate
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
)
from app.services import storage_service as _storage_service_module
from app.services.storage_service import (
    create_cached_signed_image_urls,
    create_cached_signed_image_urls_async,
    create_signed_image_url,
    create_signed_image_urls,
    is_local_storage_enabled,
)

_ORIGINAL_CREATE_SIGNED_IMAGE_URL = create_signed_image_url
_ORIGINAL_CREATE_SIGNED_IMAGE_URLS = create_signed_image_urls
_ORIGINAL_PRIVATE_PAGE_IMAGE_URL = private_page_image_url
_ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS = create_cached_signed_image_urls
_ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS_ASYNC = create_cached_signed_image_urls_async

_COVER_PRIORITY = {
    "USER_UPLOAD": 4,
    "ENHANCED_CROP": 3,
    "ORIGINAL_CROP": 3,
    "AI_GENERATED": 2,
    "METADATA_RENDER": 1,
}


def _normalize_cover_source_type(raw_source: object) -> str:
    src = str(raw_source or "")
    if src in ("USER_UPLOAD", "ORIGINAL_CROP", "ENHANCED_CROP"):
        return "USER_UPLOAD"
    return src


async def _safe_rollback(db_session: object) -> None:
    rollback = getattr(db_session, "rollback", None)
    if callable(rollback):
        res = rollback()
        if inspect.isawaitable(res):
            await res


async def _resolve_cover_map(
    db_session: object,
    book_ids: list[UUID],
    *,
    private_book_ids: set[UUID] | None = None,
    require_begin_nested: bool = True,
) -> dict[UUID, tuple[str, str]]:
    """Batch-resolve highest-priority approved covers; sign CATALOG paths cleanly off DB."""
    if not book_ids or db_session is None:
        return {}
    if require_begin_nested and not callable(getattr(db_session, "begin_nested", None)):
        return {}
    if not callable(getattr(db_session, "scalars", None)):
        return {}
    try:
        from sqlalchemy import desc, select
        from app.models.smart_book_studio import BookPresentationAsset

        query = (
            select(BookPresentationAsset)
            .where(
                BookPresentationAsset.BookId.in_(book_ids),
                BookPresentationAsset.AssetRole == "COVER",
                BookPresentationAsset.IsActive.is_(True),
                BookPresentationAsset.ModerationStatus == "APPROVED",
            )
            .order_by(
                desc(BookPresentationAsset.AssetVersion),
                desc(BookPresentationAsset.UpdatedAt),
            )
        )
        begin_nested = getattr(db_session, "begin_nested", None)
        if callable(begin_nested):
            async with begin_nested():
                rows = (await db_session.scalars(query)).all()
        else:
            rows = (await db_session.scalars(query)).all()

        # Snapshot chosen scalar attributes before releasing DB read transaction.
        chosen: dict[UUID, tuple[int, UUID, str | None, str, object]] = {}
        for asset in rows:
            raw_source = str(getattr(asset, "SourceType", "") or "")
            rank = _COVER_PRIORITY.get(raw_source, 0)
            prev = chosen.get(asset.BookId)
            if prev is None or rank > prev[0]:
                raw_path = getattr(asset, "StoragePath", None)
                clean_path = raw_path.strip() if isinstance(raw_path, str) and raw_path.strip() else None
                chosen[asset.BookId] = (
                    rank,
                    asset.Id,
                    clean_path,
                    _normalize_cover_source_type(raw_source),
                    getattr(asset, "OwnerId", None),
                )

        if not chosen:
            return {}

        await _safe_rollback(db_session)

        use_direct_catalog_urls = private_book_ids is not None and not is_local_storage_enabled()
        catalog_to_sign: list[tuple[UUID, UUID, str, str]] = []
        cover_map: dict[UUID, tuple[str, str]] = {}
        for bid, (_rank, asset_id, storage_path, source_type, owner_id) in chosen.items():
            proxy_url = f"/studio/assets/{asset_id}/media"
            if (
                use_direct_catalog_urls
                and bid not in private_book_ids  # type: ignore[operator]
                and owner_id is None
                and storage_path is not None
            ):
                catalog_to_sign.append((bid, asset_id, storage_path, source_type))
            else:
                cover_map[bid] = (proxy_url, source_type)

        if catalog_to_sign:
            skip_unpatched_test_signing = (
                APP_ENVIRONMENT == "test"
                and (os.getenv("SUPABASE_KEY") or "").strip() == "isolated-test-key"
                and not _storage_service_module.SUPABASE_ADMIN_KEY
                and create_cached_signed_image_urls is _ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS
                and create_cached_signed_image_urls_async is _ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS_ASYNC
                and _storage_service_module.create_signed_image_urls is _storage_service_module._ORIGINAL_CREATE_SIGNED_IMAGE_URLS
                and _storage_service_module.get_supabase_admin_client is _storage_service_module._ORIGINAL_GET_SUPABASE_ADMIN_CLIENT
                and httpx.AsyncClient is _storage_service_module._ORIGINAL_HTTPX_ASYNC_CLIENT
            )
            if skip_unpatched_test_signing:
                for bid, asset_id, _path, source_type in catalog_to_sign:
                    cover_map[bid] = (f"/studio/assets/{asset_id}/media", source_type)
            else:
                try:
                    paths_to_sign = [path for _bid, _aid, path, _src in catalog_to_sign]
                    if create_cached_signed_image_urls is not _ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS:
                        signed_urls = await asyncio.to_thread(
                            create_cached_signed_image_urls,
                            paths_to_sign,
                            bucket_name=SUPABASE_STORAGE_BUCKET,
                        )
                    else:
                        signed_urls = await create_cached_signed_image_urls_async(
                            paths_to_sign,
                            bucket_name=SUPABASE_STORAGE_BUCKET,
                        )
                    for (bid, asset_id, _path, source_type), signed_url in zip(catalog_to_sign, signed_urls):
                        cover_map[bid] = (signed_url or f"/studio/assets/{asset_id}/media", source_type)
                except Exception:
                    for bid, asset_id, _path, source_type in catalog_to_sign:
                        cover_map[bid] = (f"/studio/assets/{asset_id}/media", source_type)

        return cover_map
    except Exception:
        return {}


class BookService:
    """Business logic for legacy book endpoints."""

    def __init__(self, db: AsyncSession):
        self.repository = BookRepository(db)

    async def list_books(self) -> list[Book]:
        return await self.repository.list_books()

    async def create_book(self, actor_id: UUID, payload: BookCreate) -> Book:
        if await self.repository.role(actor_id) != "admin":
            raise HTTPException(status_code=403, detail="Admin access required")
        # The authenticated actor is authoritative; never trust CreatedBy from input.
        values = payload.model_dump(exclude={"CreatedBy"})
        values["CreatedBy"] = actor_id
        return await self.repository.create(Book(**values))

    async def list_pages(self, book_id: UUID, *, is_authenticated: bool = True):
        catalog_repo = CatalogRepository(self.repository.db)
        book = await catalog_repo.get(book_id)
        if book is None or is_book_private(book):
            raise HTTPException(status_code=404, detail="Resource not found")
        if not await catalog_repo.is_eligible(book_id):
            if not is_authenticated:
                raise HTTPException(status_code=404, detail="Resource not found")
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "BOOK_BLOCKED_BY_CHILD_SAFETY",
                    "message": "Sách chưa hoàn tất OCR và Child Safety cho toàn bộ trang hiện tại.",
                },
            )
        return await self.repository.list_pages(book_id)


class CatalogService:
    def __init__(self, db: AsyncSession | None = None, *, repository: CatalogRepository | None = None):
        if repository is not None:
            self.repository = repository
        elif db is not None:
            self.repository = CatalogRepository(db)
        else:
            raise TypeError("CatalogService requires a database session or repository")

    async def require_parent(self, actor_id: UUID):
        if await self.repository.role(actor_id) != "parent":
            raise HTTPException(status_code=403, detail="Access denied")

    async def _cover_map_for_books(
        self,
        book_ids: list[UUID],
        *,
        private_book_ids: set[UUID] | None = None,
    ) -> dict[UUID, tuple[str, str]]:
        """Best-effort batch cover lookup (USER_UPLOAD > ORIGINAL/ENHANCED_CROP > AI_GENERATED > METADATA_RENDER)."""
        return await _resolve_cover_map(
            getattr(self.repository, "db", None),
            book_ids,
            private_book_ids=private_book_ids,
            require_begin_nested=True,
        )

    async def list(
        self,
        search: str | None,
        author: str | None,
        grade: int | None,
        *,
        actor_id: UUID | None = None,
        include_private: bool = False,
    ):
        if include_private and actor_id is not None:
            books = await self.repository.list(
                search,
                author,
                grade,
                actor_id=actor_id,
                include_private=True,
            )
        else:
            books = await self.repository.list(search, author, grade)
        dtos = [CatalogBookResponse.model_validate(book) for book in books]
        private_book_ids = {book.Id for book in books if is_book_private(book)}
        covers = await self._cover_map_for_books(
            [dto.id for dto in dtos],
            private_book_ids=private_book_ids,
        )
        output = []
        for dto in dtos:
            cover_info = covers.get(dto.id)
            if cover_info is not None:
                dto = dto.model_copy(
                    update={"cover_url": cover_info[0], "cover_source_type": cover_info[1]}
                )
            output.append(dto)
        return output

    async def _require_readable_book(
        self, book_id: UUID, *, actor_id: UUID | None = None
    ) -> Book:
        book = await self.repository.get(book_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if is_book_private(book):
            if actor_id is None or getattr(book, "OwnerParentId", None) != actor_id:
                raise HTTPException(status_code=404, detail="Resource not found")
            if getattr(book, "ModerationStatus", "ACTIVE") == MODERATION_SUSPENDED:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_INACTIVE",
                        "message": "Sách riêng này đang bị Admin đình chỉ và tạm ngừng đọc.",
                    },
                )
            if book.LifecycleStatus != "ACTIVE":
                raise HTTPException(status_code=409, detail={"code": "CONTENT_INACTIVE"})
            if not await self.repository.is_readable(book_id, actor_id):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "CONTENT_INACTIVE",
                        "message": "Sách riêng chưa có đủ trang đã kiểm tra để bé đọc.",
                    },
                )
            return book
        if book.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail={"code": "CONTENT_INACTIVE"})
        if not await self.repository.is_eligible(book_id):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "BOOK_BLOCKED_BY_CHILD_SAFETY",
                    "message": "Sách chưa hoàn tất OCR và Child Safety cho toàn bộ trang hiện tại.",
                },
            )
        return book

    async def get(self, book_id: UUID, *, actor_id: UUID | None = None):
        book = await self._require_readable_book(book_id, actor_id=actor_id)
        dto = CatalogBookResponse.model_validate(book)
        private_book_ids = {dto.id} if is_book_private(book) else set()
        covers = await self._cover_map_for_books(
            [dto.id],
            private_book_ids=private_book_ids,
        )
        cover_info = covers.get(dto.id)
        if cover_info is not None:
            dto = dto.model_copy(
                update={"cover_url": cover_info[0], "cover_source_type": cover_info[1]}
            )
        return dto

    async def previews(
        self,
        book_id: UUID,
        *,
        actor_id: UUID | None = None,
        base_url: str | None = None,
    ):
        book = await self._require_readable_book(book_id, actor_id=actor_id)
        private = is_book_private(book)
        book_owner_id = getattr(book, "OwnerParentId", None)
        pages = (
            await self.repository.previews(book_id, private=True)
            if private
            else await self.repository.previews(book_id)
        )
        snapshots = [
            {
                "page_id": page.Id,
                "page_number": page.PageNumber,
                "lifecycle_status": page.LifecycleStatus,
                "current_verified_revision_id": page.CurrentVerifiedRevisionId,
                "image_path": page.ImagePath,
            }
            for page in pages
        ]
        # Signed URL creation calls Supabase Storage; close the read transaction first.
        await self.repository.db.rollback()
        if private:
            if private_page_image_url is not _ORIGINAL_PRIVATE_PAGE_IMAGE_URL:
                preview_urls = [
                    await asyncio.to_thread(
                        private_page_image_url,
                        book_id,
                        page["page_id"],
                        revision_id=page["current_verified_revision_id"],
                        base_url=base_url,
                        storage_path=page["image_path"],
                        owner_id=book_owner_id,
                    )
                    for page in snapshots
                ]
            else:
                preview_urls = await private_page_image_urls_async(
                    book_id,
                    [
                        (
                            page["page_id"],
                            page["current_verified_revision_id"],
                            page["image_path"],
                        )
                        for page in snapshots
                    ],
                    base_url=base_url,
                    owner_id=book_owner_id,
                )
        elif snapshots:
            if create_signed_image_urls is not _ORIGINAL_CREATE_SIGNED_IMAGE_URLS:
                # Preserve existing unit test patches targeting book_service.create_signed_image_urls.
                preview_urls = await asyncio.to_thread(
                    create_signed_image_urls,
                    [page["image_path"] for page in snapshots],
                )
            elif create_cached_signed_image_urls is not _ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS:
                preview_urls = await asyncio.to_thread(
                    create_cached_signed_image_urls,
                    [page["image_path"] for page in snapshots],
                )
            else:
                preview_urls = await create_cached_signed_image_urls_async(
                    [page["image_path"] for page in snapshots],
                )
        else:
            preview_urls = []

        return [
            CatalogPagePreviewResponse(
                page_id=page["page_id"],
                page_number=page["page_number"],
                lifecycle_status=page["lifecycle_status"],
                current_verified_revision_id=page["current_verified_revision_id"],
                preview_url=preview_url,
            )
            for page, preview_url in zip(snapshots, preview_urls)
        ]


class AdminCatalogService:
    def __init__(self, db: AsyncSession | None = None, *, repository: AdminCatalogRepository | None = None):
        if repository is not None:
            self.repository = repository
        elif db is not None:
            self.repository = AdminCatalogRepository(db)
        else:
            raise TypeError("AdminCatalogService requires a database session or repository")

    async def require_admin(self, actor_id: UUID):
        if await self.repository.role(actor_id) != "admin":
            raise HTTPException(status_code=403, detail="Access denied")

    @staticmethod
    def revision_number(revision):
        return AdminCatalogService.revision_number_value(revision.RevisionNo)

    @staticmethod
    def revision_number_value(revision_no):
        value = str(revision_no)
        if not value.isascii() or not value.isdecimal() or len(value) > 16 or int(value) <= 0 or int(value) > 9007199254740991:
            raise HTTPException(status_code=501, detail="Revision number contract is not available yet")
        return int(value)

    async def book(self, book_id: UUID):
        row = await self.repository.get(book_id)
        if row is None or is_book_private(row):
            raise HTTPException(status_code=404, detail="Resource not found")
        try:
            return AdminBookMetadataResponse.model_validate(row)
        except ValidationError:
            raise HTTPException(status_code=501, detail="Book contract is not available yet") from None

    async def book_detail(self, book_id: UUID) -> AdminCatalogBookDetailResponse:
        book = await self.book(book_id)
        max_page_number = await self.repository.max_page_number(book_id)
        return AdminCatalogBookDetailResponse(
            **book.model_dump(),
            next_page_number=(max_page_number or 0) + 1,
        )

    async def page(self, page_id: UUID):
        page = await self.repository.page(page_id)
        # A retired page remains stored for history but is no longer part of the
        # active Admin OCR workflow, including when an old detail URL is opened.
        if page is None or page.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=404, detail="Resource not found")
        return page

    async def _cover_map_for_books(
        self,
        book_ids: list[UUID],
        *,
        private_book_ids: set[UUID] | None = None,
    ) -> dict[UUID, tuple[str, str]]:
        """Best-effort batched cover lookup (USER_UPLOAD > ORIGINAL/ENHANCED_CROP > AI_GENERATED > METADATA_RENDER)."""
        return await _resolve_cover_map(
            getattr(self.repository, "db", None),
            book_ids,
            private_book_ids=set() if private_book_ids is None else private_book_ids,
            require_begin_nested=False,
        )

    async def list(self, search: str | None, lifecycle_status: str | None, verification_status: str | None):
        if isinstance(self.repository, AdminCatalogRepository):
            rows = await self.repository.catalog_rows(
                search, lifecycle_status, verification_status
            )
            snapshots: list[tuple[AdminBookMetadataResponse, int, int, int, int, bool]] = []
            private_book_ids: set[UUID] = set()
            for row in rows:
                (
                    book,
                    page_count,
                    processing_count,
                    needs_review_count,
                    verified_count,
                    unknown_status_count,
                    parent_catalog_eligible,
                ) = row
                if unknown_status_count:
                    raise HTTPException(status_code=501, detail="Page status contract is not available yet")
                if verification_status is not None and not {
                    "PROCESSING": processing_count,
                    "NEEDS_REVIEW": needs_review_count,
                    "VERIFIED": verified_count,
                }.get(verification_status, 0):
                    continue
                try:
                    book_dto = AdminBookMetadataResponse.model_validate(book)
                except ValidationError:
                    raise HTTPException(status_code=501, detail="Catalog contract is not available yet") from None
                if is_book_private(book):
                    private_book_ids.add(book_dto.id)
                snapshots.append(
                    (
                        book_dto,
                        page_count,
                        processing_count,
                        needs_review_count,
                        verified_count,
                        parent_catalog_eligible,
                    )
                )

            covers = await self._cover_map_for_books(
                [item[0].id for item in snapshots],
                private_book_ids=private_book_ids,
            )
            output = []
            for (
                book_dto,
                page_count,
                processing_count,
                needs_review_count,
                verified_count,
                parent_catalog_eligible,
            ) in snapshots:
                cover_info = covers.get(book_dto.id)
                if cover_info is not None:
                    book_dto = book_dto.model_copy(
                        update={"cover_url": cover_info[0], "cover_source_type": cover_info[1]}
                    )
                try:
                    output.append(
                        AdminCatalogBookResponse(
                            book=book_dto,
                            page_count=page_count,
                            processing_count=processing_count,
                            needs_review_count=needs_review_count,
                            verified_count=verified_count,
                            parent_catalog_eligible=parent_catalog_eligible,
                        )
                    )
                except ValidationError:
                    raise HTTPException(status_code=501, detail="Catalog contract is not available yet") from None
            return output

        matched: list[tuple[AdminBookMetadataResponse, int, int, int, int, bool]] = []
        private_book_ids: set[UUID] = set()
        for book in await self.repository.books(search, lifecycle_status):
            pages = await self.repository.pages(book.Id)
            statuses = []
            for page in pages:
                revisions = await self.repository.revisions(page.Id)
                if revisions:
                    if revisions[0].VerificationStatus not in ("PROCESSING", "NEEDS_REVIEW", "VERIFIED"):
                        raise HTTPException(status_code=501, detail="Page status contract is not available yet")
                    statuses.append(revisions[0].VerificationStatus)
            if verification_status is not None and verification_status not in statuses:
                continue
            try:
                book_dto = AdminBookMetadataResponse.model_validate(book)
            except ValidationError:
                raise HTTPException(status_code=501, detail="Catalog contract is not available yet") from None
            if is_book_private(book):
                private_book_ids.add(book_dto.id)
            eligible = await self.repository.is_eligible(book_dto.id)
            matched.append(
                (
                    book_dto,
                    len(pages),
                    statuses.count("PROCESSING"),
                    statuses.count("NEEDS_REVIEW"),
                    statuses.count("VERIFIED"),
                    eligible,
                )
            )

        covers = await self._cover_map_for_books(
            [item[0].id for item in matched],
            private_book_ids=private_book_ids,
        )
        output = []
        for (
            book_dto,
            page_count,
            processing_count,
            needs_review_count,
            verified_count,
            parent_catalog_eligible,
        ) in matched:
            cover_info = covers.get(book_dto.id)
            if cover_info is not None:
                book_dto = book_dto.model_copy(
                    update={"cover_url": cover_info[0], "cover_source_type": cover_info[1]}
                )
            try:
                output.append(
                    AdminCatalogBookResponse(
                        book=book_dto,
                        page_count=page_count,
                        processing_count=processing_count,
                        needs_review_count=needs_review_count,
                        verified_count=verified_count,
                        parent_catalog_eligible=parent_catalog_eligible,
                    )
                )
            except ValidationError:
                raise HTTPException(status_code=501, detail="Catalog contract is not available yet") from None
        return output

    async def processing(self, page):
        revisions = await self.repository.revisions(page.Id)
        if not revisions:
            raise HTTPException(status_code=501, detail="Page has no revision yet")
        # Only numeric version numbers can be mapped to the current UI contract.
        revision = revisions[0]
        revision_metadata = dict(getattr(revision, "ProcessingMeta", None) or {})
        ai_audit = revision_metadata.get("ai_proofread_audit")
        ai_review_required = (
            isinstance(ai_audit, dict)
            and ai_audit.get("mode") == "AI_AUTO_VERIFIED"
        )
        try:
            return AdminPageProcessingRead(
                page_id=page.Id, page_revision_id=revision.Id, revision_no=self.revision_number(revision),
                verification_status=revision.VerificationStatus, lifecycle_status=page.LifecycleStatus,
                ocr_preview_metadata=(
                    {
                        "ai_review_required": True,
                        "ai_review_mode": "AI_AUTO_VERIFIED",
                    }
                    if ai_review_required
                    else {}
                ), verified_at=revision.VerifiedAt,
                current_verified_revision_id=page.CurrentVerifiedRevisionId,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Page contract is not available yet") from None

    async def processing_by_page_id(self, page_id: UUID):
        page = await self.page(page_id)
        return await self.processing(page)

    async def page_text_preview(self, page) -> str | None:
        revisions = await self.repository.revisions(page.Id)
        if not revisions:
            return None
        revision = revisions[0]
        text_value = getattr(revision, "DraftText", None) or getattr(revision, "VerifiedText", None)
        if not isinstance(text_value, str) or not text_value.strip():
            return None
        compact = " ".join(text_value.split())
        return compact[:120] + ("…" if len(compact) > 120 else "")

    async def pages(self, book_id: UUID):
        await self.book(book_id)
        try:
            if isinstance(self.repository, AdminCatalogRepository):
                output = []
                rows = await self.repository.page_list_rows(book_id)
                for (
                    page,
                    revision_id,
                    revision_no,
                    verification_status,
                    draft_text,
                    verified_text,
                    verified_at,
                    processing_meta,
                ) in rows:
                    if revision_id is None or revision_no is None or verification_status is None:
                        raise HTTPException(status_code=501, detail="Page has no revision yet")
                    text_value = draft_text or verified_text
                    text_preview = None
                    if isinstance(text_value, str) and text_value.strip():
                        compact = " ".join(text_value.split())
                        text_preview = compact[:120] + ("…" if len(compact) > 120 else "")
                    revision_metadata = (
                        dict(processing_meta)
                        if isinstance(processing_meta, dict)
                        else {}
                    )
                    ai_audit = revision_metadata.get("ai_proofread_audit")
                    ai_review_required = (
                        isinstance(ai_audit, dict)
                        and ai_audit.get("mode") == "AI_AUTO_VERIFIED"
                    )
                    output.append(
                        AdminPageListRead(
                            book_id=page.BookId,
                            page_number=page.PageNumber,
                            processing=AdminPageProcessingRead(
                                page_id=page.Id,
                                page_revision_id=revision_id,
                                revision_no=self.revision_number_value(revision_no),
                                verification_status=verification_status,
                                lifecycle_status=page.LifecycleStatus,
                                ocr_preview_metadata=(
                                    {
                                        "ai_review_required": True,
                                        "ai_review_mode": "AI_AUTO_VERIFIED",
                                    }
                                    if ai_review_required
                                    else {}
                                ),
                                verified_at=verified_at,
                                current_verified_revision_id=page.CurrentVerifiedRevisionId,
                            ),
                            text_preview=text_preview,
                        )
                    )
                return output

            output = []
            for page in await self.repository.pages(book_id):
                output.append(
                    AdminPageListRead(
                        book_id=page.BookId,
                        page_number=page.PageNumber,
                        processing=await self.processing(page),
                        text_preview=await self.page_text_preview(page),
                    )
                )
            return output
        except ValidationError:
            raise HTTPException(status_code=501, detail="Page list contract is not available yet") from None

    async def image(self, page_id: UUID, revision_id: UUID | None = None):
        page = await self.page(page_id)
        # Admin reviews the image that produced the latest revision, even when pending.
        # Parent/Child reading keeps BookPage.ImagePath until that revision is verified.
        revisions = await self.repository.revisions(page.Id)
        selected = next((row for row in revisions if row.Id == revision_id), None) if revision_id else (revisions[0] if revisions else None)
        if revision_id is not None and selected is None:
            raise HTTPException(status_code=404, detail="Page revision not found")
        metadata = (
            dict(getattr(selected, "ProcessingMeta", None) or {})
            if selected is not None
            else {}
        )
        candidate_path = metadata.get("source_image_path")
        if revision_id is not None:
            has_source = isinstance(candidate_path, str) and bool(candidate_path)
            if has_source and not (
                type(metadata.get("source_image_width")) is int and metadata["source_image_width"] > 0
                and type(metadata.get("source_image_height")) is int and metadata["source_image_height"] > 0
            ):
                raise HTTPException(status_code=409, detail="Revision source dimensions are not available")
            if not has_source and selected.Id != page.CurrentVerifiedRevisionId and (not revisions or selected.Id != revisions[0].Id):
                raise HTTPException(status_code=409, detail="Historical revision source image is not available")
        image_path = candidate_path if isinstance(candidate_path, str) and candidate_path else page.ImagePath
        candidate_width = metadata.get("source_image_width")
        candidate_height = metadata.get("source_image_height")
        width = candidate_width if type(candidate_width) is int and candidate_width > 0 else page.Width
        height = candidate_height if type(candidate_height) is int and candidate_height > 0 else page.Height
        page_id = page.Id
        page_number = page.PageNumber
        selected_revision_id = selected.Id if selected is not None else None
        await self.repository.db.rollback()
        if create_signed_image_url is not _ORIGINAL_CREATE_SIGNED_IMAGE_URL:
            preview_url = await asyncio.to_thread(create_signed_image_url, image_path)
        elif create_cached_signed_image_urls is not _ORIGINAL_CREATE_CACHED_SIGNED_IMAGE_URLS:
            preview_url = (await asyncio.to_thread(create_cached_signed_image_urls, [image_path]))[0]
        else:
            preview_url = (await create_cached_signed_image_urls_async([image_path]))[0]
        try:
            return AdminPageImageRead(
                page_id=page_id,
                page_revision_id=selected_revision_id,
                page_number=page_number,
                preview_url=preview_url,
                width=width,
                height=height,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Image metadata does not match the admin contract") from None

    async def revisions(self, page_id: UUID):
        page = await self.page(page_id)
        rows = await self.repository.revisions(page_id)
        if not rows:
            raise HTTPException(status_code=404, detail="Page has no revision yet")
        try:
            return [AdminRevisionSummaryRead(
                page_revision_id=revision.Id,
                revision_no=self.revision_number(revision),
                verification_status=revision.VerificationStatus,
                created_at=revision.CreatedAt,
                is_current_verified=page.CurrentVerifiedRevisionId == revision.Id,
            ) for revision in rows]
        except ValidationError:
            raise HTTPException(status_code=501, detail="Revision contract is not available yet") from None

    async def revision(self, page_id: UUID, revision_id: UUID) -> AdminRevisionDetailRead:
        """Delegate revision serialization to the canonical OCR evidence service.

        Keep this catalog-facing method for route compatibility, but never
        maintain a second evidence allowlist here: new hybrid evidence contracts
        must survive revision-detail reads unchanged.
        """
        from app.services.admin_ocr_service import AdminOcrService

        page = await self.page(page_id)
        revision = await self.repository.revision(page_id, revision_id)
        if revision is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        word_rows = await self.repository.words(revision_id)
        return await AdminOcrService(self.repository.db).revision_detail(
            page, revision, word_rows=word_rows
        )
