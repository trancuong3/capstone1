"""FastAPI router for Musical Karaoke practice persistence & song musical profiles.

Mounted by coordinator under `/karaoke` in `app/api/router.py`.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db, require_parent_id
from app.repositories.karaoke_practice_repository import KaraokePracticeRepository
from app.schemas.karaoke_practice import (
    KaraokePracticeHistoryResponse,
    KaraokePracticeSessionCreate,
    KaraokePracticeSessionRead,
    MusicalProfileRead,
)
from app.services.karaoke_practice_service import KaraokePracticeService

router = APIRouter()


def get_karaoke_practice_service(
    db: AsyncSession = Depends(get_db),
) -> KaraokePracticeService:
    return KaraokePracticeService(KaraokePracticeRepository(db))


@router.post(
    "/practice-sessions",
    response_model=KaraokePracticeSessionRead,
    status_code=201,
)
async def create_practice_session(
    payload: KaraokePracticeSessionCreate,
    parent_id: UUID = Depends(require_parent_id),
    service: KaraokePracticeService = Depends(get_karaoke_practice_service),
) -> KaraokePracticeSessionRead:
    return await service.create_practice_session(parent_id, payload)


@router.get(
    "/practice-sessions",
    response_model=KaraokePracticeHistoryResponse,
)
async def list_practice_sessions(
    child_id: UUID,
    song_id: UUID | None = None,
    limit: int = Query(default=10, ge=1, le=50),
    parent_id: UUID = Depends(require_parent_id),
    service: KaraokePracticeService = Depends(get_karaoke_practice_service),
) -> KaraokePracticeHistoryResponse:
    return await service.list_practice_sessions(
        parent_id,
        child_id,
        song_id=song_id,
        limit=limit,
    )


@router.get(
    "/songs/{song_id}/musical-profile",
    response_model=MusicalProfileRead,
)
async def get_song_musical_profile(
    song_id: UUID,
    _actor_id: UUID = Depends(get_current_parent_id),
    service: KaraokePracticeService = Depends(get_karaoke_practice_service),
) -> MusicalProfileRead:
    return await service.get_musical_profile(song_id)
