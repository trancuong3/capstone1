from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ChildProfile,
    ComprehensionAnswer,
    ComprehensionQuestion,
    PageRevision,
    PageRevisionWord,
    ReadingSession,
    ReadingSessionPage,
    BookPage,
)


class TutorQuestionRepository:
    """Persistence-only access for generated comprehension questions."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def owned_session(self, session_id: UUID, parent_id: UUID) -> ReadingSession | None:
        return await self.db.scalar(
            select(ReadingSession)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(ReadingSession.Id == session_id, ChildProfile.ParentId == parent_id)
        )

    async def owned_session_for_update(
        self, session_id: UUID, parent_id: UUID
    ) -> ReadingSession | None:
        return await self.db.scalar(
            select(ReadingSession)
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(ReadingSession.Id == session_id, ChildProfile.ParentId == parent_id)
            .with_for_update(of=ReadingSession)
        )

    async def session_page_rows(self, session_id: UUID) -> list[ReadingSessionPage]:
        result = await self.db.execute(
            select(ReadingSessionPage)
            .where(ReadingSessionPage.SessionId == session_id)
            .order_by(ReadingSessionPage.PageOrder, ReadingSessionPage.Id)
        )
        return list(result.scalars().all())

    async def revision(self, revision_id: UUID) -> PageRevision | None:
        return await self.db.scalar(
            select(PageRevision).where(PageRevision.Id == revision_id)
        )

    async def page_number(self, page_id: UUID) -> int | None:
        return await self.db.scalar(select(BookPage.PageNumber).where(BookPage.Id == page_id))

    async def revision_word_texts(self, revision_id: UUID) -> list[str]:
        result = await self.db.execute(
            select(PageRevisionWord.Text)
            .where(PageRevisionWord.PageRevisionId == revision_id)
            .order_by(PageRevisionWord.WordIndex, PageRevisionWord.Id)
        )
        return [text for (text,) in result.all()]

    async def questions(self, session_id: UUID) -> list[ComprehensionQuestion]:
        result = await self.db.execute(
            select(ComprehensionQuestion)
            .where(ComprehensionQuestion.SessionId == session_id)
            .order_by(ComprehensionQuestion.CreatedAt, ComprehensionQuestion.Id)
        )
        return list(result.scalars().all())

    async def question(self, session_id: UUID, question_id: UUID) -> ComprehensionQuestion | None:
        return await self.db.scalar(
            select(ComprehensionQuestion).where(
                ComprehensionQuestion.Id == question_id,
                ComprehensionQuestion.SessionId == session_id,
            )
        )

    async def answers(self, question_ids: list[UUID]) -> list[ComprehensionAnswer]:
        if not question_ids:
            return []
        result = await self.db.execute(
            select(ComprehensionAnswer)
            .where(ComprehensionAnswer.QuestionId.in_(question_ids))
            .order_by(ComprehensionAnswer.CreatedAt, ComprehensionAnswer.Id)
        )
        return list(result.scalars().all())

    def add_questions(self, questions: list[ComprehensionQuestion]) -> None:
        self.db.add_all(questions)

    def add_answer(self, answer: ComprehensionAnswer) -> None:
        self.db.add(answer)

    async def commit(self) -> None:
        try:
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise

    async def release(self) -> None:
        """End the read transaction so no DB slot is held during a slow AI call."""
        await self.db.rollback()

    async def refresh(self, instance: object) -> None:
        await self.db.refresh(instance)
