from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from app.database.config import READING_PRESENCE_POLL_SECONDS, SUPABASE_ADMIN_KEY
from app.database.session import AsyncSessionLocal, engine
from app.diagnostic_logging import log_diagnostic
from app.jobs.reading_reminder_worker import (
    ParentEmailLookupFailed,
    ParentEmailUnavailable,
    get_verified_parent_email,
)
from app.providers.reading_presence_email_provider import send_presence_email
from app.repositories.reading_presence_repository import ReadingPresenceRepository
from app.services.reading_presence_service import ReadingPresenceService

logger = logging.getLogger(__name__)


async def process_due_alerts_once(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        service = ReadingPresenceService(ReadingPresenceRepository(session))
        return await service.deliver_due(
            now,
            recipient_resolver=get_verified_parent_email,
            email_sender=send_presence_email,
            parent_email_unavailable=ParentEmailUnavailable,
            parent_lookup_failed=ParentEmailLookupFailed,
        )


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


async def run_worker() -> None:
    validate_worker_configuration()
    try:
        while True:
            try:
                await process_due_alerts_once()
            except Exception as error:
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


if __name__ == "__main__":
    asyncio.run(run_worker())
