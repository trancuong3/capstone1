"""Read-only ORM access for the tutor's session, page and word context."""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    ChildProfile,
    PageRevision,
    PageRevisionWord,
    Profile,
    ReadingSession,
)


@dataclass(frozen=True)
class TutorSessionRecord:
    session: ReadingSession
    child: ChildProfile


@dataclass(frozen=True)
class TutorPageRecord:
    book: Book
    page: BookPage
    revision: PageRevision


class TutorRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def profile(self, actor_id: UUID) -> Profile | None:
        return await self.db.scalar(select(Profile).where(Profile.Id == actor_id))

    async def owned_session(
        self, session_id: UUID, parent_id: UUID
    ) -> TutorSessionRecord | None:
        result = await self.db.execute(
            select(ReadingSession, ChildProfile)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(
                ReadingSession.Id == session_id,
                ChildProfile.ParentId == parent_id,
            )
        )
        row = result.one_or_none()
        if row is None:
            return None
        return TutorSessionRecord(session=row[0], child=row[1])

    async def page_revision(
        self, book_id: UUID, page_id: UUID, revision_id: UUID
    ) -> TutorPageRecord | None:
        result = await self.db.execute(
            select(Book, BookPage, PageRevision)
            .join(BookPage, BookPage.BookId == Book.Id)
            .join(PageRevision, PageRevision.PageId == BookPage.Id)
            .where(
                Book.Id == book_id,
                BookPage.Id == page_id,
                PageRevision.Id == revision_id,
            )
        )
        row = result.one_or_none()
        if row is None:
            return None
        return TutorPageRecord(book=row[0], page=row[1], revision=row[2])

    async def revision_words(self, revision_id: UUID) -> list[PageRevisionWord]:
        result = await self.db.execute(
            select(PageRevisionWord)
            .where(PageRevisionWord.PageRevisionId == revision_id)
            .order_by(PageRevisionWord.WordIndex, PageRevisionWord.Id)
        )
        return list(result.scalars().all())
