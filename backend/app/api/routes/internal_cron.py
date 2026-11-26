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
    """Run one idempotent sweep of due reading reminders, presence alerts, and remote post-OCR recovery."""
    now = datetime.now(timezone.utc)
    reminders_delivered = await process_due_reminders_once(now=now)
    presence_alerts_delivered = await process_due_alerts_once(now=now)

    temp_submissions_cleaned = 0
    post_ocr_swept = 0
    if is_remote_ocr_mode() or is_heavy_workers_disabled():
        try:
            temp_submissions_cleaned = int(
                await parent_book_submission_worker.cleanup_expired_temp_submissions(
                    now=now, limit=50
                )
            )
        except Exception as exc:
            logger.warning("cron_temp_cleanup_skipped error=%s", type(exc).__name__)
        try:
            for _ in range(5):
                did_work = await parent_book_submission_worker.run_once(
                    worker_id="cron-post-ocr-sweeper"
                )
                if not did_work:
                    break
                post_ocr_swept += 1
        except Exception as exc:
            logger.warning("cron_post_ocr_sweep_skipped error=%s", type(exc).__name__)

    return {
        "ok": True,
        "dispatched_at": now.isoformat(),
        "reminders_delivered": int(reminders_delivered),
        "presence_alerts_delivered": int(presence_alerts_delivered),
        "temp_submissions_cleaned": temp_submissions_cleaned,
        "post_ocr_swept": post_ocr_swept,
    }
