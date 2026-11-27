from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_parent_id
from app.repositories.memory_game_repository import MemoryGameRepository
from app.schemas.memory_game import (
    MemoryAttemptCreate,
    MemoryAttemptSubmitRead,
    MemoryHintRead,
    MemoryHintRequest,
    MemoryPeekRead,
    MemorySessionCreate,
    MemorySessionRead,
    MemorySessionSummaryRead,
    MemoryThemesCatalogRead,
)
from app.services.games.memory_game_service import MemoryGameService

router = APIRouter()


def _build_service(db: AsyncSession) -> MemoryGameService:
    return MemoryGameService(MemoryGameRepository(db))


@router.get("/themes", response_model=MemoryThemesCatalogRead)
async def list_memory_game_themes(
    _parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return _build_service(db).get_themes()


@router.post(
    "/sessions",
    response_model=MemorySessionRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_memory_game_session(
    payload: MemorySessionCreate,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _build_service(db).create_session(parent_id, payload)


@router.get("/sessions", response_model=list[MemorySessionSummaryRead])
async def list_memory_game_sessions(
    child_id: UUID = Query(...),
    limit: int = Query(default=10, ge=1, le=50),
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 10
    return await _build_service(db).list_sessions(parent_id, child_id, limit=limit)


@router.get("/sessions/{session_id}", response_model=MemorySessionRead)
async def get_memory_game_session(
    session_id: UUID,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _build_service(db).get_session(parent_id, session_id)


@router.post("/sessions/{session_id}/hint", response_model=MemoryHintRead)
async def request_memory_game_hint(
    session_id: UUID,
    payload: MemoryHintRequest | None = None,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    request_body = payload or MemoryHintRequest()
    return await _build_service(db).request_hint(parent_id, session_id, request_body)


@router.post("/sessions/{session_id}/peek", response_model=MemoryPeekRead)
async def record_memory_game_peek(
    session_id: UUID,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _build_service(db).record_peek(parent_id, session_id)


@router.post("/sessions/{session_id}/attempts", response_model=MemoryAttemptSubmitRead)
async def submit_memory_game_attempt(
    session_id: UUID,
    payload: MemoryAttemptCreate,
    parent_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await _build_service(db).submit_attempt(parent_id, session_id, payload)
