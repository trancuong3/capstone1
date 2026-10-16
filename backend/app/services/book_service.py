"""Business services for book catalog and admin page-read endpoints."""
from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book
from app.repositories.book_repository import (
    AdminCatalogRepository,
    BookRepository,
    CatalogRepository,
)
from app.schemas import BookCreate
from app.schemas.book import (
    AdminCatalogBookResponse,
    AdminPageImageRead,
    AdminPageListRead,
    AdminPageProcessingRead,
    AdminRevisionDetailRead,
    AdminRevisionSummaryRead,
    CatalogBookResponse,
    CatalogPagePreviewResponse,
)
from app.services.storage_service import create_signed_image_url


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

    async def list_pages(self, book_id: UUID):
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

    async def list(self, search: str | None, author: str | None, grade: int | None):
        return [CatalogBookResponse.model_validate(book) for book in await self.repository.list(search, author, grade)]

    async def get(self, book_id: UUID):
        book = await self.repository.get(book_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if not await self.repository.is_eligible(book_id):
            raise HTTPException(status_code=409, detail={"code": "CONTENT_INACTIVE"})
        return CatalogBookResponse.model_validate(book)

    async def previews(self, book_id: UUID):
        await self.get(book_id)
        pages = await self.repository.previews(book_id)
        previews = []
        for page in pages:
            # Validate/create an image URL before projecting the remaining page fields.
            # This also returns a safe 503 for malformed legacy paths.
            preview_url = create_signed_image_url(page.ImagePath)
            previews.append(CatalogPagePreviewResponse(
                page_id=page.Id,
                page_number=page.PageNumber,
                lifecycle_status=page.LifecycleStatus,
                current_verified_revision_id=page.CurrentVerifiedRevisionId,
                preview_url=preview_url,
            ))
        return previews


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
        value = str(revision.RevisionNo)
        if not value.isascii() or not value.isdecimal() or len(value) > 16 or int(value) <= 0 or int(value) > 9007199254740991:
            raise HTTPException(status_code=501, detail="Revision number contract is not available yet")
        return int(value)

    async def book(self, book_id: UUID):
        row = await self.repository.get(book_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        try:
            return CatalogBookResponse.model_validate(row)
        except ValidationError:
            raise HTTPException(status_code=501, detail="Book contract is not available yet") from None

    async def page(self, page_id: UUID):
        page = await self.repository.page(page_id)
        if page is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        return page

    async def list(self, search: str | None, lifecycle_status: str | None, verification_status: str | None):
        output = []
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
                output.append(AdminCatalogBookResponse(
                book=CatalogBookResponse.model_validate(book), page_count=len(pages),
                processing_count=statuses.count("PROCESSING"), needs_review_count=statuses.count("NEEDS_REVIEW"),
                verified_count=statuses.count("VERIFIED"), parent_catalog_eligible=await self.repository.is_eligible(book.Id),
                ))
            except ValidationError:
                raise HTTPException(status_code=501, detail="Catalog contract is not available yet") from None
        return output

    async def processing(self, page):
        revisions = await self.repository.revisions(page.Id)
        if not revisions:
            raise HTTPException(status_code=501, detail="Page has no revision yet")
        # Only numeric version numbers can be mapped to the current UI contract.
        revision = revisions[0]
        try:
            return AdminPageProcessingRead(
                page_id=page.Id, page_revision_id=revision.Id, revision_no=self.revision_number(revision),
                verification_status=revision.VerificationStatus, lifecycle_status=page.LifecycleStatus,
                ocr_preview_metadata={}, verified_at=revision.VerifiedAt,
                current_verified_revision_id=page.CurrentVerifiedRevisionId,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Page contract is not available yet") from None

    async def page_text_preview(self, page) -> str | None:
        revisions = await self.repository.revisions(page.Id)
        if not revisions:
            return None
        revision = revisions[0]
        text_value = getattr(revision, "DraftText", None) or getattr(revision, "VerifiedText", None)
        if not isinstance(text_value, str) or not text_value.strip():
            return None
        compact = " ".join(text_value.split())
        return compact[:240] + ("…" if len(compact) > 240 else "")

    async def pages(self, book_id: UUID):
        await self.book(book_id)
        try:
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

    async def image(self, page_id: UUID):
        page = await self.page(page_id)
        preview_url = create_signed_image_url(page.ImagePath)
        try:
            return AdminPageImageRead(
                page_id=page.Id,
                page_number=page.PageNumber,
                preview_url=preview_url,
                width=page.Width,
                height=page.Height,
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

    async def revision(self, page_id: UUID, revision_id: UUID):
        page = await self.page(page_id)
        revision = await self.repository.revision(page_id, revision_id)
        if revision is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        words = []
        for word in await self.repository.words(revision_id):
            box = word.BoundingBox
            # New writes use [x, y, width, height]. Legacy object rows are read-only compatibility.
            if isinstance(box, dict):
                box = [box.get("x"), box.get("y"), box.get("width"), box.get("height")]
            if not isinstance(box, list) or len(box) != 4:
                raise HTTPException(status_code=501, detail="Word bounding box contract is not available yet")
            if not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in box):
                raise HTTPException(status_code=501, detail="Normalized bounding box is not available yet")
            x, y, width, height = [float(value) for value in box]
            if (any(value < 0 or value > 1 for value in (x, y, width, height))
                or width <= 0 or height <= 0 or x + width > 1.000001 or y + height > 1.000001):
                raise HTTPException(status_code=501, detail="Normalized bounding box is not available yet")
            words.append({
                "word_index": word.WordIndex,
                "line_index": word.LineIndex,
                "text": word.Text,
                "normalized_text": word.NormalizedText,
                "bbox": (x, y, width, height),
                "ocr_confidence": word.OCRConfidence,
            })
        raw_revision = str(revision.RevisionNo)
        if not raw_revision.isascii() or not raw_revision.isdecimal() or int(raw_revision) < 1:
            raise HTTPException(status_code=501, detail="Revision number contract is not available yet")
        try:
            return AdminRevisionDetailRead(
                page_id=page.Id,
                page_revision_id=revision.Id,
                revision_no=int(raw_revision),
                verification_status=revision.VerificationStatus,
                lifecycle_status=page.LifecycleStatus,
                draft_text=getattr(revision, "DraftText", None) if getattr(revision, "DraftText", None) is not None else revision.VerifiedText,
                words=words,
                # Only explicitly approved fields should be exposed by this public DTO.
                ocr_metadata={},
                created_at=revision.CreatedAt,
                verified_at=revision.VerifiedAt,
                verified_by=revision.VerifiedBy,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Revision contract is not available yet") from None
