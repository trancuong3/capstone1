from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from app.database.config import (
    READING_REMINDER_MAX_ATTEMPTS,
    READING_REMINDER_POLL_SECONDS,
    SUPABASE_ADMIN_KEY,
)
from app.database.session import AsyncSessionLocal, engine
from app.diagnostic_logging import log_diagnostic
from app.models import ChildProfile
from app.models.reading_management import ReadingReminder, ReadingReminderOccurrence
from app.providers.reading_reminder_email_provider import (
    EmailDeliveryNotConfigured,
    email_delivery_is_configured,
    send_reading_reminder_email,
)
from app.providers.supabase_auth_contact_provider import SupabaseAuthContactProvider
from app.repositories.reading_management_repository import ReadingManagementRepository

logger = logging.getLogger(__name__)


class ParentEmailUnavailable(Exception):
    def __init__(self, code: str = "PARENT_EMAIL_UNVERIFIED") -> None:
        self.code = code
        super().__init__(code)


class ParentEmailLookupFailed(Exception):
    """Raised when the contact provider is temporarily unavailable."""


async def get_verified_parent_email(parent_id: UUID) -> str:
    contact = await SupabaseAuthContactProvider().get_contact_info(parent_id)
    contact_status = contact.get("contact_info_status")
    if contact_status == "lookup_failed":
        raise ParentEmailLookupFailed()
    email = contact.get("email")
    if (
        contact_status != "available"
        or contact.get("email_verified") is not True
        or not isinstance(email, str)
        or not email.strip()
    ):
        raise ParentEmailUnavailable()
    return email.strip()


async def deliver_claimed_occurrences(
    repository: ReadingManagementRepository,
    claims: list[tuple[ReadingReminderOccurrence, ReadingReminder, ChildProfile]],
    now: datetime,
    *,
    recipient_resolver=get_verified_parent_email,
    email_sender=send_reading_reminder_email,
    max_attempts: int = READING_REMINDER_MAX_ATTEMPTS,
) -> int:
    delivered = 0
    for occurrence, reminder, child in claims:
        try:
            recipient = await recipient_resolver(child.ParentId)
            await asyncio.to_thread(
                email_sender,
                recipient=recipient,
                child_alias=child.Alias,
                local_date=occurrence.ScheduledLocalDate.isoformat(),
                local_time=reminder.RemindAt.strftime("%H:%M"),
                timezone_name=reminder.Timezone,
                occurrence_id=occurrence.Id,
            )
        except ParentEmailUnavailable as error:
            await repository.update_email_delivery(
                occurrence.Id,
                status="FAILED",
                now=now,
                error_code=error.code,
            )
        except EmailDeliveryNotConfigured:
            await repository.update_email_delivery(
                occurrence.Id,
                status="FAILED",
                now=now,
                error_code="EMAIL_NOT_CONFIGURED",
            )
        except ParentEmailLookupFailed as error:
            attempts = occurrence.EmailAttempts
            terminal = attempts >= max_attempts
            delay_minutes = min(60, 2 ** max(0, attempts - 1))
            await repository.update_email_delivery(
                occurrence.Id,
                status="FAILED" if terminal else "RETRY",
                now=now,
                error_code="PARENT_EMAIL_LOOKUP_FAILED",
                next_attempt_at=None if terminal else now + timedelta(minutes=delay_minutes),
            )
            log_diagnostic(
                logger,
                logging.WARNING,
                event="reading_reminder_parent_lookup_failed",
                stage="parent_email_lookup",
                exception=error,
                attempt=attempts,
                terminal=terminal,
            )
        except Exception as error:
            attempts = occurrence.EmailAttempts
            terminal = attempts >= max_attempts
            delay_minutes = min(60, 2 ** max(0, attempts - 1))
            await repository.update_email_delivery(
                occurrence.Id,
                status="FAILED" if terminal else "RETRY",
                now=now,
                error_code="SMTP_UNAVAILABLE",
                next_attempt_at=None if terminal else now + timedelta(minutes=delay_minutes),
            )
            log_diagnostic(
                logger,
                logging.WARNING,
                event="reading_reminder_email_failed",
                stage="email_delivery",
                exception=error,
                attempt=attempts,
                terminal=terminal,
            )
        else:
            await repository.update_email_delivery(
                occurrence.Id,
                status="SENT",
                now=now,
            )
            delivered += 1
    return delivered


async def process_due_reminders_once(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        repository = ReadingManagementRepository(session)
        await repository.create_due_occurrences_for_worker(now)
        claims = await repository.claim_due_email_occurrences(
            now, max_attempts=READING_REMINDER_MAX_ATTEMPTS
        )
        return await deliver_claimed_occurrences(repository, claims, now)


def validate_worker_configuration() -> None:
    if not email_delivery_is_configured():
        raise EmailDeliveryNotConfigured(
            "Set SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_APP_PASSWORD, and SMTP_FROM_EMAIL."
        )
    if not SUPABASE_ADMIN_KEY:
        raise RuntimeError("Set a server-only Supabase Admin API key for verified parent email lookup.")


async def run_worker() -> None:
    validate_worker_configuration()
    try:
        while True:
            try:
                await process_due_reminders_once()
            except Exception as error:
                log_diagnostic(
                    logger,
                    logging.ERROR,
                    event="reading_reminder_worker_iteration_failed",
                    stage="scheduler",
                    exception=error,
                )
            await asyncio.sleep(READING_REMINDER_POLL_SECONDS)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(run_worker())
