"""Authenticated endpoints for the AI progress assessment of a child."""

from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.repositories.child_progress_repository import ChildProgressRepository
from app.schemas.child_progress import AssessmentRequest, ChildProgressAssessmentRead
from app.services.child_progress_service import ChildProgressService

router = APIRouter()


def _service(db: AsyncSession) -> ChildProgressService:
    return ChildProgressService(ChildProgressRepository(db))


@router.get(
    "/children/{child_id}/progress-assessment",
    response_model=ChildProgressAssessmentRead,
)
async def get_progress_assessment(
    child_id: UUID,
    days: int = Query(default=30, ge=7, le=90),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Scores and metrics now; comments are the cached AI text or offline comments."""
    return await _service(db).assess(child_id, actor_id, days=days, use_ai=False)


@router.post(
    "/children/{child_id}/progress-assessment",
    response_model=ChildProgressAssessmentRead,
)
async def create_progress_assessment(
    child_id: UUID,
    payload: AssessmentRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Ask the AI to write the assessment (cached while the data is unchanged)."""
    return await _service(db).assess(
        child_id, actor_id, days=payload.days, use_ai=True, refresh=payload.refresh
    )
