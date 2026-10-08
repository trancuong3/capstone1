from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List
from uuid import UUID

from app.api.deps import get_db
from app.models import Book, BookPage
from app.schemas import BookResponse, BookCreate, BookPageResponse

router = APIRouter()

@router.get("/", response_model=List[BookResponse])
async def get_books(db: AsyncSession = Depends(get_db)):
    """Lấy danh sách tất cả các đầu sách trong hệ thống"""
    result = await db.execute(select(Book))
    return result.scalars().all()

@router.post("/", response_model=BookResponse)
async def create_book(book_in: BookCreate, db: AsyncSession = Depends(get_db)):
    """Thêm một đầu sách mới"""
    new_book = Book(**book_in.model_dump())
    db.add(new_book)
    await db.commit()
    await db.refresh(new_book)
    return new_book

@router.get("/{book_id}/pages", response_model=List[BookPageResponse])
async def get_book_pages(book_id: UUID, db: AsyncSession = Depends(get_db)):
    """Lấy danh sách các trang của một quyển sách cụ thể"""
    query = select(BookPage).where(BookPage.BookId == book_id).order_by(BookPage.PageNumber)
    result = await db.execute(query)
    return result.scalars().all()


# Scoped read endpoints; do not replace the legacy routes above.
from fastapi import Query
from sqlalchemy import and_, exists, or_
from urllib.parse import urlsplit

from app.api.deps import get_current_parent_id
from app.models import PageRevision, Profile
from app.schemas.book import CatalogBookResponse, CatalogPagePreviewResponse


class CatalogRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == actor_id))

    @staticmethod
    def eligible_page():
        return and_(
            BookPage.LifecycleStatus == "ACTIVE",
            PageRevision.Id == BookPage.CurrentVerifiedRevisionId,
            PageRevision.PageId == BookPage.Id,
            PageRevision.VerificationStatus == "VERIFIED",
        )

    @classmethod
    def eligible_book(cls):
        return and_(
            Book.LifecycleStatus == "ACTIVE",
            exists(
                select(BookPage.Id)
                .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
                .where(BookPage.BookId == Book.Id, cls.eligible_page())
            ),
        )

    @staticmethod
    def search_pattern(value: str) -> str:
        escaped = value.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return f"%{escaped}%"

    async def list(self, search: str | None, author: str | None, grade: int | None):
        query = select(Book).where(self.eligible_book())
        if search and search.strip():
            pattern = self.search_pattern(search)
            query = query.where(or_(Book.Title.ilike(pattern, escape="\\"), Book.Author.ilike(pattern, escape="\\")))
        if author is not None:
            query = query.where(Book.Author == author)
        if grade is not None:
            query = query.where(Book.MinGrade <= grade, Book.MaxGrade >= grade)
        result = await self.db.execute(query.order_by(Book.Title, Book.Id))
        return result.scalars().all()

    async def get(self, book_id: UUID):
        return await self.db.scalar(select(Book).where(Book.Id == book_id))

    async def is_eligible(self, book_id: UUID) -> bool:
        return (await self.db.scalar(select(Book.Id).where(Book.Id == book_id, self.eligible_book()))) is not None

    async def previews(self, book_id: UUID):
        result = await self.db.execute(
            select(BookPage)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(BookPage.BookId == book_id, self.eligible_page())
            .order_by(BookPage.PageNumber, BookPage.Id)
        )
        return result.scalars().all()


class CatalogService:
    def __init__(self, repository: CatalogRepository):
        self.repository = repository

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
            try:
                path = urlsplit(page.ImagePath)
                valid_url = (path.scheme in ("https", "http") and path.hostname
                             and not path.username and not path.password)
                # Accessing port also validates malformed ports in stored URLs.
                path.port
            except ValueError:
                valid_url = False
            if not valid_url:
                # Relative Storage paths need a real bucket/access policy first.
                raise HTTPException(status_code=503, detail="Preview is not available yet")
            previews.append(CatalogPagePreviewResponse(
                page_id=page.Id,
                page_number=page.PageNumber,
                lifecycle_status=page.LifecycleStatus,
                current_verified_revision_id=page.CurrentVerifiedRevisionId,
                preview_url=page.ImagePath,
            ))
        return previews


