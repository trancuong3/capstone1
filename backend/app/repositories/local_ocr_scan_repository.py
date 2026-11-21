"""Persistence queries for parent-authorized local OCR page scanning.

Only reads verified, child-safety-approved catalog books and pages.
"""
from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.role_cache import get_cached_profile_role
from app.models import Book, BookPage, ChildProfile, PageRevision, PageRevisionWord
from app.repositories.book_repository import CatalogRepository


class LocalOcrScanRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def profile_role(self, actor_id: UUID) -> str | None:
        return await get_cached_profile_role(self.db, actor_id)

    async def child_belongs_to_parent(self, child_id: UUID, actor_id: UUID) -> bool:
        found = await self.db.scalar(
            select(ChildProfile.Id).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == actor_id,
            )
        )
        return found is not None

    async def eligible_verified_pages(
        self, book_id: UUID | None = None
    ) -> list[tuple[Book, BookPage, PageRevision]]:
        query = (
            select(Book, BookPage, PageRevision)
            .join(BookPage, BookPage.BookId == Book.Id)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                CatalogRepository.eligible_book(),
                CatalogRepository.eligible_page(),
            )
            .order_by(Book.Id, BookPage.PageNumber)
        )
        if book_id is not None:
            query = query.where(Book.Id == book_id)
        result = await self.db.execute(query)
        return list(result.all())

    async def revision_words(self, revision_id: UUID) -> list[PageRevisionWord]:
        result = await self.db.execute(
            select(PageRevisionWord)
            .where(PageRevisionWord.PageRevisionId == revision_id)
            .order_by(PageRevisionWord.WordIndex, PageRevisionWord.Id)
        )
        return list(result.scalars().all())
