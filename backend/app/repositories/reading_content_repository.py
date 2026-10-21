from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book, BookPage, ChildProfile, FluencyAssessment, PageRevision,
    PageRevisionWord, Profile, ReadingEvent, ReadingSession, ReadingSessionPage,
)


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

    async def all_pages_between_numbers(
        self, book_id: UUID, start_page_number: int, end_page_number: int
    ) -> list[BookPage]:
        result = await self.db.execute(
            select(BookPage)
            .where(
                BookPage.BookId == book_id,
                BookPage.PageNumber >= start_page_number,
                BookPage.PageNumber <= end_page_number,
            )
            .order_by(BookPage.PageNumber, BookPage.Id)
        )
        return list(result.scalars().all())

    async def verified_pages_between_numbers(
        self, book_id: UUID, start_page_number: int, end_page_number: int
    ) -> list[BookPage]:
        result = await self.db.execute(
            select(BookPage)
            .join(Book, Book.Id == BookPage.BookId)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                BookPage.BookId == book_id,
                BookPage.PageNumber >= start_page_number,
                BookPage.PageNumber <= end_page_number,
                BookPage.LifecycleStatus == "ACTIVE",
                Book.LifecycleStatus == "ACTIVE",
                PageRevision.PageId == BookPage.Id,
                PageRevision.VerificationStatus == "VERIFIED",
            )
            .order_by(BookPage.PageNumber, BookPage.Id)
        )
        return list(result.scalars().all())

    async def session_page_rows(self, session_id: UUID) -> list[ReadingSessionPage]:
        result = await self.db.execute(
            select(ReadingSessionPage)
            .where(ReadingSessionPage.SessionId == session_id)
            .order_by(ReadingSessionPage.PageOrder, ReadingSessionPage.Id)
        )
        return list(result.scalars().all())

    async def session_page(
        self, session_id: UUID, page_id: UUID
    ) -> ReadingSessionPage | None:
        return await self.db.scalar(
            select(ReadingSessionPage).where(
                ReadingSessionPage.SessionId == session_id,
                ReadingSessionPage.PageId == page_id,
            )
        )

    async def page_by_id(self, page_id: UUID) -> BookPage | None:
        return await self.db.scalar(select(BookPage).where(BookPage.Id == page_id))

    async def revision_snapshot(self, page_id: UUID, revision_id: UUID) -> PageRevision | None:
        return await self.db.scalar(
            select(PageRevision).where(
                PageRevision.Id == revision_id,
                PageRevision.PageId == page_id,
            )
        )

    async def save_session_progress(
        self, session: ReadingSession, page_rows: list[ReadingSessionPage]
    ) -> ReadingSession:
        self.db.add(session)
        self.db.add_all(page_rows)
        try:
            await self.db.commit()
            await self.db.refresh(session)
        except Exception:
            await self.db.rollback()
            raise
        return session

    async def session(self, session_id: UUID) -> ReadingSession | None:
        return await self.db.scalar(
            select(ReadingSession).where(ReadingSession.Id == session_id)
        )

    async def sessions_for_parent(self, parent_id: UUID) -> list[ReadingSession]:
        result = await self.db.execute(
            select(ReadingSession)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(ChildProfile.ParentId == parent_id)
            .order_by(ReadingSession.StartedAt.desc(), ReadingSession.Id.desc())
        )
        return list(result.scalars().all())

    async def revision_word_exists(self, revision_id: UUID, word_id: UUID) -> bool:
        found = await self.db.scalar(
            select(PageRevisionWord.Id).where(
                PageRevisionWord.Id == word_id,
                PageRevisionWord.PageRevisionId == revision_id,
            )
        )
        return found is not None

    async def events_for_session(self, session_id: UUID) -> list[ReadingEvent]:
        result = await self.db.execute(
            select(ReadingEvent)
            .where(ReadingEvent.SessionId == session_id)
            .order_by(ReadingEvent.StartMs, ReadingEvent.Id)
        )
        return list(result.scalars().all())

    async def create_reading_event(self, event: ReadingEvent) -> ReadingEvent:
        self.db.add(event)
        try:
            await self.db.commit()
            await self.db.refresh(event)
        except Exception:
            await self.db.rollback()
            raise
        return event

    async def create_fluency_assessment(
        self,
        assessment: FluencyAssessment,
    ) -> FluencyAssessment:
        self.db.add(assessment)
        try:
            await self.db.commit()
            await self.db.refresh(assessment)
        except Exception:
            await self.db.rollback()
            raise
        return assessment

    def update_session_state(
        self,
        session: ReadingSession,
        *,
        state: str,
        ended_at,
    ) -> ReadingSession:
        """Stage a session-state change chosen by the Service."""
        session.State = state
        session.EndedAt = ended_at
        return session

    async def save_session(self, session: ReadingSession) -> ReadingSession:
        """Persist a session insert/update and keep the session transaction atomic."""
        self.db.add(session)
        try:
            await self.db.commit()
            await self.db.refresh(session)
        except Exception:
            await self.db.rollback()
            raise
        return session

    async def create_session(
        self,
        session: ReadingSession,
        page_rows: list[ReadingSessionPage] | None = None,
    ) -> ReadingSession:
        self.db.add(session)
        try:
            await self.db.flush()
            if page_rows:
                for row in page_rows:
                    row.SessionId = session.Id
                self.db.add_all(page_rows)
            await self.db.commit()
            await self.db.refresh(session)
        except Exception:
            await self.db.rollback()
            raise
        return session
