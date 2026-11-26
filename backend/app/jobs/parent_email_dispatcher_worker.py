"""Unified background worker & on-demand dispatcher for ALL ViRead parent emails.

Orchestrates:
1. Real-time reading presence alerts (``reading_presence_alert_worker``) — every ~10s
2. Scheduled reading reminders (``reading_reminder_worker``) — every ~30s
3. Engagement digests, long-inactivity nudges, and milestone celebrations — every ~15m

Safe to run inside FastAPI lifespan AND concurrently with external cron triggers
(Vercel Cron / GitHub Actions): every delivery path uses PostgreSQL atomic
claiming (``FOR UPDATE SKIP LOCKED`` or unique ``dedupekey``) so duplicates are
never sent.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import time
from datetime import datetime, timezone

from app.database import config as settings
from app.database.session import AsyncSessionLocal, engine
from app.diagnostic_logging import log_diagnostic
from app.jobs.reading_presence_alert_worker import process_due_alerts_once
from app.jobs.reading_reminder_worker import process_due_reminders_once
from app.providers.parent_email_transport import (
    active_email_provider,
    parent_email_automation_readiness,
)
from app.repositories.parent_email_notification_repository import (
    ParentEmailNotificationRepository,
)
from app.services.parent_email_notification_service import (
    ParentEmailNotificationService,
)

logger = logging.getLogger(__name__)


def _worker_ready() -> tuple[bool, str]:
    ready, provider, reason = parent_email_automation_readiness()
    return ready, provider if ready else reason


async def process_engagement_emails_once(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        service = ParentEmailNotificationService(
            ParentEmailNotificationRepository(session)
        )
        return await service.dispatch_engagement_emails(now)


async def dispatch_all_once(
    now: datetime | None = None,
    *,
    scope: str = "all",
) -> dict[str, object]:
    now = now or datetime.now(timezone.utc)
    ready, provider_or_reason = _worker_ready()
    provider = active_email_provider()
    result: dict[str, object] = {
        "scope": scope,
        "delivery_configured": ready,
        "delivery_provider": provider,
        "presence_sent": 0,
        "reminders_sent": 0,
        "engagement_sent": 0,
        "checked_at": now,
    }
    if not ready:
        log_diagnostic(
            logger,
            logging.INFO,
            event="parent_email_dispatch_skipped_unconfigured",
            stage="dispatcher",
            error_code=provider_or_reason,
            scope=scope,
        )
        return result

    if scope in ("all", "presence"):
        try:
            result["presence_sent"] = await process_due_alerts_once(now)
        except Exception as error:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_email_presence_dispatch_failed",
                stage="presence_dispatch",
                exception=error,
            )

    if scope in ("all", "reminders"):
        try:
            result["reminders_sent"] = await process_due_reminders_once(now)
        except Exception as error:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_email_reminders_dispatch_failed",
                stage="reminders_dispatch",
                exception=error,
            )

    if scope in ("all", "engagement"):
        try:
            result["engagement_sent"] = await process_engagement_emails_once(now)
        except Exception as error:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_email_engagement_dispatch_failed",
                stage="engagement_dispatch",
                exception=error,
            )

    return result


async def run_worker(stop_event: asyncio.Event) -> None:
    """In-process FastAPI lifespan worker with clean shutdown and self-gating."""
    logged_unconfigured = False
    last_presence = 0.0
    last_reminders = 0.0
    last_engagement = 0.0

    while not stop_event.is_set():
        ready, reason = _worker_ready()
        if not ready:
            if not logged_unconfigured:
                logged_unconfigured = True
                log_diagnostic(
                    logger,
                    logging.INFO,
                    event="parent_email_worker_dormant",
                    stage="scheduler",
                    error_code=reason,
                )
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=60.0)
            except TimeoutError:
                pass
            continue

        logged_unconfigured = False
        mono = time.monotonic()
        now = datetime.now(timezone.utc)

        if mono - last_presence >= settings.READING_PRESENCE_POLL_SECONDS:
            last_presence = mono
            try:
                await process_due_alerts_once(now)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="parent_email_presence_loop_failed",
                    stage="presence_dispatch",
                    exception=error,
                )

        if mono - last_reminders >= settings.READING_REMINDER_POLL_SECONDS:
            last_reminders = mono
            try:
                await process_due_reminders_once(now)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="parent_email_reminders_loop_failed",
                    stage="reminders_dispatch",
                    exception=error,
                )

        if mono - last_engagement >= settings.PARENT_EMAIL_DIGEST_POLL_SECONDS:
            last_engagement = mono
            try:
                await process_engagement_emails_once(now)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="parent_email_engagement_loop_failed",
                    stage="engagement_dispatch",
                    exception=error,
                )

        sleep_seconds = min(
            float(settings.READING_PRESENCE_POLL_SECONDS),
            float(settings.READING_REMINDER_POLL_SECONDS),
            10.0,
        )
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=max(2.0, sleep_seconds))
        except TimeoutError:
            pass


async def _run_cli(once: bool, scope: str) -> None:
    try:
        if once:
            await dispatch_all_once(scope=scope)
        else:
            await run_worker(asyncio.Event())
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="ViRead unified parent email dispatcher worker."
    )
    parser.add_argument(
        "--once", action="store_true", help="Run a single dispatch pass and exit."
    )
    parser.add_argument(
        "--scope",
        choices=("all", "reminders", "presence", "engagement"),
        default="all",
    )
    args = parser.parse_args()
    asyncio.run(_run_cli(args.once, args.scope))
