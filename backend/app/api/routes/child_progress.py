"""Authenticated endpoints for the AI progress assessment of a child."""

from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.repositories.child_progress_repository import ChildProgressRepository
from app.schemas.child_progress import (
    AssessmentRequest,
    ChildProgressAssessmentRead,
    PhonologySandboxRead,
)
from app.services.child_progress_service import ChildProgressService
from app.services.rate_limiter import rate_limit

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
    teacher_gender: str | None = Query(default=None, pattern="^(female|male)$"),
    actor_id: UUID = Depends(get_current_parent_id),
    _rate_limited: None = Depends(
        rate_limit("child_progress_read", default_max=60, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
):
    """Scores and metrics now; comments are the cached AI text or offline comments."""
    safe_gender = (
        teacher_gender if isinstance(teacher_gender, str) and teacher_gender in ("female", "male") else None
    )
    resolved_days = days if isinstance(days, int) and not isinstance(days, bool) else 30
    extra_kwargs = {"teacher_gender": safe_gender} if safe_gender is not None else {}
    return await _service(db).assess(
        child_id,
        actor_id,
        days=resolved_days,
        use_ai=False,
        **extra_kwargs,
    )


@router.post(
    "/children/{child_id}/progress-assessment",
    response_model=ChildProgressAssessmentRead,
)
async def create_progress_assessment(
    child_id: UUID,
    payload: AssessmentRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    _rate_limited: None = Depends(
        rate_limit("child_progress_ai", default_max=20, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
):
    """Ask the AI to write the assessment (cached while the data is unchanged)."""
    return await _service(db).assess(
        child_id,
        actor_id,
        days=payload.days,
        use_ai=True,
        refresh=payload.refresh,
        teacher_gender=payload.teacher_gender,
    )


@router.get(
    "/children/{child_id}/phonology-sandbox",
    response_model=PhonologySandboxRead,
)
async def get_phonology_sandbox(
    child_id: UUID,
    days: int = Query(default=30, ge=7, le=90),
    actor_id: UUID = Depends(get_current_parent_id),
    _rate_limited: None = Depends(
        rate_limit("child_phonology_sandbox", default_max=60, default_window=60.0)
    ),
    db: AsyncSession = Depends(get_db),
) -> PhonologySandboxRead:
    """Deterministic Vietnamese minimal-pair warm-up exercises for recurring tone/onset/coda contrasts."""
    safe_days = days if isinstance(days, int) and not isinstance(days, bool) else 30
    return await _service(db).get_phonology_sandbox(child_id, actor_id, days=safe_days)
