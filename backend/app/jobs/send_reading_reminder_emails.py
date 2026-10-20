"""One-shot email-reminder worker. Launch it with an external scheduler."""
from __future__ import annotations

import asyncio
import logging
from uuid import uuid4

from app.database.session import AsyncSessionLocal, engine
from app.repositories.reading_reminder_email_repository import ReadingReminderEmailRepository
from app.services.reading_reminder_email_service import (
    ReadingReminderEmailConfigurationError,
    ReadingReminderEmailService,
)

logger = logging.getLogger("viread.reading_reminder_email_worker")


async def run() -> int:
    job_id = uuid4().hex
    logger.info("reading_reminder_email_job_started job_id=%s", job_id)
    try:
        async with AsyncSessionLocal() as session:
            service = ReadingReminderEmailService(ReadingReminderEmailRepository(session))
            stats = await service.run_once()
        logger.info(
            "reading_reminder_email_job_completed job_id=%s reminders_checked=%s "
            "occurrences_created=%s deliveries_created=%s provider_accepted=%s "
            "skipped=%s failed=%s retried=%s stale_claims_recovered=%s",
            job_id, stats["reminders_checked"], stats["occurrences_created"],
            stats["deliveries_created"], stats["provider_accepted"], stats["skipped"],
            stats["failed"], stats["retried"], stats["stale_claims_recovered"],
        )
        return 0
    except ReadingReminderEmailConfigurationError as error:
        # The message is a fixed, normalized error code and contains no secret or recipient data.
        logger.error("reading_reminder_email_job_failed job_id=%s error_code=%s",
                     job_id, str(error))
        return 1
    except Exception as error:
        # Avoid exception text because provider or database errors can contain sensitive values.
        logger.error("reading_reminder_email_job_failed job_id=%s exception_type=%s",
                     job_id, type(error).__name__)
        return 1
    finally:
        await engine.dispose()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    raise SystemExit(asyncio.run(run()))


if __name__ == "__main__":
    main()
