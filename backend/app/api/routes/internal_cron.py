"""Internal cardless cron dispatch endpoint for reading reminders and presence alerts."""
from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.jobs.reading_presence_alert_worker import process_due_alerts_once
from app.jobs.reading_reminder_worker import process_due_reminders_once

router = APIRouter()


def require_cron_dispatch_token(
    x_viread_cron_token: str | None = Header(
        default=None, alias="X-ViRead-Cron-Token"
    ),
) -> str:
    """Verify the shared cron token in constant time without ever logging it."""
    expected = (os.getenv("VIREAD_CRON_DISPATCH_TOKEN") or "").strip()
    if len(expected) < 32:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cron dispatch token is not configured on backend.",
        )
    provided = (x_viread_cron_token or "").strip()
    if not provided:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-ViRead-Cron-Token header.",
        )
    expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    provided_digest = hashlib.sha256(provided.encode("utf-8")).digest()
    if not hmac.compare_digest(expected_digest, provided_digest):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid cron dispatch token.",
        )
    return "cron_dispatch"


@router.post("/dispatch")
async def dispatch_scheduled_cron(
    _: str = Depends(require_cron_dispatch_token),
) -> dict[str, Any]:
    """Run one idempotent sweep of due reading reminders and reading presence alerts."""
    now = datetime.now(timezone.utc)
    reminders_delivered = await process_due_reminders_once(now=now)
    presence_alerts_delivered = await process_due_alerts_once(now=now)
    return {
        "ok": True,
        "dispatched_at": now.isoformat(),
        "reminders_delivered": int(reminders_delivered),
        "presence_alerts_delivered": int(presence_alerts_delivered),
    }
