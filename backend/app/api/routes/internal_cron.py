"""Internal cardless cron dispatch endpoint for reading reminders and presence alerts."""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.jobs import parent_book_submission_worker
from app.jobs.reading_presence_alert_worker import process_due_alerts_once
from app.jobs.reading_reminder_worker import process_due_reminders_once
from app.services.cron_dispatch_service import run_scheduled_cron_dispatch
from app.services.ocr_inference_job_service import (
    is_heavy_workers_disabled,
    is_remote_ocr_mode,
)

logger = logging.getLogger(__name__)
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
    """Run one bounded idempotent sweep of reminders, alerts, lease reaping, and lightweight workers."""
    now = datetime.now(timezone.utc)
    return await run_scheduled_cron_dispatch(
        now=now,
        run_remote_sweeps=bool(is_remote_ocr_mode() or is_heavy_workers_disabled()),
        reminders_runner=process_due_reminders_once,
        alerts_runner=process_due_alerts_once,
        temp_cleanup_runner=parent_book_submission_worker.cleanup_expired_temp_submissions,
        parent_post_ocr_runner=parent_book_submission_worker.run_once,
    )
