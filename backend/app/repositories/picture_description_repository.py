from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import desc, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    ChildProfile,
    PageRevision,
    PictureDescriptionAttempt,
    PictureDescriptionSession,
    Profile,
)
from app.repositories.book_repository import CatalogRepository
from app.services.child_difficult_word_feed import (
    ChildDifficultWordFeed,
    DifficultWordTarget,
)


@dataclass(frozen=True, slots=True)
class ChildProjection:
    Id: UUID
    ParentId: UUID
    Grade: int


@dataclass(frozen=True, slots=True)
class BookPageCandidateProjection:
    BookId: UUID
    BookTitle: str
    PageId: UUID
    PageNumber: int
    ImagePath: str
    VerifiedText: str | None = None


@dataclass(frozen=True, slots=True)
class SessionProjection:
    Id: UUID
    ChildProfileId: UUID
    ParentId: UUID
    BookId: UUID | None
    BookPageId: UUID | None
    SourceType: str
    SampleKey: str | None
    ImagePath: str
    ImageMimeType: str
    ChildGrade: int
    SceneTitle: str
    PromptPayload: dict[str, Any]
    Status: str
    BestStars: int
    BestScore: int
    AttemptsCount: int
    AiModelUsed: str | None
    CreatedAt: datetime
    UpdatedAt: datetime


@dataclass(frozen=True, slots=True)
class AttemptProjection:
    Id: UUID
    SessionId: UUID
    AttemptNumber: int
    InputMode: str
    TranscriptText: str
    ScoreOutOf10: int
    Stars: int
    FeedbackPayload: dict[str, Any]
    AiModelUsed: str | None
    CreatedAt: datetime


