"""Authenticated endpoints for the AI tutor comprehension questions."""

from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.repositories.tutor_question_repository import TutorQuestionRepository
from app.schemas.tutor_question import (
    TutorAnswerRequest,
    TutorAnswerResultRead,
    TutorNextQuestionRead,
    TutorQuestionSetRead,
)
from app.services.tutor_question_service import TutorQuestionService

router = APIRouter()


def _service(db: AsyncSession) -> TutorQuestionService:
    return TutorQuestionService(TutorQuestionRepository(db))


@router.post(
    "/sessions/{session_id}/questions/generate",
    response_model=TutorQuestionSetRead,
)
async def generate_questions(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Create questions for a finished reading session. Safe to call repeatedly."""
    return await _service(db).generate_for_session(session_id, actor_id)


@router.get(
    "/sessions/{session_id}/questions/next",
    response_model=TutorNextQuestionRead,
)
async def next_question(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Return the next question the child has not answered correctly."""
    return await _service(db).next_question(session_id, actor_id)


@router.post(
    "/sessions/{session_id}/questions/{question_id}/answer",
    response_model=TutorAnswerResultRead,
)
async def submit_answer(
    session_id: UUID,
    question_id: UUID,
    payload: TutorAnswerRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Grade an answer on the server; the expected answer is never returned."""
    return await _service(db).submit_answer(session_id, question_id, actor_id, payload.answer)
