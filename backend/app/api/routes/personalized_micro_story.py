"""HTTP routes for Personalized Weak-Word 4-Page Micro-Storybooks (Feature #4)."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.schemas.personalized_micro_story import (
    MicroStoryGenerateRequest,
    MicroStoryGenerateResponse,
    MicroStoryPreviewRead,
    MicroStoryQuotaRead,
)
from app.services.personalized_micro_story_service import PersonalizedMicroStoryService

router = APIRouter()

_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Vary": "Authorization",
}


def _apply_no_store(response: Response) -> None:
    for key, value in _PRIVATE_NO_STORE_HEADERS.items():
        response.headers[key] = value


@router.get(
    "/children/{child_id}/quota",
    response_model=MicroStoryQuotaRead,
)
async def get_child_micro_story_quota(
    child_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> MicroStoryQuotaRead:
    _apply_no_store(response)
    return await PersonalizedMicroStoryService(db).get_quota(actor_id, child_id)


@router.get(
    "/children/{child_id}/preview-words",
    response_model=MicroStoryPreviewRead,
)
async def preview_child_micro_story_words(
    child_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> MicroStoryPreviewRead:
    _apply_no_store(response)
    return await PersonalizedMicroStoryService(db).preview_words(actor_id, child_id)


@router.post(
    "/children/{child_id}/generate",
    response_model=MicroStoryGenerateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def generate_child_micro_story(
    child_id: UUID,
    payload: MicroStoryGenerateRequest,
    request: Request,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> MicroStoryGenerateResponse:
    _apply_no_store(response)
    return await PersonalizedMicroStoryService(db).generate_micro_story(
        actor_id,
        child_id,
        payload,
        base_url=str(request.base_url),
    )
