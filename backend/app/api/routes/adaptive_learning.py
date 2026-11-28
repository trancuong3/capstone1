"""API routes for Adaptive Learning Engine (G03) and Parent Entertainment Analytics (G11)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_parent_id
from app.database.session import get_db
from app.repositories.adaptive_learning_repository import AdaptiveLearningRepository
from app.schemas.adaptive_learning import (
    AdaptiveProfileRead,
    EntertainmentRecommendationsRead,
    ParentEntertainmentAnalyticsRead,
    SkillEvidenceCreate,
    SkillEvidenceRead,
)
from app.services.adaptive_learning_service import AdaptiveLearningService

router = APIRouter()


def _service(db: AsyncSession) -> AdaptiveLearningService:
    return AdaptiveLearningService(AdaptiveLearningRepository(db))


@router.get("/children/{child_id}/profile", response_model=AdaptiveProfileRead)
async def get_child_adaptive_profile(
    child_id: UUID,
    window_days: int = Query(default=30, ge=7, le=90),
    teacher_gender: str | None = Query(default=None, pattern="^(female|male)$"),
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> AdaptiveProfileRead:
    safe_gender = (
        teacher_gender if isinstance(teacher_gender, str) and teacher_gender in ("female", "male") else None
    )
    return await _service(db).get_adaptive_profile(
        child_id,
        parent_id,
        window_days=window_days,
        teacher_gender=safe_gender,
    )


@router.get(
    "/children/{child_id}/recommendations",
    response_model=EntertainmentRecommendationsRead,
)
async def get_child_entertainment_recommendations(
    child_id: UUID,
    teacher_gender: str | None = Query(default=None, pattern="^(female|male)$"),
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> EntertainmentRecommendationsRead:
    safe_gender = (
        teacher_gender if isinstance(teacher_gender, str) and teacher_gender in ("female", "male") else None
    )
    return await _service(db).get_entertainment_recommendations(
        child_id,
        parent_id,
        teacher_gender=safe_gender,
    )


@router.get(
    "/children/{child_id}/parent-analytics",
    response_model=ParentEntertainmentAnalyticsRead,
)
async def get_child_parent_entertainment_analytics(
    child_id: UUID,
    window_days: int = Query(default=30, ge=7, le=90),
    teacher_gender: str | None = Query(default=None, pattern="^(female|male)$"),
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> ParentEntertainmentAnalyticsRead:
    safe_gender = (
        teacher_gender if isinstance(teacher_gender, str) and teacher_gender in ("female", "male") else None
    )
    return await _service(db).get_parent_analytics(
        child_id,
        parent_id,
        window_days=window_days,
        teacher_gender=safe_gender,
    )


@router.post("/children/{child_id}/evidence", response_model=SkillEvidenceRead)
async def record_child_skill_evidence(
    child_id: UUID,
    payload: SkillEvidenceCreate,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> SkillEvidenceRead:
    return await _service(db).record_evidence(child_id, parent_id, payload)
