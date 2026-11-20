"""Legacy comprehension compatibility routes.

The active reading UI uses the authenticated /tutor/sessions/* API. This
compatibility adapter must not bypass its trusted generation or grading service.
"""

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
)
from app.repositories.tutor_question_repository import TutorQuestionRepository
from app.schemas import (
    ComprehensionQuestionCreate,
    ComprehensionAnswerCreate,
    ComprehensionAnswerResponse,
)
from app.schemas.comprehension import ComprehensionQuestionPublic
from app.services.tutor_question_service import TutorQuestionService

router = APIRouter()


@router.get("/questions", response_model=list[ComprehensionQuestionPublic])
async def get_questions(
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """List only owned questions, without grading keys or private source data."""
    result = await db.execute(
        select(ComprehensionQuestion)
        .join(ReadingSession, ComprehensionQuestion.SessionId == ReadingSession.Id)
        .join(ChildProfile, ReadingSession.ChildId == ChildProfile.Id)
        .where(ChildProfile.ParentId == actor_id)
    )
    return result.scalars().all()


@router.post("/questions", status_code=403)
async def create_question(
    _question_in: ComprehensionQuestionCreate,
    _actor_id: UUID = Depends(require_parent_id),
):
    """Fail closed: clients may not fabricate trusted tutor questions.

    The supported generator is POST /tutor/sessions/{session_id}/questions/generate,
    which validates the finished reading session and sources the answers itself.
    """
    raise HTTPException(status_code=403, detail="Use the authenticated tutor question generator")


@router.post("/answers", response_model=ComprehensionAnswerResponse)
async def create_answer(
    answer_in: ComprehensionAnswerCreate,
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Route legacy submissions through the trusted, idempotent tutor grader."""
    submitted = answer_in.Answer.strip()
    if not submitted or len(submitted) > 200:
        raise HTTPException(status_code=422, detail="Invalid answer")

    # Resolve question through the owner before even invoking the grading service.
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

    outcome = await TutorQuestionService(
        TutorQuestionRepository(db)
    ).submit_answer(question.SessionId, answer_in.QuestionId, actor_id, submitted)

    # Return the stored row (including its original CreatedAt when idempotent).
    answer = await db.scalar(
        select(ComprehensionAnswer).where(
            ComprehensionAnswer.Id == outcome.answer_id,
            ComprehensionAnswer.QuestionId == answer_in.QuestionId,
        )
    )
    if answer is None:
        raise HTTPException(status_code=503, detail="Answer persistence unavailable")
    return answer
