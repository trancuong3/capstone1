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
import inspect
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
from app.services.worker_telemetry import (
    persist_worker_heartbeats_batch_with_factory,
    record_worker_error,
    record_worker_success,
)

logger = logging.getLogger(__name__)
_WORKER_KEY = "parent_email_dispatcher"
DEFAULT_ENGAGEMENT_MAX_EMAILS = 5
DEFAULT_ENGAGEMENT_MAX_SECONDS = 10.0
DISPATCH_TOTAL_BUDGET_SECONDS = 28.0
HEARTBEAT_PERSIST_RESERVE_SECONDS = 4.0
DISPATCH_SUBTASK_TIMEOUT_SECONDS = 24.0


def _accepts_kwarg(fn: object, name: str) -> bool:
    try:
        sig = inspect.signature(fn)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    if name in sig.parameters:
        return True
    return any(
        param.kind == inspect.Parameter.VAR_KEYWORD
        for param in sig.parameters.values()
    )


def _worker_ready() -> tuple[bool, str]:
    ready, provider, reason = parent_email_automation_readiness()
    return ready, provider if ready else reason


async def process_engagement_emails_once(
    now: datetime | None = None,
    *,
    max_emails: int | None = DEFAULT_ENGAGEMENT_MAX_EMAILS,
    max_seconds: float | None = DEFAULT_ENGAGEMENT_MAX_SECONDS,
) -> int:
    now = now or datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        service = ParentEmailNotificationService(
            ParentEmailNotificationRepository(session)
        )
        return await service.dispatch_engagement_emails(
            now,
            max_emails=max_emails,
            max_seconds=max_seconds,
        )


async def dispatch_all_once(
    now: datetime | None = None,
    *,
    scope: str = "all",
    source: str = "cron",
    execution_mode: str = "cron_scheduled",
    dry_run: bool = False,
    total_budget_seconds: float = DISPATCH_TOTAL_BUDGET_SECONDS,
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
        "dry_run": bool(dry_run),
    }
    if dry_run:
        log_diagnostic(
            logger,
            logging.INFO,
            event="parent_email_dispatch_dry_run",
            stage="dispatcher",
            scope=scope,
            delivery_configured=ready,
            delivery_provider=provider,
        )
        return result
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

    total_budget = max(0.1, float(total_budget_seconds))
    heartbeat_reserve = min(HEARTBEAT_PERSIST_RESERVE_SECONDS, total_budget * 0.2)
    work_deadline = time.monotonic() + max(0.05, total_budget - heartbeat_reserve)
    min_step_budget = 0.25 if total_budget >= 2.0 else 0.02

    def _remaining_work_timeout() -> float:
        return max(0.0, min(DISPATCH_SUBTASK_TIMEOUT_SECONDS, work_deadline - time.monotonic()))

    pending_heartbeats: list[dict[str, object]] = []
    presence_error: BaseException | None = None
    reminders_error: BaseException | None = None
    engagement_error: BaseException | None = None
    engagement_executed = False

    if scope in ("all", "presence"):
        step_timeout = _remaining_work_timeout()
        if step_timeout > min_step_budget:
            try:
                presence_sent = int(
                    await asyncio.wait_for(
                        process_due_alerts_once(now),
                        timeout=step_timeout,
                    )
                )
                result["presence_sent"] = presence_sent
                record_worker_success("reading_presence")
                pending_heartbeats.append(
                    {
                        "worker_id": "reading_presence",
                        "execution_mode": execution_mode,
                        "ok": True,
                        "items_processed": presence_sent,
                        "source": source,
                    }
                )
            except Exception as error:
                presence_error = error
                record_worker_error("reading_presence", error)
                pending_heartbeats.append(
                    {
                        "worker_id": "reading_presence",
                        "execution_mode": execution_mode,
                        "ok": False,
                        "items_processed": 0,
                        "source": source,
                        "error_code": type(error).__name__,
                    }
                )
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="parent_email_presence_dispatch_failed",
                    stage="presence_dispatch",
                    exception=error,
                )

    if scope in ("all", "reminders"):
        step_timeout = _remaining_work_timeout()
        if step_timeout > min_step_budget:
            try:
                reminders_sent = int(
                    await asyncio.wait_for(
                        process_due_reminders_once(now),
                        timeout=step_timeout,
                    )
                )
                result["reminders_sent"] = reminders_sent
                record_worker_success("reading_reminder")
                pending_heartbeats.append(
                    {
                        "worker_id": "reading_reminder",
                        "execution_mode": execution_mode,
                        "ok": True,
                        "items_processed": reminders_sent,
                        "source": source,
                    }
                )
            except Exception as error:
                reminders_error = error
                record_worker_error("reading_reminder", error)
                pending_heartbeats.append(
                    {
                        "worker_id": "reading_reminder",
                        "execution_mode": execution_mode,
                        "ok": False,
                        "items_processed": 0,
                        "source": source,
                        "error_code": type(error).__name__,
                    }
                )
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="parent_email_reminders_dispatch_failed",
                    stage="reminders_dispatch",
                    exception=error,
                )

    if scope in ("all", "engagement"):
        step_timeout = _remaining_work_timeout()
        if step_timeout > min_step_budget:
            engagement_executed = True
            try:
                engagement_kwargs: dict[str, object] = {}
                if _accepts_kwarg(process_engagement_emails_once, "max_seconds"):
                    engagement_kwargs["max_seconds"] = min(
                        DEFAULT_ENGAGEMENT_MAX_SECONDS,
                        max(0.1, step_timeout - 0.5) if step_timeout >= 1.0 else step_timeout,
                    )
                engagement_sent = int(
                    await asyncio.wait_for(
                        process_engagement_emails_once(now, **engagement_kwargs),  # type: ignore[arg-type]
                        timeout=step_timeout,
                    )
                )
                result["engagement_sent"] = engagement_sent
            except Exception as error:
                engagement_error = error
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="parent_email_engagement_dispatch_failed",
                    stage="engagement_dispatch",
                    exception=error,
                )

    dispatcher_error = (
        engagement_error
        if (scope in ("all", "engagement") and engagement_executed)
        else (presence_error or reminders_error)
    )
    if scope == "all" and not engagement_executed and dispatcher_error is None:
        dispatcher_error = presence_error or reminders_error
    total_sent = (
        int(result["presence_sent"])  # type: ignore[arg-type]
        + int(result["reminders_sent"])  # type: ignore[arg-type]
        + int(result["engagement_sent"])  # type: ignore[arg-type]
    )
    if dispatcher_error is None:
        record_worker_success(_WORKER_KEY)
        pending_heartbeats.append(
            {
                "worker_id": _WORKER_KEY,
                "execution_mode": execution_mode,
                "ok": True,
                "items_processed": total_sent,
                "source": source,
            }
        )
    else:
        record_worker_error(_WORKER_KEY, dispatcher_error)
        pending_heartbeats.append(
            {
                "worker_id": _WORKER_KEY,
                "execution_mode": execution_mode,
                "ok": False,
                "items_processed": 0,
                "source": source,
                "error_code": type(dispatcher_error).__name__,
            }
        )

    await persist_worker_heartbeats_batch_with_factory(
        AsyncSessionLocal,
        pending_heartbeats,
        timeout_seconds=min(HEARTBEAT_PERSIST_RESERVE_SECONDS, max(1.0, heartbeat_reserve)),
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
                record_worker_success(_WORKER_KEY)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                record_worker_error(_WORKER_KEY, error)
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
