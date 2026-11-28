"""API routes for Adaptive Learning Engine (G03) and Parent Entertainment Analytics (G11)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_parent_id
from app.database.session import get_db
from app.repositories.adaptive_learning_repository import AdaptiveLearningRepository
from app.schemas.adaptive_learning import (
    AdaptiveProfileRead,
    DailyFiveMinuteTrainCompleteRequest,
    DailyFiveMinuteTrainCompleteResponse,
    DailyFiveMinuteTrainRead,
    EntertainmentRecommendationsRead,
    ParentEntertainmentAnalyticsRead,
    SkillEvidenceCreate,
    SkillEvidenceRead,
)
from app.schemas.magic_rhythm_chant import (
    MagicRhythmChantCompleteRead,
    MagicRhythmChantCompleteRequest,
    MagicRhythmChantGenerateRequest,
    MagicRhythmChantRead,
)
from app.schemas.magic_word_quest import (
    MagicQuestCompleteRead,
    MagicQuestCompleteRequest,
    MagicQuestGenerateRequest,
    MagicWordQuestRead,
)
from app.services.adaptive_learning_service import AdaptiveLearningService
from app.services.magic_rhythm_chant_service import MagicRhythmChantService
from app.services.magic_word_quest_service import MagicWordQuestService
from app.services.rate_limiter import rate_limiter

router = APIRouter()


def _apply_private_no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Vary"] = "Authorization"


def _enforce_child_quest_rate_limit(
    bucket: str,
    parent_id: UUID,
    child_id: UUID,
    *,
    default_max: int,
    default_window: float,
) -> None:
    max_req, window_s = rate_limiter.resolve_limits(bucket, default_max, default_window)
    retry_after = rate_limiter.check(
        bucket,
        f"{parent_id}:{child_id}",
        max_requests=max_req,
        window_seconds=window_s,
    )
    if retry_after is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "RATE_LIMIT_EXCEEDED",
                "message": "Bé mở cuộn phép thuật hơi nhanh rồi, mình đợi ít giây nhé!",
            },
            headers={"Retry-After": str(retry_after)},
        )


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
    resolved_window = window_days if isinstance(window_days, int) and not isinstance(window_days, bool) else 30
    extra_kwargs = {"teacher_gender": safe_gender} if safe_gender is not None else {}
    return await _service(db).get_adaptive_profile(
        child_id,
        parent_id,
        window_days=resolved_window,
        **extra_kwargs,
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
    resolved_window = window_days if isinstance(window_days, int) and not isinstance(window_days, bool) else 30
    extra_kwargs = {"teacher_gender": safe_gender} if safe_gender is not None else {}
    return await _service(db).get_parent_analytics(
        child_id,
        parent_id,
        window_days=resolved_window,
        **extra_kwargs,
    )


@router.post("/children/{child_id}/evidence", response_model=SkillEvidenceRead)
async def record_child_skill_evidence(
    child_id: UUID,
    payload: SkillEvidenceCreate,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> SkillEvidenceRead:
    return await _service(db).record_evidence(child_id, parent_id, payload)


@router.get(
    "/children/{child_id}/daily-five-minute-train",
    response_model=DailyFiveMinuteTrainRead,
)
async def get_child_daily_five_minute_train(
    child_id: UUID,
    response: Response,
    teacher_gender: str | None = Query(default=None, pattern="^(female|male)$"),
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> DailyFiveMinuteTrainRead:
    _apply_private_no_store(response)
    safe_gender = (
        teacher_gender
        if isinstance(teacher_gender, str) and teacher_gender in ("female", "male")
        else None
    )
    return await _service(db).get_daily_five_minute_train(
        child_id,
        parent_id,
        teacher_gender=safe_gender,
    )


@router.post(
    "/children/{child_id}/daily-five-minute-train/complete",
    response_model=DailyFiveMinuteTrainCompleteResponse,
)
async def complete_child_daily_five_minute_train(
    child_id: UUID,
    payload: DailyFiveMinuteTrainCompleteRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> DailyFiveMinuteTrainCompleteResponse:
    _apply_private_no_store(response)
    return await _service(db).complete_daily_five_minute_train(
        child_id,
        parent_id,
        payload,
    )


@router.post(
    "/children/{child_id}/magic-word-quest",
    response_model=MagicWordQuestRead,
)
async def create_child_magic_word_quest(
    child_id: UUID,
    payload: MagicQuestGenerateRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> MagicWordQuestRead:
    _enforce_child_quest_rate_limit(
        "magic_word_quest", parent_id, child_id, default_max=6, default_window=600.0
    )
    _apply_private_no_store(response)
    return await MagicWordQuestService(AdaptiveLearningRepository(db)).generate_quest(
        child_id, parent_id, payload
    )


@router.post(
    "/children/{child_id}/magic-word-quest/complete",
    response_model=MagicQuestCompleteRead,
)
async def complete_child_magic_word_quest(
    child_id: UUID,
    payload: MagicQuestCompleteRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> MagicQuestCompleteRead:
    _enforce_child_quest_rate_limit(
        "magic_word_quest_complete", parent_id, child_id, default_max=20, default_window=60.0
    )
    _apply_private_no_store(response)
    return await MagicWordQuestService(AdaptiveLearningRepository(db)).complete_quest(
        child_id, parent_id, payload
    )


@router.post(
    "/children/{child_id}/magic-rhythm-chant",
    response_model=MagicRhythmChantRead,
)
async def create_child_magic_rhythm_chant(
    child_id: UUID,
    payload: MagicRhythmChantGenerateRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> MagicRhythmChantRead:
    _enforce_child_quest_rate_limit(
        "magic_rhythm_chant", parent_id, child_id, default_max=6, default_window=600.0
    )
    _apply_private_no_store(response)
    return await MagicRhythmChantService(AdaptiveLearningRepository(db)).generate_chant(
        child_id, parent_id, payload
    )


@router.post(
    "/children/{child_id}/magic-rhythm-chant/complete",
    response_model=MagicRhythmChantCompleteRead,
)
async def complete_child_magic_rhythm_chant(
    child_id: UUID,
    payload: MagicRhythmChantCompleteRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> MagicRhythmChantCompleteRead:
    _enforce_child_quest_rate_limit(
        "magic_rhythm_chant_complete", parent_id, child_id, default_max=20, default_window=60.0
    )
    _apply_private_no_store(response)
    return await MagicRhythmChantService(AdaptiveLearningRepository(db)).complete_chant(
        child_id, parent_id, payload
    )
