"""HTTP routes for Feature #3: Regional Phonetic Profile & Ear-Before-Voice Trainer.

Mounted at prefix `/dialect` in `backend/app/api/router.py`.
All endpoints: PARENT_PRIVATE (require_parent_id + child ownership + Cache-Control: private, no-store).
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_parent_id
from app.schemas.regional_phonetics import (
    AlignmentEvaluateRequest,
    AlignmentEvaluateResponse,
    EarTrainer30sResponse,
    EarTrainerCompleteRequest,
    EarTrainerCompleteResponse,
    RegionalPhoneticProfileResponse,
    RegionalPhoneticProfileUpdate,
)
from app.services.rate_limiter import rate_limit
from app.services.regional_phonetics_service import RegionalPhoneticService

router = APIRouter(
    dependencies=[Depends(rate_limit("dialect", default_max=120, default_window=60.0))]
)

_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store",
    "Pragma": "no-cache",
    "Vary": "Authorization",
}


def _apply_no_store(response: Response) -> None:
    for key, value in _PRIVATE_NO_STORE_HEADERS.items():
        response.headers[key] = value


# ─── Profile ─────────────────────────────────────────────────────────────────


@router.get(
    "/children/{child_id}/profile",
    response_model=RegionalPhoneticProfileResponse,
    status_code=status.HTTP_200_OK,
    summary="Get child's regional phonetic profile",
)
async def get_regional_phonetic_profile(
    child_id: UUID,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> RegionalPhoneticProfileResponse:
    _apply_no_store(response)
    return await RegionalPhoneticService(db).get_profile(parent_id, child_id)


@router.put(
    "/children/{child_id}/profile",
    response_model=RegionalPhoneticProfileResponse,
    status_code=status.HTTP_200_OK,
    summary="Update child's regional phonetic profile",
)
async def update_regional_phonetic_profile(
    child_id: UUID,
    payload: RegionalPhoneticProfileUpdate,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> RegionalPhoneticProfileResponse:
    _apply_no_store(response)
    return await RegionalPhoneticService(db).update_profile(parent_id, child_id, payload)


# ─── Alignment evaluation ─────────────────────────────────────────────────────


@router.post(
    "/children/{child_id}/evaluate-alignment",
    response_model=AlignmentEvaluateResponse,
    status_code=status.HTTP_200_OK,
    summary="Evaluate alignment with dual strict/regional accuracy scores",
)
async def evaluate_alignment(
    child_id: UUID,
    payload: AlignmentEvaluateRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> AlignmentEvaluateResponse:
    _apply_no_store(response)
    return await RegionalPhoneticService(db).evaluate_alignment(parent_id, child_id, payload)


# ─── Ear Trainer ─────────────────────────────────────────────────────────────


@router.get(
    "/children/{child_id}/ear-trainer-30s",
    response_model=EarTrainer30sResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate 30-second Tai Thính Miệng Xinh ear-before-voice minimal pair drill",
)
async def get_ear_trainer_30s(
    child_id: UUID,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> EarTrainer30sResponse:
    _apply_no_store(response)
    return await RegionalPhoneticService(db).get_ear_trainer(parent_id, child_id)


@router.post(
    "/children/{child_id}/ear-trainer-30s/complete",
    response_model=EarTrainerCompleteResponse,
    status_code=status.HTTP_200_OK,
    summary="Record completion of 30-second ear trainer drill",
)
async def complete_ear_trainer_30s(
    child_id: UUID,
    payload: EarTrainerCompleteRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> EarTrainerCompleteResponse:
    _apply_no_store(response)
    return await RegionalPhoneticService(db).complete_ear_trainer(parent_id, child_id, payload)
