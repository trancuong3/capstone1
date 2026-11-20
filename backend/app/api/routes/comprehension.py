"""Legacy comprehension API with session ownership and server-side answer grading.

The active reading UI uses /tutor/sessions/*; these legacy routes must not bypass
its parent isolation or let clients choose their own correctness scores.
"""

from unicodedata import normalize
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_parent_id
from app.models import (
    ChildProfile,
    ComprehensionAnswer,
    ComprehensionQuestion,
    ReadingSession,
    ReadingSessionPage,
)
from app.schemas import (
    ComprehensionQuestionResponse,
    ComprehensionQuestionCreate,
    ComprehensionAnswerResponse,
    ComprehensionAnswerCreate,
)

router = APIRouter()


def _normalize_answer(value: str) -> str:
    return normalize("NFC", value).strip().casefold()


@router.get("/questions", response_model=list[ComprehensionQuestionResponse])
async def get_questions(
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Do not return another parent's prompts, expected answers or source spans."""
    result = await db.execute(
        select(ComprehensionQuestion)
        .join(ReadingSession, ComprehensionQuestion.SessionId == ReadingSession.Id)
        .join(ChildProfile, ReadingSession.ChildId == ChildProfile.Id)
        .where(ChildProfile.ParentId == actor_id)
    )
    return result.scalars().all()


@router.post("/questions", response_model=ComprehensionQuestionResponse)
async def create_question(
    question_in: ComprehensionQuestionCreate,
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Only add questions to a page and revision in an owned reading session."""
    owned_session = await db.scalar(
        select(ReadingSession.Id)
        .join(ChildProfile, ReadingSession.ChildId == ChildProfile.Id)
        .join(ReadingSessionPage, ReadingSessionPage.SessionId == ReadingSession.Id)
        .where(
            ReadingSession.Id == question_in.SessionId,
            ChildProfile.ParentId == actor_id,
            ReadingSessionPage.PageId == question_in.PageId,
            ReadingSessionPage.PageRevisionId == question_in.PageRevisionId,
        )
    )
    if owned_session is None:
        raise HTTPException(status_code=404, detail="Resource not found")
    question = ComprehensionQuestion(**question_in.model_dump())
    db.add(question)
    await db.commit()
    await db.refresh(question)
    return question


@router.post("/answers", response_model=ComprehensionAnswerResponse)
async def create_answer(
    answer_in: ComprehensionAnswerCreate,
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Look up the question through the owner before writing an answer.

    The supplied score and is_correct fields are legacy-compatible inputs,
    but never authoritative: correctness is calculated on the server.
    """
    question = await db.scalar(
        select(ComprehensionQuestion)
        .join(ReadingSession, ComprehensionQuestion.SessionId == ReadingSession.Id)
        .join(ChildProfile, ReadingSession.ChildId == ChildProfile.Id)
        .where(
            ComprehensionQuestion.Id == answer_in.QuestionId,
            ChildProfile.ParentId == actor_id,
        )
    )
    if question is None:
        raise HTTPException(status_code=404, detail="Resource not found")
    allowed = [question.ExpectedAnswer]
    if isinstance(question.AcceptedAnswers, list):
        allowed.extend(
            item for item in question.AcceptedAnswers if isinstance(item, str)
        )
    normalized = _normalize_answer(answer_in.Answer)
    correct = bool(normalized) and any(
        normalized == _normalize_answer(item) for item in allowed
    )
    answer = ComprehensionAnswer(
        QuestionId=answer_in.QuestionId,
        Answer=answer_in.Answer,
        IsCorrect=correct,
        Score=1.0 if correct else 0.0,
    )
    db.add(answer)
    await db.commit()
    await db.refresh(answer)
    return answer
