from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import and_, case, exists, literal, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.role_cache import get_cached_profile_role
from app.models import (
    Book, BookPage, ChildProfile, FluencyAssessment, PageRevision,
    PageRevisionWord, ReadingEvent, ReadingSession, ReadingSessionPage,
)
from app.repositories.book_repository import CatalogRepository
from app.models.reading_comparison_report import ReadingComparisonReport
from app.policies.book_access import (
    _private_page_has_incomplete_multipage_batch,
    is_private_book,
    is_private_page_readable,
)


class ReadingContentRepository:
    """Persistence-only access for reading sessions and verified catalog content."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def comparison_reports(self, session_id: UUID) -> list[ReadingComparisonReport]:
        result = await self.db.execute(
            select(ReadingComparisonReport)
            .where(ReadingComparisonReport.SessionId == session_id)
            .order_by(ReadingComparisonReport.CreatedAt.desc(), ReadingComparisonReport.Id.desc())
        )
        return list(result.scalars().all())

    async def initial_word_status(self, session_id: UUID, page_id: UUID,
                                  revision_id: UUID, word_id: UUID) -> str | None:
        for report in reversed(await self.comparison_reports(session_id)):
            if (report.PageId != page_id or report.PageRevisionId != revision_id
                    or not isinstance(report.Summary, dict)
                    or report.Summary.get("assessment_version") != 1):
                continue
            for word in report.Summary.get("initial_assessment", []):
                if isinstance(word, dict) and word.get("word_id") == str(word_id):
                    return word.get("status")
            return None
        return None

    async def profile_role(self, profile_id: UUID) -> str | None:
        return await get_cached_profile_role(self.db, profile_id)

    async def child_belongs_to_parent(self, child_id: UUID, parent_id: UUID) -> bool:
        found = await self.db.scalar(
            select(ChildProfile.Id).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
            )
        )
        return found is not None

    async def book_by_id(self, book_id: UUID) -> Book | None:
        return await self.db.scalar(select(Book).where(Book.Id == book_id))

    async def session_start_context(
        self, child_id: UUID, book_id: UUID, actor_id: UUID
    ) -> tuple[bool, Book | None, bool]:
        """Fetch child ownership, book metadata, and readability in one round-trip."""
        probe = select(literal(1).label("probe")).subquery()
        child_owned_expr = exists(
            select(ChildProfile.Id).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == actor_id,
            )
        )
        is_readable_expr = case(
            (
                and_(
                    Book.Id.is_not(None),
                    CatalogRepository.readable_book(actor_id),
                ),
                True,
            ),
            else_=False,
        )
        row = (
            await self.db.execute(
                select(
                    child_owned_expr.label("child_owned"),
                    Book,
                    is_readable_expr.label("is_readable"),
                )
                .select_from(probe)
                .outerjoin(Book, Book.Id == book_id)
            )
        ).first()
        if row is None:
            return False, None, False
        return bool(row[0]), row[1], bool(row[2])

    async def active_book_pages_with_revisions(
        self,
        book_id: UUID,
        *,
        include_private_batch_check: bool = False,
    ) -> list[tuple[BookPage, PageRevision | None, bool]]:
        """Fetch all ACTIVE pages for a book with their current verified revision in one query."""
        eligible_expr = and_(
            PageRevision.Id.is_not(None),
            PageRevision.VerificationStatus == "VERIFIED",
        )
        if include_private_batch_check:
            eligible_expr = and_(
                eligible_expr,
                not_(_private_page_has_incomplete_multipage_batch()),
            )
        result = await self.db.execute(
            select(
                BookPage,
                PageRevision,
                case((eligible_expr, True), else_=False).label("is_eligible"),
            )
            .outerjoin(
                PageRevision,
                and_(
                    PageRevision.Id == BookPage.CurrentVerifiedRevisionId,
                    PageRevision.PageId == BookPage.Id,
                ),
            )
            .where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
            )
            .order_by(BookPage.PageNumber, BookPage.Id)
        )
        return [(row[0], row[1], bool(row[2])) for row in result.all()]

    async def revision_word_validation_rows(
        self, revision_ids: list[UUID]
    ) -> list[tuple[UUID, str, object]]:
        """Batch-fetch `(PageRevisionId, Text, BoundingBox)` for range validation."""
        if not revision_ids:
            return []
        result = await self.db.execute(
            select(
                PageRevisionWord.PageRevisionId,
                PageRevisionWord.Text,
                PageRevisionWord.BoundingBox,
            ).where(PageRevisionWord.PageRevisionId.in_(revision_ids))
        )
        return [(row[0], row[1], row[2]) for row in result.all()]

    async def verified_page(
        self,
        page_id: UUID,
        book_id: UUID | None = None,
        *,
        actor_id: UUID | None = None,
    ) -> BookPage | None:
        query = (
            select(BookPage)
            .join(Book, Book.Id == BookPage.BookId)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                BookPage.Id == page_id,
                BookPage.LifecycleStatus == "ACTIVE",
                Book.LifecycleStatus == "ACTIVE",
                CatalogRepository.readable_book(actor_id),
                or_(
                    ~is_private_book(),
                    is_private_page_readable(),
                ),
                PageRevision.PageId == BookPage.Id,
                PageRevision.VerificationStatus == "VERIFIED",
            )
        )
        if book_id is not None:
            query = query.where(BookPage.BookId == book_id)
        return await self.db.scalar(query)

    async def book_is_eligible(
        self, book_id: UUID, *, actor_id: UUID | None = None
    ) -> bool:
        return (
            await self.db.scalar(
                select(Book.Id).where(
                    Book.Id == book_id,
                    CatalogRepository.readable_book(actor_id),
                )
            )
        ) is not None

    async def first_verified_page(
        self, book_id: UUID, *, actor_id: UUID | None = None
    ) -> BookPage | None:
        return await self.db.scalar(
            select(BookPage)
            .join(Book, Book.Id == BookPage.BookId)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
                Book.LifecycleStatus == "ACTIVE",
                CatalogRepository.readable_book(actor_id),
                or_(
                    ~is_private_book(),
                    is_private_page_readable(),
                ),
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
            .order_by(PageRevisionWord.WordIndex, PageRevisionWord.Id)
        )
        return list(result.scalars().all())

    async def all_pages_between_numbers(
        self, book_id: UUID, start_page_number: int, end_page_number: int
    ) -> list[BookPage]:
        result = await self.db.execute(
            select(BookPage)
            .where(
                BookPage.BookId == book_id,
                BookPage.LifecycleStatus == "ACTIVE",
                BookPage.PageNumber >= start_page_number,
                BookPage.PageNumber <= end_page_number,
            )
            .order_by(BookPage.PageNumber, BookPage.Id)
        )
        return list(result.scalars().all())

    async def verified_pages_between_numbers(
        self,
        book_id: UUID,
        start_page_number: int,
        end_page_number: int,
        *,
        actor_id: UUID | None = None,
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
                CatalogRepository.readable_book(actor_id),
                or_(
                    ~is_private_book(),
                    is_private_page_readable(),
                ),
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

    async def session_for_update(
        self, session_id: UUID, *, actor_id: UUID | None = None
    ) -> ReadingSession | None:
        return await self.db.scalar(
            select(ReadingSession)
            .join(Book, Book.Id == ReadingSession.BookId)
            .where(ReadingSession.Id == session_id)
            .where(CatalogRepository.readable_book(actor_id))
            .with_for_update(of=ReadingSession)
            .execution_options(populate_existing=True)
        )

    async def session(
        self, session_id: UUID, *, actor_id: UUID | None = None
    ) -> ReadingSession | None:
        return await self.db.scalar(
            select(ReadingSession)
            .join(Book, Book.Id == ReadingSession.BookId)
            .where(
                ReadingSession.Id == session_id,
                CatalogRepository.readable_book(actor_id),
            )
        )

    async def session_with_ownership_and_book(
        self, session_id: UUID, actor_id: UUID
    ) -> tuple[ReadingSession, Book, bool] | None:
        """Fetch session, its book, and child ownership in one round-trip."""
        child_owned_expr = exists(
            select(ChildProfile.Id).where(
                ChildProfile.Id == ReadingSession.ChildId,
                ChildProfile.ParentId == actor_id,
            )
        )
        row = (
            await self.db.execute(
                select(
                    ReadingSession,
                    Book,
                    child_owned_expr.label("child_owned"),
                )
                .join(Book, Book.Id == ReadingSession.BookId)
                .where(
                    ReadingSession.Id == session_id,
                    CatalogRepository.readable_book(actor_id),
                )
            )
        ).first()
        if row is None:
            return None
        return row[0], row[1], bool(row[2])

    async def session_pages_with_content(
        self, session_id: UUID
    ) -> list[tuple[ReadingSessionPage, BookPage | None, PageRevision | None]]:
        """Fetch session page snapshots together with their BookPage and PageRevision."""
        result = await self.db.execute(
            select(ReadingSessionPage, BookPage, PageRevision)
            .outerjoin(BookPage, BookPage.Id == ReadingSessionPage.PageId)
            .outerjoin(
                PageRevision,
                and_(
                    PageRevision.Id == ReadingSessionPage.PageRevisionId,
                    PageRevision.PageId == ReadingSessionPage.PageId,
                ),
            )
            .where(ReadingSessionPage.SessionId == session_id)
            .order_by(ReadingSessionPage.PageOrder, ReadingSessionPage.Id)
        )
        return [(row[0], row[1], row[2]) for row in result.all()]

    async def sessions_for_parent(self, parent_id: UUID) -> list[ReadingSession]:
        result = await self.db.execute(
            select(ReadingSession)
            .join(Book, Book.Id == ReadingSession.BookId)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(
                ChildProfile.ParentId == parent_id,
                CatalogRepository.readable_book(parent_id),
            )
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

    async def retry_event_for_attempt(
        self, session_id: UUID, page_id: UUID, revision_id: UUID,
        word_id: UUID, event_type: str, attempt: int,
    ) -> ReadingEvent | None:
        return await self.db.scalar(
            select(ReadingEvent).where(
                ReadingEvent.SessionId == session_id,
                ReadingEvent.PageId == page_id,
                ReadingEvent.PageRevisionId == revision_id,
                ReadingEvent.WordId == word_id,
                ReadingEvent.Type == event_type,
                or_(
                    ReadingEvent.Metadata.contains({"retry_attempt": attempt}),
                    and_(
                        ~ReadingEvent.Metadata.has_key("retry_attempt"),
                        ReadingEvent.Metadata.contains({"attempt": attempt}),
                    ),
                ),
            ).order_by(ReadingEvent.CreatedAt, ReadingEvent.Id).limit(1)
        )

    async def retry_events_for_word(
        self, session_id: UUID, page_id: UUID, revision_id: UUID, word_id: UUID,
    ) -> list[ReadingEvent]:
        result = await self.db.execute(
            select(ReadingEvent).where(
                ReadingEvent.SessionId == session_id,
                ReadingEvent.PageId == page_id,
                ReadingEvent.PageRevisionId == revision_id,
                ReadingEvent.WordId == word_id,
                ReadingEvent.Type == "WORD_RETRY",
            )
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
        if session.Id is None:
            session.Id = uuid4()
        if session.StartedAt is None:
            session.StartedAt = datetime.now(timezone.utc)
        self.db.add(session)
        try:
            if page_rows:
                for row in page_rows:
                    if row.Id is None:
                        row.Id = uuid4()
                    row.SessionId = session.Id
                self.db.add_all(page_rows)
            await self.db.commit()
            sync_session = getattr(self.db, "sync_session", None)
            if getattr(sync_session, "expire_on_commit", True):
                await self.db.refresh(session)
        except Exception:
            await self.db.rollback()
            raise
        return session
