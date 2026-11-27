from __future__ import annotations

import argparse
import asyncio
import functools
import inspect
import logging
import os
import signal
from datetime import datetime, timezone
from typing import Any

from app.database.config import READING_PRESENCE_POLL_SECONDS, SUPABASE_ADMIN_KEY
from app.database.session import AsyncSessionLocal, engine
from app.diagnostic_logging import log_diagnostic
from app.jobs.reading_reminder_worker import (
    ParentEmailLookupFailed,
    ParentEmailUnavailable,
    _advisory_lock_guard,
    get_verified_parent_email,
)
from app.providers.reading_presence_email_provider import send_presence_email
from app.repositories.reading_presence_repository import ReadingPresenceRepository
from app.services.i18n.locales import DEFAULT_LOCALE, resolve_supported_locale
from app.services.reading_presence_service import ReadingPresenceService
from app.services.worker_telemetry import (
    persist_worker_heartbeat_with_factory,
    record_worker_error,
    record_worker_success,
)

logger = logging.getLogger(__name__)
READING_PRESENCE_ADVISORY_LOCK_KEY = 4201002
DEFAULT_PRESENCE_CLAIM_LIMIT = 5
_WORKER_KEY = "reading_presence"


def _sender_for_locale(locale: str | None):
    resolved = resolve_supported_locale(locale)
    if resolved == DEFAULT_LOCALE:
        return send_presence_email
    try:
        sig = inspect.signature(send_presence_email)
        accepts_locale = any(
            p.kind == inspect.Parameter.VAR_KEYWORD or p.name == "locale"
            for p in sig.parameters.values()
        )
    except (TypeError, ValueError):
        accepts_locale = False
    if not accepts_locale:
        return send_presence_email
    return functools.partial(send_presence_email, locale=resolved)


async def process_due_alerts_once(
    now: datetime | None = None,
    *,
    locale: str = DEFAULT_LOCALE,
    limit: int = DEFAULT_PRESENCE_CLAIM_LIMIT,
) -> int:
    now = now or datetime.now(timezone.utc)
    try:
        async with AsyncSessionLocal() as session:
            service = ReadingPresenceService(ReadingPresenceRepository(session))
            delivered = await service.deliver_due(
                now,
                recipient_resolver=get_verified_parent_email,
                email_sender=_sender_for_locale(locale),
                parent_email_unavailable=ParentEmailUnavailable,
                parent_lookup_failed=ParentEmailLookupFailed,
                batch=max(1, int(limit)),
            )
        record_worker_success(_WORKER_KEY)
        return delivered
    except asyncio.CancelledError:
        raise
    except Exception as error:
        record_worker_error(_WORKER_KEY, error)
        raise


_EVENT_PRESENCE_TASKS: set[asyncio.Task[Any]] = set()
_EVENT_PRESENCE_SEMAPHORES: dict[int, asyncio.Semaphore] = {}


def _event_presence_semaphore() -> asyncio.Semaphore:
    loop_id = id(asyncio.get_running_loop())
    sem = _EVENT_PRESENCE_SEMAPHORES.get(loop_id)
    if sem is None:
        sem = asyncio.Semaphore(1)
        _EVENT_PRESENCE_SEMAPHORES[loop_id] = sem
    return sem


async def _run_scheduled_presence_delivery(*, now: datetime | None = None) -> int:
    await asyncio.sleep(0)
    sem = _event_presence_semaphore()
    async with sem:
        try:
            delivered = int(await process_due_alerts_once(now=now))
            await persist_worker_heartbeat_with_factory(
                AsyncSessionLocal,
                _WORKER_KEY,
                execution_mode="on_demand",
                ok=True,
                items_processed=delivered,
                source="presence_confirm",
                timeout_seconds=5.0,
            )
            return delivered
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            record_worker_error(_WORKER_KEY, exc)
            await persist_worker_heartbeat_with_factory(
                AsyncSessionLocal,
                _WORKER_KEY,
                execution_mode="on_demand",
                ok=False,
                items_processed=0,
                source="presence_confirm",
                error_code=type(exc).__name__,
                timeout_seconds=5.0,
            )
            log_diagnostic(
                logger,
                logging.WARNING,
                event="reading_presence_event_delivery_failed",
                stage="event_trigger",
                exception=exc,
            )
            return 0


def schedule_reading_presence_delivery(
    *,
    now: datetime | None = None,
    force: bool = False,
) -> asyncio.Task[Any] | None:
    """Single-flight bounded event-driven trigger for due presence alerts."""
    from app.database.config import APP_ENVIRONMENT

    if not force:
        app_env = (os.getenv("APP_ENVIRONMENT") or APP_ENVIRONMENT or "").strip().lower()
        if app_env == "test":
            return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    active_tasks = [t for t in list(_EVENT_PRESENCE_TASKS) if not t.done()]
    if active_tasks:
        return active_tasks[0]
    task = loop.create_task(
        _run_scheduled_presence_delivery(now=now),
        name="reading_presence_event_delivery",
    )
    _EVENT_PRESENCE_TASKS.add(task)
    task.add_done_callback(_EVENT_PRESENCE_TASKS.discard)
    return task


async def shutdown_scheduled_presence_tasks(*, timeout_seconds: float = 5.0) -> None:
    if not _EVENT_PRESENCE_TASKS:
        return
    pending = [task for task in list(_EVENT_PRESENCE_TASKS) if not task.done()]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=timeout_seconds)


def validate_worker_configuration() -> None:
    from app.database.config import READING_PRESENCE_MAIL_SINK_DIR
    from app.providers.reading_reminder_email_provider import (
        EmailDeliveryNotConfigured,
        email_delivery_is_configured,
    )

    if not READING_PRESENCE_MAIL_SINK_DIR and not email_delivery_is_configured():
        raise EmailDeliveryNotConfigured(
            "Set SMTP_* (or READING_PRESENCE_MAIL_SINK_DIR for a local mail sink)."
        )
    if not SUPABASE_ADMIN_KEY:
        raise RuntimeError(
            "Set a server-only Supabase Admin API key for verified parent email lookup."
        )


async def run_worker(
    *, once: bool = False, stop_event: asyncio.Event | None = None
) -> int:
    validate_worker_configuration()
    effective_stop = stop_event if stop_event is not None else asyncio.Event()
    if stop_event is None:
        try:
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, effective_stop.set)
        except (NotImplementedError, RuntimeError, ValueError):
            pass
    try:
        if once:
            if effective_stop.is_set():
                return 0
            return await process_due_alerts_once()
        while not effective_stop.is_set():
            try:
                await process_due_alerts_once()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                record_worker_error(_WORKER_KEY, error)
                log_diagnostic(
                    logger,
                    logging.ERROR,
                    event="reading_presence_worker_iteration_failed",
                    stage="scheduler",
                    exception=error,
                )
            if effective_stop.is_set():
                break
            try:
                await asyncio.wait_for(
                    effective_stop.wait(),
                    timeout=READING_PRESENCE_POLL_SECONDS,
                )
                break
            except TimeoutError:
                pass
        return 0
    finally:
        await engine.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description="ViRead reading presence alert worker.")
    parser.add_argument("--once", action="store_true", help="Run one idempotent sweep and exit.")
    args = parser.parse_args()
    asyncio.run(run_worker(once=args.once))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
