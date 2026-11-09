from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ChildProfile,
    ComprehensionAnswer,
    ComprehensionQuestion,
    ReadingEvent,
    ReadingSession,
)
from app.models.reading_comparison_report import ReadingComparisonReport
from app.services.child_progress.metrics import (
    AnswerRow,
    ReportRow,
    RetryEventRow,
    SessionRow,
)

MAX_SESSIONS = 2_000
MAX_REPORTS = 1_500
MAX_EVENTS = 5_000
MAX_ANSWERS = 5_000


class ChildProgressRepository:
    """Read-only queries for one child's reading history."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def owned_child(self, child_id: UUID, parent_id: UUID) -> ChildProfile | None:
        return await self.db.scalar(
            select(ChildProfile).where(
                ChildProfile.Id == child_id, ChildProfile.ParentId == parent_id
            )
        )

    async def sessions(self, child_id: UUID, since: datetime) -> list[SessionRow]:
        result = await self.db.execute(
            select(
                ReadingSession.Id,
                ReadingSession.BookId,
                ReadingSession.State,
                ReadingSession.StartedAt,
                ReadingSession.EndedAt,
            )
            .where(ReadingSession.ChildId == child_id, ReadingSession.StartedAt >= since)
            .order_by(ReadingSession.StartedAt.desc())
            .limit(MAX_SESSIONS)
        )
        return [SessionRow(*row) for row in result.all()]

    async def reports(self, child_id: UUID, since: datetime) -> list[ReportRow]:
        result = await self.db.execute(
            select(
                ReadingComparisonReport.SessionId,
                ReadingComparisonReport.CreatedAt,
                ReadingComparisonReport.Alignment,
                ReadingComparisonReport.Summary,
            )
            .join(ReadingSession, ReadingSession.Id == ReadingComparisonReport.SessionId)
            .where(ReadingSession.ChildId == child_id, ReadingSession.StartedAt >= since)
            .order_by(ReadingComparisonReport.CreatedAt.desc())
            .limit(MAX_REPORTS)
        )
        return [ReportRow(*row) for row in result.all()]

    async def word_retries(self, child_id: UUID, since: datetime) -> list[RetryEventRow]:
        result = await self.db.execute(
            select(ReadingEvent.SessionId, ReadingEvent.Status, ReadingEvent.CreatedAt)
            .join(ReadingSession, ReadingSession.Id == ReadingEvent.SessionId)
            .where(
                ReadingSession.ChildId == child_id,
                ReadingSession.StartedAt >= since,
                ReadingEvent.Type == "WORD_RETRY",
            )
            .limit(MAX_EVENTS)
        )
        return [RetryEventRow(*row) for row in result.all()]

    async def answers(self, child_id: UUID, since: datetime) -> list[AnswerRow]:
        result = await self.db.execute(
            select(
                ComprehensionAnswer.QuestionId,
                ComprehensionQuestion.Type,
                ComprehensionAnswer.IsCorrect,
                ComprehensionAnswer.CreatedAt,
            )
            .join(ComprehensionQuestion, ComprehensionQuestion.Id == ComprehensionAnswer.QuestionId)
            .join(ReadingSession, ReadingSession.Id == ComprehensionQuestion.SessionId)
            .where(ReadingSession.ChildId == child_id, ReadingSession.StartedAt >= since)
            .order_by(ComprehensionAnswer.CreatedAt)
            .limit(MAX_ANSWERS)
        )
        return [AnswerRow(*row) for row in result.all()]

    async def release(self) -> None:
        """End the read transaction so no DB slot is held during a slow AI call."""
        await self.db.rollback()
