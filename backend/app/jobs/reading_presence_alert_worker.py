from __future__ import annotations

import argparse
import asyncio
import functools
import inspect
import logging
from datetime import datetime, timezone

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
from app.services.worker_telemetry import record_worker_error, record_worker_success

logger = logging.getLogger(__name__)
READING_PRESENCE_ADVISORY_LOCK_KEY = 4201002
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
) -> int:
    now = now or datetime.now(timezone.utc)
    async with _advisory_lock_guard(READING_PRESENCE_ADVISORY_LOCK_KEY) as acquired:
        if not acquired:
            logger.info("reading_presence_skipped_lock_held")
            return 0
        async with AsyncSessionLocal() as session:
            service = ReadingPresenceService(ReadingPresenceRepository(session))
            delivered = await service.deliver_due(
                now,
                recipient_resolver=get_verified_parent_email,
                email_sender=_sender_for_locale(locale),
                parent_email_unavailable=ParentEmailUnavailable,
                parent_lookup_failed=ParentEmailLookupFailed,
            )
        record_worker_success(_WORKER_KEY)
        return delivered


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


async def run_worker(*, once: bool = False) -> int:
    validate_worker_configuration()
    try:
        if once:
            return await process_due_alerts_once()
        while True:
            try:
                await process_due_alerts_once()
            except Exception as error:
                record_worker_error(_WORKER_KEY, error)
                log_diagnostic(
                    logger,
                    logging.ERROR,
                    event="reading_presence_worker_iteration_failed",
                    stage="scheduler",
                    exception=error,
                )
            await asyncio.sleep(READING_PRESENCE_POLL_SECONDS)
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