@router.get("/catalog", response_model=list[CatalogBookResponse])
async def get_parent_catalog(
    search: str | None = Query(default=None),
    author: str | None = Query(default=None),
    grade: int | None = Query(default=None, ge=1, le=5),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = CatalogService(CatalogRepository(db))
    await service.require_parent(actor_id)
    return await service.list(search, author, grade)


@router.get("/catalog/{book_id}", response_model=CatalogBookResponse)
async def get_parent_catalog_book(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = CatalogService(CatalogRepository(db))
    await service.require_parent(actor_id)
    return await service.get(book_id)


@router.get("/catalog/{book_id}/preview", response_model=list[CatalogPagePreviewResponse])
async def get_parent_catalog_previews(
    book_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    service = CatalogService(CatalogRepository(db))
    await service.require_parent(actor_id)
    return await service.previews(book_id)


from typing import Literal
from pydantic import ValidationError
from app.models import PageRevisionWord
from app.schemas.book import (
    AdminCatalogBookResponse, AdminPageListRead, AdminPageProcessingRead,
    AdminPageImageRead, AdminRevisionSummaryRead, AdminRevisionDetailRead,
)


class AdminCatalogRepository(CatalogRepository):
    async def books(self, search: str | None, lifecycle_status: str | None):
        query = select(Book)
        if search and search.strip():
            pattern = self.search_pattern(search)
            query = query.where(or_(Book.Title.ilike(pattern, escape="\\"), Book.Author.ilike(pattern, escape="\\")))
        if lifecycle_status is not None:
            query = query.where(Book.LifecycleStatus == lifecycle_status)
        result = await self.db.execute(query.order_by(Book.Title, Book.Id))
        return result.scalars().all()

    async def pages(self, book_id: UUID):
        result = await self.db.execute(select(BookPage).where(BookPage.BookId == book_id).order_by(BookPage.PageNumber, BookPage.Id))
        return result.scalars().all()

    async def page(self, page_id: UUID):
        return await self.db.scalar(select(BookPage).where(BookPage.Id == page_id))

    async def revisions(self, page_id: UUID):
        result = await self.db.execute(select(PageRevision).where(PageRevision.PageId == page_id).order_by(PageRevision.CreatedAt.desc(), PageRevision.Id.desc()))
        return result.scalars().all()

    async def revision(self, page_id: UUID, revision_id: UUID):
        return await self.db.scalar(select(PageRevision).where(PageRevision.Id == revision_id, PageRevision.PageId == page_id))

    async def words(self, revision_id: UUID):
        result = await self.db.execute(select(PageRevisionWord).where(PageRevisionWord.PageRevisionId == revision_id).order_by(PageRevisionWord.WordIndex, PageRevisionWord.Id))
        return result.scalars().all()


class AdminCatalogService:
    def __init__(self, repository: AdminCatalogRepository):
        self.repository = repository

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

    async def pages(self, book_id: UUID):
        await self.book(book_id)
        try:
            return [AdminPageListRead(book_id=page.BookId, page_number=page.PageNumber, processing=await self.processing(page)) for page in await self.repository.pages(book_id)]
        except ValidationError:
            raise HTTPException(status_code=501, detail="Page list contract is not available yet") from None

    async def image(self, page_id: UUID):
        page = await self.page(page_id)
        try:
            path = urlsplit(page.ImagePath)
            valid_url = path.scheme in ("https", "http") and bool(path.hostname) and not path.username and not path.password
            path.port  # Reject malformed ports without exposing the stored path.
        except (TypeError, ValueError):
            valid_url = False
        if not valid_url:
            raise HTTPException(status_code=503, detail="Image is not available yet")
        try:
            return AdminPageImageRead(page_id=page.Id, page_number=page.PageNumber, preview_url=page.ImagePath, width=page.Width, height=page.Height)
        except ValidationError:
            raise HTTPException(status_code=501, detail="Image contract is not available yet") from None

    async def revisions(self, page_id: UUID):
        page = await self.page(page_id)
        try:
            return [AdminRevisionSummaryRead(
                page_revision_id=revision.Id, revision_no=self.revision_number(revision),
                verification_status=revision.VerificationStatus, created_at=revision.CreatedAt,
                is_current_verified=revision.Id == page.CurrentVerifiedRevisionId,
            ) for revision in await self.repository.revisions(page_id)]
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
            if not isinstance(box, dict) or not all(key in box for key in ("x", "y", "width", "height")):
                raise HTTPException(status_code=501, detail="Word bounding box contract is not available yet")
            bbox = tuple(box[key] for key in ("x", "y", "width", "height"))
            if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1 for value in bbox):
                raise HTTPException(status_code=501, detail="Normalized bounding box is not available yet")
            words.append({"word_index": word.WordIndex, "line_index": word.LineIndex, "text": word.Text,
                          "normalized_text": word.NormalizedText, "bbox": bbox, "ocr_confidence": word.OCRConfidence})
        try:
            return AdminRevisionDetailRead(
                page_id=page.Id, page_revision_id=revision.Id, revision_no=self.revision_number(revision),
                verification_status=revision.VerificationStatus, lifecycle_status=page.LifecycleStatus,
                draft_text=revision.VerifiedText, words=words, ocr_metadata={}, created_at=revision.CreatedAt,
                verified_at=revision.VerifiedAt, verified_by=revision.VerifiedBy,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Revision detail contract is not available yet") from None


@router.get("/admin/catalog", response_model=list[AdminCatalogBookResponse])
async def get_admin_catalog(
    search: str | None = None,
    lifecycle_status: Literal["ACTIVE", "RETIRED"] | None = None,
    verification_status: Literal["PROCESSING", "NEEDS_REVIEW", "VERIFIED"] | None = None,
    actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db),
):
    service = AdminCatalogService(AdminCatalogRepository(db))
    await service.require_admin(actor_id)
    return await service.list(search, lifecycle_status, verification_status)


@router.get("/admin/catalog/{book_id}", response_model=CatalogBookResponse)
async def get_admin_book(book_id: UUID, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    service = AdminCatalogService(AdminCatalogRepository(db))
    await service.require_admin(actor_id)
    return await service.book(book_id)


@router.get("/admin/catalog/{book_id}/pages", response_model=list[AdminPageListRead])
async def get_admin_pages(book_id: UUID, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    service = AdminCatalogService(AdminCatalogRepository(db))
    await service.require_admin(actor_id)
    return await service.pages(book_id)


@router.get("/admin/pages/{page_id}/image", response_model=AdminPageImageRead)
async def get_admin_image(page_id: UUID, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    service = AdminCatalogService(AdminCatalogRepository(db))
    await service.require_admin(actor_id)
    return await service.image(page_id)


@router.get("/admin/pages/{page_id}/processing", response_model=AdminPageProcessingRead)
async def get_admin_processing(page_id: UUID, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    service = AdminCatalogService(AdminCatalogRepository(db))
    await service.require_admin(actor_id)
    return await service.processing(await service.page(page_id))


@router.get("/admin/pages/{page_id}/revisions", response_model=list[AdminRevisionSummaryRead])
async def get_admin_revisions(page_id: UUID, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    service = AdminCatalogService(AdminCatalogRepository(db))
    await service.require_admin(actor_id)
    return await service.revisions(page_id)


@router.get("/admin/pages/{page_id}/revisions/{revision_id}", response_model=AdminRevisionDetailRead)
async def get_admin_revision(page_id: UUID, revision_id: UUID, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    service = AdminCatalogService(AdminCatalogRepository(db))
    await service.require_admin(actor_id)
    return await service.revision(page_id, revision_id)
