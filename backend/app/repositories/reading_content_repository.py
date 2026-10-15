from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, BookPage, ChildProfile, PageRevision, PageRevisionWord, Profile, ReadingSession


class ReadingContentRepository:
    """Persistence-only access for reading sessions and verified catalog content."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def profile_role(self, profile_id: UUID) -> str | None:
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == profile_id))

    async def child_belongs_to_parent(self, child_id: UUID, parent_id: UUID) -> bool:
        found = await self.db.scalar(
            select(ChildProfile.Id).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
            )
        )
        return found is not None

    async def verified_page(self, page_id: UUID, book_id: UUID | None = None) -> BookPage | None:
        query = (
            select(BookPage)
            .join(Book, Book.Id == BookPage.BookId)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                BookPage.Id == page_id,
                BookPage.LifecycleStatus == "ACTIVE",
                Book.LifecycleStatus == "ACTIVE",
                PageRevision.PageId == BookPage.Id,
                PageRevision.VerificationStatus == "VERIFIED",
            )
        )
        if book_id is not None:
            query = query.where(BookPage.BookId == book_id)
        return await self.db.scalar(query)

    async def first_verified_page(self, book_id: UUID) -> BookPage | None:
        return await self.db.scalar(
            select(BookPage)
            .join(Book, Book.Id == BookPage.BookId)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
                Book.LifecycleStatus == "ACTIVE",
                PageRevision.PageId == BookPage.Id,
                PageRevision.VerificationStatus == "VERIFIED",
            )
            .order_by(BookPage.PageNumber, BookPage.Id)
            .limit(1)
        )

    async def verified_revision(
        self,
        page_id: UUID,
        revision_id: UUID | None = None,
    ) -> PageRevision | None:
        query = select(PageRevision).where(
            PageRevision.PageId == page_id,
            PageRevision.VerificationStatus == "VERIFIED",
        )
        if revision_id is not None:
            query = query.where(PageRevision.Id == revision_id)
        else:
            query = query.order_by(PageRevision.CreatedAt.desc(), PageRevision.Id.desc()).limit(1)
        return await self.db.scalar(query)

    async def revision_words(self, revision_id: UUID) -> list[PageRevisionWord]:
        result = await self.db.execute(
            select(PageRevisionWord)
            .where(PageRevisionWord.PageRevisionId == revision_id)
            .order_by(PageRevisionWord.WordIndex)
        )
        return list(result.scalars().all())

    async def session(self, session_id: UUID) -> ReadingSession | None:
        return await self.db.scalar(
            select(ReadingSession).where(ReadingSession.Id == session_id)
        )

    async def create_session(self, session: ReadingSession) -> ReadingSession:
        self.db.add(session)
        try:
            await self.db.commit()
            await self.db.refresh(session)
        except Exception:
            await self.db.rollback()
            raise
        return session
