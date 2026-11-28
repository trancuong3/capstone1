"""HTTP routes for Feature #5: Prosody, Punctuation-Pause & Intonation Coach.

Strictly `PARENT_PRIVATE`:
  - Requires active parent authentication (`require_parent_id`).
  - Enforces child & session ownership on all session endpoints.
  - Emits `Cache-Control: private, no-store` on every response.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_parent_id
from app.schemas.fluency_prosody import (
    AnalyzeProsodyRequest,
    AnnotateCuesRequest,
    AnnotateCuesResponse,
    ProsodyAnalysisResponse,
)
from app.services.fluency_prosody_service import FluencyProsodyService
from app.services.rate_limiter import rate_limit

router = APIRouter(
    dependencies=[Depends(rate_limit("fluency_prosody", default_max=120, default_window=60.0))]
)

_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store",
    "Pragma": "no-cache",
    "Vary": "Authorization",
}


def _apply_no_store(response: Response) -> None:
    for key, value in _PRIVATE_NO_STORE_HEADERS.items():
        response.headers[key] = value


@router.post(
    "/children/{child_id}/sessions/{session_id}/analyze-prosody",
    response_model=ProsodyAnalysisResponse,
    status_code=status.HTTP_200_OK,
    summary="Analyze prosody, punctuation pauses & intonation for a child's reading session",
)
async def analyze_child_session_prosody(
    child_id: UUID,
    session_id: UUID,
    payload: AnalyzeProsodyRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> ProsodyAnalysisResponse:
    _apply_no_store(response)
    return await FluencyProsodyService(db).analyze_session_prosody(
        parent_id, child_id, session_id, payload
    )


@router.post(
    "/annotate-cues",
    response_model=AnnotateCuesResponse,
    status_code=status.HTTP_200_OK,
    summary="Annotate reading page text with breathing & intonation visual cues",
)
async def annotate_reading_breathing_cues(
    payload: AnnotateCuesRequest,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> AnnotateCuesResponse:
    _apply_no_store(response)
    return FluencyProsodyService(db).annotate_cues(payload)
