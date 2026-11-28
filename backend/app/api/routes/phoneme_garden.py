"""HTTP routes for Feature #7: 7-Bed Vietnamese Phoneme Garden & Book Stamp Passport.

Mounted at prefix `/phoneme-garden` in `app/api/router.py`.

PARENT_PRIVATE: all endpoints enforce `require_parent_id` + child ownership check +
`Cache-Control: private, no-store`.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_parent_id
from app.schemas.phoneme_garden import PhonemeGardenSummaryResponse
from app.services.phoneme_garden_service import PhonemeGardenService
from app.services.rate_limiter import rate_limit

router = APIRouter(
    dependencies=[
        Depends(rate_limit("phoneme_garden", default_max=120, default_window=60.0))
    ]
)

_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store",
    "Pragma": "no-cache",
    "Vary": "Authorization",
}


def _apply_no_store(response: Response) -> None:
    for key, value in _PRIVATE_NO_STORE_HEADERS.items():
        response.headers[key] = value


@router.get(
    "/children/{child_id}/summary",
    response_model=PhonemeGardenSummaryResponse,
    status_code=status.HTTP_200_OK,
    summary="Get 7-Bed Vietnamese Phoneme Garden & Book Stamp Passport summary for a child",
)
async def get_child_phoneme_garden_summary(
    child_id: UUID,
    response: Response,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> PhonemeGardenSummaryResponse:
    _apply_no_store(response)
    return await PhonemeGardenService(db).get_child_summary(parent_id, child_id)