class PictureDescriptionRepository:
    """Database access for picture description sessions, attempts, and candidate book pages."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def profile_role(self, profile_id: UUID) -> str | None:
        from app.database.role_cache import get_cached_profile_role
        return await get_cached_profile_role(self.db, profile_id)

    async def child_owned_by(
        self,
        child_id: UUID,
        parent_id: UUID,
    ) -> ChildProjection | None:
        result = await self.db.execute(
            select(ChildProfile.Id, ChildProfile.ParentId, ChildProfile.Grade).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
            )
        )
        row = result.one_or_none()
        if row is None:
            return None
        return ChildProjection(Id=row.Id, ParentId=row.ParentId, Grade=row.Grade)

    async def list_difficult_word_targets(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        limit: int = 8,
    ) -> list[DifficultWordTarget]:
        return await ChildDifficultWordFeed(self.db).list_targets(
            child_id,
            parent_id,
            limit=limit,
        )

    async def list_book_pages_for_grade(
        self,
        grade: int,
        *,
        limit: int = 12,
    ) -> list[BookPageCandidateProjection]:
        # Fetch a wider pool and interleave round-robin across books so a single
        # 20-page book never crowds out all other books for the child's grade.
        pool_limit = max(limit * 4, 48)
        query = (
            select(
                Book.Id,
                Book.Title,
                BookPage.Id,
                BookPage.PageNumber,
                BookPage.ImagePath,
                PageRevision.VerifiedText,
            )
            .join(BookPage, BookPage.BookId == Book.Id)
            .outerjoin(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                Book.LifecycleStatus == "ACTIVE",
                Book.MinGrade <= grade,
                Book.MaxGrade >= grade,
                BookPage.LifecycleStatus == "ACTIVE",
                BookPage.ImagePath.is_not(None),
                BookPage.ImagePath != "",
                CatalogRepository.eligible_book(),
            )
            .order_by(Book.Title.asc(), BookPage.PageNumber.asc(), BookPage.Id.asc())
            .limit(pool_limit)
        )
        result = await self.db.execute(query)
        rows = result.all()
        await self.db.rollback()

        by_book: dict[UUID, list[BookPageCandidateProjection]] = {}
        book_order: list[UUID] = []
        for row in rows:
            candidate = BookPageCandidateProjection(
                BookId=row[0],
                BookTitle=row[1],
                PageId=row[2],
                PageNumber=row[3],
                ImagePath=row[4],
                VerifiedText=row[5] if len(row) > 5 else None,
            )
            if candidate.BookId not in by_book:
                by_book[candidate.BookId] = []
                book_order.append(candidate.BookId)
            by_book[candidate.BookId].append(candidate)

        diversified: list[BookPageCandidateProjection] = []
        round_idx = 0
        while len(diversified) < limit and book_order:
            progressed = False
            for book_id in book_order:
                bucket = by_book[book_id]
                if round_idx < len(bucket):
                    diversified.append(bucket[round_idx])
                    progressed = True
                    if len(diversified) >= limit:
                        break
            if not progressed:
                break
            round_idx += 1
        return diversified

    async def get_book_page_for_grade(
        self,
        page_id: UUID,
        grade: int,
    ) -> BookPageCandidateProjection | None:
        query = (
            select(
                Book.Id,
                Book.Title,
                BookPage.Id,
                BookPage.PageNumber,
                BookPage.ImagePath,
                PageRevision.VerifiedText,
            )
            .join(BookPage, BookPage.BookId == Book.Id)
            .outerjoin(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                BookPage.Id == page_id,
                Book.LifecycleStatus == "ACTIVE",
                Book.MinGrade <= grade,
                Book.MaxGrade >= grade,
                BookPage.LifecycleStatus == "ACTIVE",
                BookPage.ImagePath.is_not(None),
                BookPage.ImagePath != "",
                CatalogRepository.eligible_book(),
            )
        )
        result = await self.db.execute(query)
        row = result.one_or_none()
        if row is None:
            return None
        return BookPageCandidateProjection(
            BookId=row[0],
            BookTitle=row[1],
            PageId=row[2],
            PageNumber=row[3],
            ImagePath=row[4],
            VerifiedText=row[5] if len(row) > 5 else None,
        )

    @staticmethod
    def _to_session_projection(row: Any) -> SessionProjection:
        return SessionProjection(
            Id=row.Id,
            ChildProfileId=row.ChildProfileId,
            ParentId=row.ParentId,
            BookId=row.BookId,
            BookPageId=row.BookPageId,
            SourceType=row.SourceType,
            SampleKey=row.SampleKey,
            ImagePath=row.ImagePath,
            ImageMimeType=row.ImageMimeType,
            ChildGrade=row.ChildGrade,
            SceneTitle=row.SceneTitle,
            PromptPayload=dict(row.PromptPayload or {}),
            Status=row.Status,
            BestStars=row.BestStars,
            BestScore=row.BestScore,
            AttemptsCount=row.AttemptsCount,
            AiModelUsed=row.AiModelUsed,
            CreatedAt=row.CreatedAt,
            UpdatedAt=row.UpdatedAt,
        )

    @staticmethod
    def _to_attempt_projection(row: Any) -> AttemptProjection:
        return AttemptProjection(
            Id=row.Id,
            SessionId=row.SessionId,
            AttemptNumber=row.AttemptNumber,
            InputMode=row.InputMode,
            TranscriptText=row.TranscriptText,
            ScoreOutOf10=row.ScoreOutOf10,
            Stars=row.Stars,
            FeedbackPayload=dict(row.FeedbackPayload or {}),
            AiModelUsed=row.AiModelUsed,
            CreatedAt=row.CreatedAt,
        )

    async def get_owned_session_projection(
        self,
        session_id: UUID,
        parent_id: UUID,
    ) -> SessionProjection | None:
        query = (
            select(PictureDescriptionSession)
            .join(
                ChildProfile,
                ChildProfile.Id == PictureDescriptionSession.ChildProfileId,
            )
            .where(
                PictureDescriptionSession.Id == session_id,
                PictureDescriptionSession.ParentId == parent_id,
                ChildProfile.ParentId == parent_id,
                or_(
                    PictureDescriptionSession.BookId.is_(None),
                    exists(
                        select(Book.Id).where(
                            Book.Id == PictureDescriptionSession.BookId,
                            CatalogRepository.eligible_book(),
                        )
                    ),
                ),
            )
        )
        session = await self.db.scalar(query)
        if session is None:
            return None
        return self._to_session_projection(session)

    async def list_attempts(self, session_id: UUID) -> list[AttemptProjection]:
        query = (
            select(PictureDescriptionAttempt)
            .where(PictureDescriptionAttempt.SessionId == session_id)
            .order_by(desc(PictureDescriptionAttempt.AttemptNumber))
        )
        result = await self.db.scalars(query)
        return [self._to_attempt_projection(row) for row in result.all()]

    async def list_child_sessions(
        self,
        *,
        child_id: UUID,
        parent_id: UUID,
        limit: int = 12,
    ) -> list[SessionProjection]:
        query = (
            select(PictureDescriptionSession)
            .join(
                ChildProfile,
                ChildProfile.Id == PictureDescriptionSession.ChildProfileId,
            )
            .where(
                PictureDescriptionSession.ChildProfileId == child_id,
                PictureDescriptionSession.ParentId == parent_id,
                ChildProfile.ParentId == parent_id,
                or_(
                    PictureDescriptionSession.BookId.is_(None),
                    exists(
                        select(Book.Id).where(
                            Book.Id == PictureDescriptionSession.BookId,
                            CatalogRepository.eligible_book(),
                        )
                    ),
                ),
            )
            .order_by(desc(PictureDescriptionSession.UpdatedAt))
            .limit(limit)
        )
        result = await self.db.scalars(query)
        rows = [self._to_session_projection(row) for row in result.all()]
        await self.db.rollback()
        return rows

    async def create_session(
        self,
        session: PictureDescriptionSession,
    ) -> SessionProjection:
        self.db.add(session)
        await self.db.flush()
        await self.db.refresh(session)
        projection = self._to_session_projection(session)
        await self.db.commit()
        return projection

    async def save_attempt_and_update_session(
        self,
        *,
        session_id: UUID,
        parent_id: UUID,
        attempt: PictureDescriptionAttempt,
        new_best_stars: int,
        new_best_score: int,
        new_attempts_count: int,
        new_status: str,
        updated_at: datetime,
    ) -> tuple[SessionProjection, AttemptProjection]:
        session_obj = await self.db.scalar(
            select(PictureDescriptionSession)
            .join(
                ChildProfile,
                ChildProfile.Id == PictureDescriptionSession.ChildProfileId,
            )
            .where(
                PictureDescriptionSession.Id == session_id,
                PictureDescriptionSession.ParentId == parent_id,
                ChildProfile.ParentId == parent_id,
                or_(
                    PictureDescriptionSession.BookId.is_(None),
                    exists(
                        select(Book.Id).where(
                            Book.Id == PictureDescriptionSession.BookId,
                            CatalogRepository.eligible_book(),
                        )
                    ),
                ),
            )
            .with_for_update(of=PictureDescriptionSession)
        )
        if session_obj is None:
            raise LookupError("Session not found")

        attempt.AttemptNumber = int(session_obj.AttemptsCount) + 1
        session_obj.AttemptsCount = attempt.AttemptNumber
        session_obj.BestStars = max(int(session_obj.BestStars), new_best_stars)
        session_obj.BestScore = max(int(session_obj.BestScore), new_best_score)
        if session_obj.Status == "COMPLETED" or new_status == "COMPLETED":
            session_obj.Status = "COMPLETED"
        else:
            session_obj.Status = new_status
        session_obj.UpdatedAt = updated_at

        self.db.add(attempt)
        await self.db.flush()
        await self.db.refresh(session_obj)
        await self.db.refresh(attempt)
        session_projection = self._to_session_projection(session_obj)
        attempt_projection = self._to_attempt_projection(attempt)
        await self.db.commit()
        return session_projection, attempt_projection
