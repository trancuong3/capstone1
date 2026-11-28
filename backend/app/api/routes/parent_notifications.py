"""Parent email notification preferences, history, test delivery, and cron dispatch."""

from __future__ import annotations

import hmac
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_parent_id
from app.database import config as settings
from app.jobs.parent_email_dispatcher_worker import dispatch_all_once
from app.repositories.parent_email_notification_repository import (
    ParentEmailNotificationRepository,
)
from app.schemas.parent_email_notification import (
    CronDispatchScope,
    ParentEmailCronDispatchResponse,
    ParentEmailDeliveryRead,
    ParentEmailPreferencesRead,
    ParentEmailPreferencesUpdate,
    ParentEmailTestResponse,
)
from app.services.parent_email_notification_service import (
    ParentEmailNotificationService,
    ParentNotificationError,
)

router = APIRouter()


def build_service(db: AsyncSession) -> ParentEmailNotificationService:
    return ParentEmailNotificationService(ParentEmailNotificationRepository(db))


def _verify_cron_secret(
    x_cron_secret: str | None,
    authorization: str | None,
) -> None:
    expected = settings.PARENT_EMAIL_CRON_SECRET
    if not expected or len(expected) < 16:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cron dispatch secret is not configured",
        )
    candidate = (x_cron_secret or "").strip()
    if not candidate and authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer":
            candidate = token.strip()
    if not candidate or not hmac.compare_digest(candidate, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid cron credentials",
        )


@router.get("/preferences", response_model=ParentEmailPreferencesRead)
async def get_preferences(
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> ParentEmailPreferencesRead:
    return await build_service(db).get_preferences(actor_id)


@router.put("/preferences", response_model=ParentEmailPreferencesRead)
async def update_preferences(
    payload: ParentEmailPreferencesUpdate,
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> ParentEmailPreferencesRead:
    try:
        return await build_service(db).update_preferences(actor_id, payload)
    except ParentNotificationError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": error.message},
        ) from None


@router.get("/history", response_model=list[ParentEmailDeliveryRead])
async def get_history(
    limit: int = Query(default=10, ge=1, le=50),
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> list[ParentEmailDeliveryRead]:
    effective_limit = limit if isinstance(limit, int) else 10
    return await build_service(db).list_history(actor_id, limit=effective_limit)


@router.post("/test-email", response_model=ParentEmailTestResponse)
async def send_test_email(
    actor_id: UUID = Depends(require_parent_id),
    db: AsyncSession = Depends(get_db),
) -> ParentEmailTestResponse:
    try:
        return await build_service(db).send_test_email(actor_id)
    except ParentNotificationError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": error.message},
        ) from None


@router.post("/cron/dispatch", response_model=ParentEmailCronDispatchResponse)
async def trigger_cron_dispatch(
    scope: CronDispatchScope = Query(default="all"),
    x_cron_secret: str | None = Header(default=None, alias="X-Cron-Secret"),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> ParentEmailCronDispatchResponse:
    """Server-to-server scheduled dispatch endpoint for Vercel Cron / GitHub Actions."""
    effective_scope = scope if isinstance(scope, str) else "all"
    effective_secret = x_cron_secret if isinstance(x_cron_secret, str) else None
    effective_auth = authorization if isinstance(authorization, str) else None
    _verify_cron_secret(effective_secret, effective_auth)
    summary = await dispatch_all_once(scope=effective_scope)
    return ParentEmailCronDispatchResponse(**summary)
