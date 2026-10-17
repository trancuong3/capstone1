"""Authenticated contextual tutor endpoint; no queries or prompts in the router."""

from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.repositories.tutor_repository import TutorRepository
from app.schemas.tutor import TutorExplainWordRequest, TutorExplainWordResponse
from app.services.tutor_service import TutorService


router = APIRouter()


def get_tutor_service(db: AsyncSession = Depends(get_db)) -> TutorService:
    return TutorService(TutorRepository(db))


@router.post("/sessions/{session_id}/explain-word", response_model=TutorExplainWordResponse)
async def explain_word(
    session_id: UUID,
    payload: TutorExplainWordRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    service: TutorService = Depends(get_tutor_service),
) -> TutorExplainWordResponse:
    response.headers["Cache-Control"] = "no-store"
    return await service.explain_word(actor_id, session_id, payload)
