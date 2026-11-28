from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ChildProfile,
    ComprehensionAnswer,
    ComprehensionQuestion,
    DifficultWordPracticeAttempt,
    Profile,
    ReadingEvent,
    ReadingSession,
)
from app.models.reading_comparison_report import ReadingComparisonReport
from app.services.child_progress.metrics import (
    AnswerRow,
    PracticeAttemptEvidenceRow,
    ReportRow,
    RetryEventRow,
    SessionRow,
)

MAX_SESSIONS = 2_000
MAX_REPORTS = 1_500
MAX_EVENTS = 5_000
MAX_ANSWERS = 5_000
MAX_PRACTICE_ATTEMPTS = 2_000


class ChildProgressRepository:
    """Read-only queries for one child's reading history."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def owned_child(self, child_id: UUID, parent_id: UUID) -> ChildProfile | None:
        return await self.db.scalar(
            select(ChildProfile)
            .join(Profile, Profile.Id == ChildProfile.ParentId)
            .where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
                Profile.Active == 1,
                Profile.Role == "parent",
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
                ReadingComparisonReport.PageId,
                ReadingComparisonReport.PageRevisionId,
                ReadingComparisonReport.Transcript,
            )
            .join(ReadingSession, ReadingSession.Id == ReadingComparisonReport.SessionId)
            .where(ReadingSession.ChildId == child_id, ReadingSession.StartedAt >= since)
            .order_by(ReadingComparisonReport.CreatedAt.desc())
            .limit(MAX_REPORTS)
        )
        return [ReportRow(*row) for row in result.all()]

    async def word_retries(self, child_id: UUID, since: datetime) -> list[RetryEventRow]:
        result = await self.db.execute(
            select(
                ReadingEvent.SessionId,
                ReadingEvent.Status,
                ReadingEvent.CreatedAt,
                ReadingEvent.PageId,
                ReadingEvent.PageRevisionId,
                ReadingEvent.WordId,
                ReadingEvent.Metadata,
                ReadingEvent.Type,
            )
            .join(ReadingSession, ReadingSession.Id == ReadingEvent.SessionId)
            .where(
                ReadingSession.ChildId == child_id,
                ReadingSession.StartedAt >= since,
                ReadingEvent.Type.in_(("WORD_RETRY", "READ_EXAMPLE")),
            )
            .order_by(ReadingEvent.CreatedAt.desc(), ReadingEvent.Id.desc())
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

    async def practice_attempts(
        self, child_id: UUID, since: datetime
    ) -> list[PracticeAttemptEvidenceRow]:
        try:
            ready = await self.db.scalar(
                select(text("to_regclass('public.difficult_word_practice_attempts')"))
            )
            if ready is None:
                return []
            async with self.db.begin_nested():
                result = await self.db.execute(
                    select(
                        DifficultWordPracticeAttempt.Id,
                        DifficultWordPracticeAttempt.SessionId,
                        DifficultWordPracticeAttempt.NormalizedWord,
                        DifficultWordPracticeAttempt.DisplayText,
                        DifficultWordPracticeAttempt.AssessmentStatus,
                        DifficultWordPracticeAttempt.SpokenTranscript,
                        DifficultWordPracticeAttempt.CreatedAt,
                    )
                    .where(
                        DifficultWordPracticeAttempt.ChildId == child_id,
                        DifficultWordPracticeAttempt.CreatedAt >= since,
                        DifficultWordPracticeAttempt.State == "COMPLETED",
                    )
                    .order_by(DifficultWordPracticeAttempt.CreatedAt.desc())
                    .limit(MAX_PRACTICE_ATTEMPTS)
                )
                return [
                    PracticeAttemptEvidenceRow(
                        attempt_id=row[0],
                        session_id=row[1],
                        normalized_word=row[2] or "",
                        display_text=row[3] or row[2] or "",
                        assessment_status=row[4] or "",
                        spoken_transcript=row[5],
                        created_at=row[6],
                    )
                    for row in result.all()
                ]
        except SQLAlchemyError:
            return []

    async def release(self) -> None:
        """End the read transaction so no DB slot is held during a slow AI call."""
        await self.db.rollback()
