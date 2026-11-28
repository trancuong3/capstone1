from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    ChildProfile,
    PageRevision,
    PageRevisionWord,
    ProgressReport,
    ReadingComparisonReport,
    ReadingEvent,
    ReadingSession,
)
from app.models.difficult_word_practice import DifficultWordPracticeAttempt

_STORAGE_READY_LOCK = threading.Lock()
_STORAGE_READY_CACHE: dict[int, bool] = {}


def _db_bind_cache_key(db: AsyncSession | None) -> int:
    if db is None:
        return 0
    bind = getattr(db, "bind", None)
    if bind is None:
        try:
            bind = db.get_bind()
        except Exception:
            bind = None
    return id(bind) if bind is not None else 0


def clear_practice_storage_ready_cache() -> None:
    """Clear the process-local difficult_word_practice_attempts readiness cache."""
    with _STORAGE_READY_LOCK:
        _STORAGE_READY_CACHE.clear()


def _should_refresh_after_commit(db: AsyncSession) -> bool:
    sync_session = getattr(db, "sync_session", None)
    return bool(getattr(sync_session, "expire_on_commit", True))


class DifficultWordsRepository:
    """Owner-scoped database access for difficult word evidence and practice attempts."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def lock_practice_request(self, child_id: UUID, request_id: UUID) -> None:
        # An HTTP retry may arrive while the first evaluation is still in flight.
        # The legacy readingevents store has no unique request-id column.
        await self.db.execute(
            select(func.pg_advisory_xact_lock(func.hashtextextended(
                f"word-practice:{child_id}:{request_id}", 0
            )))
        )

    async def is_practice_storage_ready(self) -> bool:
        """Safely probe table existence without aborting the current PostgreSQL transaction."""
        bind_key = _db_bind_cache_key(self.db)
        if bind_key:
            with _STORAGE_READY_LOCK:
                if _STORAGE_READY_CACHE.get(bind_key) is True:
                    return True
        table_name = await self.db.scalar(
            select(text("to_regclass('public.difficult_word_practice_attempts')"))
        )
        ready = table_name is not None
        if ready and bind_key:
            with _STORAGE_READY_LOCK:
                _STORAGE_READY_CACHE[bind_key] = True
        return ready

    async def saved_progress_report(
        self,
        child_id: UUID,
        period_start: Any,
        period_end: Any,
        actor_id: UUID,
    ) -> ProgressReport | None:
        return await self.db.scalar(
            select(ProgressReport)
            .join(ChildProfile, ProgressReport.ChildId == ChildProfile.Id)
            .where(
                ProgressReport.ChildId == child_id,
                ChildProfile.ParentId == actor_id,
                ProgressReport.PeriodStart == period_start,
                ProgressReport.PeriodEnd == period_end,
            )
            .order_by(ProgressReport.GeneratedAt.desc(), ProgressReport.Id.desc())
            .limit(1)
        )

    async def reading_sessions(
        self,
        child_id: UUID,
        actor_id: UUID,
        since: datetime,
        until_exclusive: datetime,
    ) -> list[ReadingSession]:
        result = await self.db.execute(
            select(ReadingSession)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(
                ReadingSession.ChildId == child_id,
                ChildProfile.ParentId == actor_id,
                ReadingSession.StartedAt >= since,
                ReadingSession.StartedAt < until_exclusive,
            )
            .order_by(ReadingSession.StartedAt.desc(), ReadingSession.Id.desc())
            .limit(2000)
        )
        return list(result.scalars().all())

    async def comparison_reports(
        self,
        child_id: UUID,
        actor_id: UUID,
        since: datetime,
        until_exclusive: datetime,
    ) -> list[ReadingComparisonReport]:
        result = await self.db.execute(
            select(ReadingComparisonReport)
            .join(ReadingSession, ReadingSession.Id == ReadingComparisonReport.SessionId)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(
                ReadingSession.ChildId == child_id,
                ChildProfile.ParentId == actor_id,
                ReadingSession.StartedAt >= since,
                ReadingSession.StartedAt < until_exclusive,
            )
            .order_by(
                ReadingComparisonReport.CreatedAt.desc(),
                ReadingComparisonReport.Id.desc(),
            )
            .limit(2000)
        )
        return list(result.scalars().all())

    async def reading_events_with_words(
        self,
        child_id: UUID,
        actor_id: UUID,
        since: datetime,
        until_exclusive: datetime,
    ) -> list[tuple[ReadingEvent, str | None]]:
        result = await self.db.execute(
            select(ReadingEvent, PageRevisionWord.Text)
            .join(ReadingSession, ReadingSession.Id == ReadingEvent.SessionId)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .outerjoin(PageRevisionWord, PageRevisionWord.Id == ReadingEvent.WordId)
            .where(
                ReadingSession.ChildId == child_id,
                ChildProfile.ParentId == actor_id,
                ReadingSession.StartedAt >= since,
                ReadingSession.StartedAt < until_exclusive,
                ReadingEvent.Type.in_(
                    (
                        "OMISSION",
                        "REPETITION",
                        "LONG_PAUSE",
                        "MISPRONUNCIATION",
                        "SUBSTITUTION",
                        "READ_EXAMPLE",
                    )
                ),
            )
            .order_by(ReadingEvent.CreatedAt.desc(), ReadingEvent.Id.desc())
            .limit(5000)
        )
        return [(row[0], row[1]) for row in result.all()]

    async def list_practice_attempts(
        self,
        child_id: UUID,
        actor_id: UUID,
        *,
        normalized_word: str | None = None,
        limit: int = 1000,
    ) -> list[DifficultWordPracticeAttempt]:
        query = (
            select(DifficultWordPracticeAttempt)
            .join(ChildProfile, ChildProfile.Id == DifficultWordPracticeAttempt.ChildId)
            .where(
                DifficultWordPracticeAttempt.ChildId == child_id,
                ChildProfile.ParentId == actor_id,
            )
        )
        if normalized_word is not None:
            query = query.where(
                DifficultWordPracticeAttempt.NormalizedWord == normalized_word
            )
        result = await self.db.execute(
            query.order_by(
                DifficultWordPracticeAttempt.StartedAt.desc(),
                DifficultWordPracticeAttempt.AttemptNumber.desc(),
                DifficultWordPracticeAttempt.Id.desc(),
            ).limit(limit)
        )
        return list(result.scalars().all())

    async def find_practice_attempt_by_request(
        self,
        child_id: UUID,
        actor_id: UUID,
        normalized_word: str,
        request_id: UUID,
    ) -> DifficultWordPracticeAttempt | None:
        return await self.db.scalar(
            select(DifficultWordPracticeAttempt)
            .join(ChildProfile, ChildProfile.Id == DifficultWordPracticeAttempt.ChildId)
            .where(
                DifficultWordPracticeAttempt.ChildId == child_id,
                ChildProfile.ParentId == actor_id,
                DifficultWordPracticeAttempt.NormalizedWord == normalized_word,
                DifficultWordPracticeAttempt.RequestId == request_id,
            )
            .limit(1)
        )

    async def get_practice_attempt(
        self,
        child_id: UUID,
        attempt_id: UUID,
        actor_id: UUID,
    ) -> DifficultWordPracticeAttempt | None:
        return await self.db.scalar(
            select(DifficultWordPracticeAttempt)
            .join(ChildProfile, ChildProfile.Id == DifficultWordPracticeAttempt.ChildId)
            .where(
                DifficultWordPracticeAttempt.Id == attempt_id,
                DifficultWordPracticeAttempt.ChildId == child_id,
                ChildProfile.ParentId == actor_id,
            )
            .limit(1)
        )

    async def next_attempt_number(
        self,
        child_id: UUID,
        normalized_word: str,
    ) -> int:
        current_max = await self.db.scalar(
            select(func.coalesce(func.max(DifficultWordPracticeAttempt.AttemptNumber), 0))
            .where(
                DifficultWordPracticeAttempt.ChildId == child_id,
                DifficultWordPracticeAttempt.NormalizedWord == normalized_word,
            )
        )
        return int(current_max or 0) + 1

    async def create_practice_attempt(
        self,
        attempt: DifficultWordPracticeAttempt,
    ) -> DifficultWordPracticeAttempt:
        now = datetime.now(timezone.utc)
        if attempt.Id is None:
            attempt.Id = uuid4()
        if attempt.StartedAt is None:
            attempt.StartedAt = now
        if attempt.CreatedAt is None:
            attempt.CreatedAt = now
        if attempt.UpdatedAt is None:
            attempt.UpdatedAt = now
        self.db.add(attempt)
        try:
            await self.db.commit()
            if _should_refresh_after_commit(self.db):
                await self.db.refresh(attempt)
        except Exception:
            await self.db.rollback()
            raise
        return attempt

    async def save_practice_attempt(
        self,
        attempt: DifficultWordPracticeAttempt,
    ) -> DifficultWordPracticeAttempt:
        try:
            await self.db.commit()
            if _should_refresh_after_commit(self.db):
                await self.db.refresh(attempt)
        except Exception:
            await self.db.rollback()
            raise
        return attempt

    async def books_by_ids(self, book_ids: list[UUID]) -> dict[UUID, Book]:
        if not book_ids:
            return {}
        result = await self.db.execute(
            select(Book).where(Book.Id.in_(list(set(book_ids))))
        )
        return {book.Id: book for book in result.scalars().all()}

    async def pages_and_revision_words(
        self,
        page_ids: list[UUID],
        revision_ids: list[UUID],
    ) -> tuple[dict[UUID, BookPage], dict[UUID, list[PageRevisionWord]]]:
        pages_by_id: dict[UUID, BookPage] = {}
        if page_ids:
            page_result = await self.db.execute(
                select(BookPage).where(BookPage.Id.in_(list(set(page_ids))))
            )
            pages_by_id = {page.Id: page for page in page_result.scalars().all()}

        words_by_rev: dict[UUID, list[PageRevisionWord]] = {}
        if revision_ids:
            word_result = await self.db.execute(
                select(PageRevisionWord)
                .where(PageRevisionWord.PageRevisionId.in_(list(set(revision_ids))))
                .order_by(
                    PageRevisionWord.PageRevisionId.asc(),
                    PageRevisionWord.WordIndex.asc(),
                )
            )
            for row in word_result.scalars().all():
                words_by_rev.setdefault(row.PageRevisionId, []).append(row)
        return pages_by_id, words_by_rev

    async def list_retry_events_for_child(
        self,
        child_id: UUID,
        actor_id: UUID,
        *,
        normalized_word: str | None = None,
        limit: int = 2000,
    ) -> list[ReadingEvent]:
        query = (
            select(ReadingEvent)
            .join(ReadingSession, ReadingSession.Id == ReadingEvent.SessionId)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(
                ReadingSession.ChildId == child_id,
                ChildProfile.ParentId == actor_id,
                ReadingEvent.Type == "WORD_RETRY",
            )
        )
        if normalized_word is not None:
            query = query.where(
                or_(
                    ReadingEvent.Metadata["normalized_word"].as_string() == normalized_word,
                    func.lower(ReadingEvent.Metadata["target_word"].as_string()).contains(
                        normalized_word
                    ),
                )
            )
        result = await self.db.execute(
            query.order_by(ReadingEvent.CreatedAt.desc(), ReadingEvent.Id.desc())
            .limit(limit)
        )
        return list(result.scalars().all())

    async def find_retry_event_by_request(
        self,
        child_id: UUID,
        actor_id: UUID,
        normalized_word: str,
        completion_request_id: UUID,
    ) -> ReadingEvent | None:
        return await self.db.scalar(
            select(ReadingEvent)
            .join(ReadingSession, ReadingSession.Id == ReadingEvent.SessionId)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(
                ReadingSession.ChildId == child_id,
                ChildProfile.ParentId == actor_id,
                ReadingEvent.Type == "WORD_RETRY",
                ReadingEvent.Metadata["normalized_word"].as_string() == normalized_word,
                ReadingEvent.Metadata["completion_request_id"].as_string() == str(completion_request_id),
            )
            .limit(1)
        )

    async def resolve_retry_target(
        self,
        child_id: UUID,
        actor_id: UUID,
        *,
        session_id: UUID | None = None,
        page_id: UUID | None = None,
        page_revision_id: UUID | None = None,
        word_id: UUID | None = None,
        validated_session: ReadingSession | None = None,
        word_validated: bool = False,
    ) -> tuple[UUID, UUID, UUID, UUID | None] | None:
        session_row: ReadingSession | None = validated_session
        if session_row is None and session_id is not None:
            session_row = await self.db.scalar(
                select(ReadingSession)
                .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
                .where(
                    ReadingSession.Id == session_id,
                    ReadingSession.ChildId == child_id,
                    ChildProfile.ParentId == actor_id,
                )
                .limit(1)
            )
        if session_row is None:
            session_row = await self.db.scalar(
                select(ReadingSession)
                .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
                .where(
                    ReadingSession.ChildId == child_id,
                    ChildProfile.ParentId == actor_id,
                )
                .order_by(ReadingSession.StartedAt.desc(), ReadingSession.Id.desc())
                .limit(1)
            )
        if session_row is None:
            return None

        resolved_page_id: UUID | None = page_id
        resolved_rev_id: UUID | None = page_revision_id
        if resolved_page_id is None or resolved_rev_id is None:
            report_row = await self.db.scalar(
                select(ReadingComparisonReport)
                .where(ReadingComparisonReport.SessionId == session_row.Id)
                .order_by(ReadingComparisonReport.CreatedAt.desc(), ReadingComparisonReport.Id.desc())
                .limit(1)
            )
            if report_row is not None:
                resolved_page_id = resolved_page_id or report_row.PageId
                resolved_rev_id = resolved_rev_id or report_row.PageRevisionId

        if resolved_page_id is None:
            resolved_page_id = (
                session_row.SelectedPageId
                or session_row.CurrentPageId
                or session_row.StartPageId
            )

        if resolved_page_id is not None and resolved_rev_id is None:
            page_row = await self.db.scalar(
                select(BookPage).where(BookPage.Id == resolved_page_id).limit(1)
            )
            if page_row is not None:
                resolved_rev_id = (
                    page_row.CurrentVerifiedRevisionId
                    or session_row.SelectedPageRevisionId
                )
                if resolved_rev_id is None:
                    resolved_rev_id = await self.db.scalar(
                        select(PageRevision.Id)
                        .where(PageRevision.PageId == page_row.Id)
                        .order_by(PageRevision.CreatedAt.desc(), PageRevision.Id.desc())
                        .limit(1)
                    )

        if resolved_page_id is None or resolved_rev_id is None:
            fallback_page = await self.db.scalar(
                select(BookPage)
                .where(
                    BookPage.BookId == session_row.BookId,
                    BookPage.CurrentVerifiedRevisionId.is_not(None),
                )
                .order_by(BookPage.PageNumber.asc(), BookPage.Id.asc())
                .limit(1)
            )
            if fallback_page is not None and fallback_page.CurrentVerifiedRevisionId is not None:
                resolved_page_id = fallback_page.Id
                resolved_rev_id = fallback_page.CurrentVerifiedRevisionId

        if resolved_page_id is None or resolved_rev_id is None:
            return None

        resolved_word_id: UUID | None = None
        if word_id is not None:
            if word_validated and page_revision_id is not None and resolved_rev_id == page_revision_id:
                resolved_word_id = word_id
            else:
                found_word_id = await self.db.scalar(
                    select(PageRevisionWord.Id)
                    .where(
                        PageRevisionWord.Id == word_id,
                        PageRevisionWord.PageRevisionId == resolved_rev_id,
                    )
                    .limit(1)
                )
                resolved_word_id = found_word_id

        return (session_row.Id, resolved_page_id, resolved_rev_id, resolved_word_id)

    async def existing_word_retry_stats(
        self,
        session_id: UUID,
        page_id: UUID,
        page_revision_id: UUID,
        word_id: UUID | None,
    ) -> tuple[int, int]:
        query = select(ReadingEvent).where(
            ReadingEvent.SessionId == session_id,
            ReadingEvent.PageId == page_id,
            ReadingEvent.PageRevisionId == page_revision_id,
            ReadingEvent.Type == "WORD_RETRY",
        )
        if word_id is not None:
            query = query.where(ReadingEvent.WordId == word_id)
        result = await self.db.execute(query)
        events = list(result.scalars().all())
        max_attempt = 0
        incorrect_count = 0
        for ev in events:
            if ev.Status == "FAILED":
                incorrect_count += 1
            if isinstance(ev.Metadata, dict):
                att = ev.Metadata.get("retry_attempt")
                if type(att) is int and att > max_attempt:
                    max_attempt = att
        return max_attempt + 1, incorrect_count

    async def create_retry_event(self, event: ReadingEvent) -> ReadingEvent:
        if event.Id is None:
            event.Id = uuid4()
        if event.CreatedAt is None:
            event.CreatedAt = datetime.now(timezone.utc)
        self.db.add(event)
        try:
            await self.db.commit()
            if _should_refresh_after_commit(self.db):
                await self.db.refresh(event)
        except Exception:
            await self.db.rollback()
            raise
        return event

    async def save_practice_attempt_and_retry_event(
        self,
        attempt: DifficultWordPracticeAttempt | None,
        event: ReadingEvent | None,
    ) -> tuple[DifficultWordPracticeAttempt | None, ReadingEvent | None]:
        """Persist practice attempt + mirrored WORD_RETRY event in a single atomic commit."""
        now = datetime.now(timezone.utc)
        saved_attempt = attempt
        saved_event = event
        if attempt is not None:
            if attempt.Id is None:
                attempt.Id = uuid4()
            if attempt.StartedAt is None:
                attempt.StartedAt = now
            if attempt.CreatedAt is None:
                attempt.CreatedAt = now
            if attempt.UpdatedAt is None:
                attempt.UpdatedAt = now
        if event is not None:
            if event.Id is None:
                event.Id = uuid4()
            if event.CreatedAt is None:
                event.CreatedAt = now

        try:
            if saved_attempt is not None:
                self.db.add(saved_attempt)
            if saved_attempt is not None and saved_event is not None:
                begin_nested = getattr(self.db, "begin_nested", None)
                if callable(begin_nested):
                    flush_fn = getattr(self.db, "flush", None)
                    if callable(flush_fn):
                        await flush_fn()
                    try:
                        async with begin_nested():
                            self.db.add(saved_event)
                            if callable(flush_fn):
                                await flush_fn()
                    except Exception:
                        saved_event = None
                else:
                    self.db.add(saved_event)
            elif saved_event is not None:
                self.db.add(saved_event)

            await self.db.commit()
            if _should_refresh_after_commit(self.db):
                if saved_attempt is not None:
                    await self.db.refresh(saved_attempt)
                if saved_event is not None:
                    await self.db.refresh(saved_event)
        except Exception:
            await self.db.rollback()
            raise
        return saved_attempt, saved_event
