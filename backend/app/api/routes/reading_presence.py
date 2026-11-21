"""Opt-in "nobody in frame" parent email: settings and absence-episode alerts.

The client may only report that an absence episode started, still holds, or
ended. Recipient, delay, TTL and limits are decided here.
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.repositories.reading_presence_repository import ReadingPresenceRepository
from app.schemas.reading_presence import (
    PresenceAlertArm,
    PresenceAlertCancel,
    PresenceAlertRead,
    PresenceSettingsRead,
    PresenceSettingsUpdate,
)
from app.services.reading_presence_service import (
    PresenceConflict,
    PresenceNotFound,
    ReadingPresenceService,
)

router = APIRouter()


def build_service(db: AsyncSession) -> ReadingPresenceService:
    return ReadingPresenceService(ReadingPresenceRepository(db))


def to_read(alert) -> PresenceAlertRead:
    return PresenceAlertRead(
        id=alert.Id,
        session_id=alert.SessionId,
        episode_id=alert.EpisodeId,
        status=alert.Status,
        due_at=alert.DueAt,
        expires_at=alert.ExpiresAt,
        cancel_reason=alert.CancelReason,
    )


def map_error(error: Exception) -> HTTPException:
    if isinstance(error, PresenceNotFound):
        return HTTPException(status_code=404, detail="Resource not found")
    if isinstance(error, PresenceConflict):
        return HTTPException(status_code=409, detail={"code": error.reason})
    return HTTPException(status_code=500, detail="Internal server error")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@router.get("/settings", response_model=PresenceSettingsRead)
async def read_settings(
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> PresenceSettingsRead:
    return PresenceSettingsRead(
        email_enabled=await build_service(db).email_enabled(actor_id)
    )


@router.put("/settings", response_model=PresenceSettingsRead)
async def update_settings(
    payload: PresenceSettingsUpdate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> PresenceSettingsRead:
    enabled = await build_service(db).set_email_enabled(
        actor_id, payload.email_enabled, utcnow()
    )
    return PresenceSettingsRead(email_enabled=enabled)


@router.post(
    "/alerts", response_model=PresenceAlertRead, status_code=status.HTTP_201_CREATED
)
async def arm_alert(
    payload: PresenceAlertArm,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> PresenceAlertRead:
    try:
        alert, _created = await build_service(db).arm(
            actor_id, payload.session_id, payload.episode_id, utcnow()
        )
    except (PresenceNotFound, PresenceConflict) as error:
        raise map_error(error) from None
    return to_read(alert)


@router.post("/alerts/{alert_id}/confirm", response_model=PresenceAlertRead)
async def confirm_alert(
    alert_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> PresenceAlertRead:
    try:
        return to_read(await build_service(db).confirm(actor_id, alert_id, utcnow()))
    except PresenceNotFound as error:
        raise map_error(error) from None


@router.post("/alerts/{alert_id}/cancel", response_model=PresenceAlertRead)
async def cancel_alert(
    alert_id: UUID,
    payload: PresenceAlertCancel | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> PresenceAlertRead:
    reason = payload.reason if payload else "RETURNED"
    try:
        return to_read(await build_service(db).cancel(actor_id, alert_id, reason))
    except PresenceNotFound as error:
        raise map_error(error) from None
