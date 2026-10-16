"""Persistence operations for book and page catalog endpoints.

Repository methods own SQLAlchemy queries and database writes. They return ORM
objects to services and never format HTTP responses.
"""
from __future__ import annotations

from uuid import UUID

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, BookPage, PageRevision, PageRevisionWord, Profile


class BookRepository:
    """Persistence-only operations used by legacy book endpoints."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_books(self) -> list[Book]:
        result = await self.db.execute(select(Book))
        return list(result.scalars().all())

    async def role(self, actor_id: UUID) -> str | None:
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == actor_id))

    async def create(self, book: Book) -> Book:
        self.db.add(book)
        try:
            await self.db.commit()
            await self.db.refresh(book)
        except Exception:
            await self.db.rollback()
            raise
        return book

    async def list_pages(self, book_id: UUID) -> list[BookPage]:
        query = select(BookPage).where(BookPage.BookId == book_id).order_by(BookPage.PageNumber)
        result = await self.db.execute(query)
        return list(result.scalars().all())


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
