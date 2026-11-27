from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.repositories.sentence_shooter_repository import SentenceShooterRepository
from app.schemas.sentence_shooter import (
    Difficulty,
    SentenceShooterAbandonRead,
    SentenceShooterBookRead,
    SentenceShooterHintRead,
    SentenceShooterHintRequest,
    SentenceShooterNextRoundRead,
    SentenceShooterNextRoundRequest,
    SentenceShooterResultRead,
    SentenceShooterSessionCreate,
    SentenceShooterSessionRead,
    SentenceShooterShotRead,
    SentenceShooterShotRequest,
)
from app.services.games.sentence_shooter_service import SentenceShooterService
from app.services.rate_limiter import rate_limit

router = APIRouter(
    dependencies=[Depends(rate_limit("games", default_max=120, default_window=60.0))]
)


def build_service(db: AsyncSession) -> SentenceShooterService:
    return SentenceShooterService(SentenceShooterRepository(db))


@router.get("/books", response_model=list[SentenceShooterBookRead])
async def list_game_books(
    child_id: UUID = Query(...),
    difficulty: Difficulty = Query(default="easy"),
    total_rounds: int = Query(default=3, ge=1, le=5),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await build_service(db).list_books(
        actor_id,
        child_id,
        difficulty,
        total_rounds,
    )


@router.post(
    "/sessions",
    response_model=SentenceShooterSessionRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_game_session(
    payload: SentenceShooterSessionCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await build_service(db).create_session(actor_id, payload)


@router.post(
    "/sessions/{session_id}/shots",
    response_model=SentenceShooterShotRead,
)
async def shoot_word(
    session_id: UUID,
    payload: SentenceShooterShotRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await build_service(db).shoot(
        actor_id,
        session_id,
        payload.round_id,
        payload.token_id,
        payload.effective_request_id,
        client_shot_id=payload.client_shot_id,
    )


@router.post(
    "/sessions/{session_id}/hints",
    response_model=SentenceShooterHintRead,
)
async def request_hint(
    session_id: UUID,
    payload: SentenceShooterHintRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await build_service(db).hint(
        actor_id,
        session_id,
        payload.round_id,
    )


@router.post(
    "/sessions/{session_id}/next-round",
    response_model=SentenceShooterNextRoundRead,
)
async def next_round(
    session_id: UUID,
    payload: SentenceShooterNextRoundRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await build_service(db).next_round(
        actor_id,
        session_id,
        payload.round_id,
    )


@router.get(
    "/sessions/{session_id}/result",
    response_model=SentenceShooterResultRead,
)
async def get_result(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await build_service(db).result(actor_id, session_id)


@router.post(
    "/sessions/{session_id}/abandon",
    response_model=SentenceShooterAbandonRead,
)
async def abandon_session(
    session_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await build_service(db).abandon(actor_id, session_id)
