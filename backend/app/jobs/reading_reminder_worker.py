from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager
import inspect
import logging
import signal
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import text

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
from app.services.worker_telemetry import record_worker_error, record_worker_success

logger = logging.getLogger(__name__)
READING_REMINDER_ADVISORY_LOCK_KEY = 4201001
_WORKER_KEY = "reading_reminder"


class ParentEmailUnavailable(Exception):
    def __init__(self, code: str = "PARENT_EMAIL_UNVERIFIED") -> None:
        self.code = code
        super().__init__(code)


class ParentEmailLookupFailed(Exception):
    """Raised when the contact provider is temporarily unavailable."""


@asynccontextmanager
async def _advisory_lock_guard(lock_key: int):
    """Acquire a PostgreSQL session advisory lock so overlapping cron/worker ticks never race."""
    try:
        async with AsyncSessionLocal() as lock_session:
            dialect = getattr(getattr(lock_session, "bind", None), "dialect", None)
            dialect_name = getattr(dialect, "name", None)
            if dialect_name and dialect_name != "postgresql":
                yield True
                return
            result = await lock_session.execute(
                text("SELECT pg_try_advisory_lock(:key)"),
                {"key": lock_key},
            )
            acquired = bool(result.scalar())
            if not acquired:
                yield False
                return
            try:
                yield True
            finally:
                try:
                    await lock_session.execute(
                        text("SELECT pg_advisory_unlock(:key)"),
                        {"key": lock_key},
                    )
                except Exception:
                    pass
    except Exception:
        # In unit tests where AsyncSessionLocal is patched/unbacked by Postgres,
        # let callers test process_due_* directly without failing on advisory lock.
        if getattr(AsyncSessionLocal, "__name__", "") != "sessionmaker" and not hasattr(
            AsyncSessionLocal, "kw"
        ):
            yield True
            return
        raise


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


async def _release_repository_db(repository: object) -> None:
    """Release any open DB read transaction before external HTTP/SMTP calls."""
    db = getattr(repository, "db", None)
    rollback = getattr(db, "rollback", None)
    if callable(rollback):
        res = rollback()
        if inspect.isawaitable(res):
            await res


async def deliver_claimed_occurrences(
    repository: ReadingManagementRepository,
    claims: list[tuple[ReadingReminderOccurrence, ReadingReminder, ChildProfile]],
    now: datetime,
    *,
    recipient_resolver=get_verified_parent_email,
    email_sender=send_reading_reminder_email,
    max_attempts: int = READING_REMINDER_MAX_ATTEMPTS,
) -> int:
    # Snapshot scalar claim attributes up front so rollback()/commit() never expires
    # subsequent ORM objects in the same AsyncSession.
    claim_snapshots = [
        (
            occurrence.Id,
            occurrence.EmailAttempts,
            occurrence.ScheduledLocalDate.isoformat(),
            reminder.RemindAt.strftime("%H:%M"),
            reminder.Timezone,
            child.ParentId,
            child.Alias,
        )
        for occurrence, reminder, child in claims
    ]
    delivered = 0
    for (
        occurrence_id,
        attempts,
        local_date,
        local_time,
        timezone_name,
        parent_id,
        child_alias,
    ) in claim_snapshots:
        await _release_repository_db(repository)
        try:
            recipient = await recipient_resolver(parent_id)
            await asyncio.to_thread(
                email_sender,
                recipient=recipient,
                child_alias=child_alias,
                local_date=local_date,
                local_time=local_time,
                timezone_name=timezone_name,
                occurrence_id=occurrence_id,
            )
        except ParentEmailUnavailable as error:
            await repository.update_email_delivery(
                occurrence_id,
                status="FAILED",
                now=now,
                error_code=error.code,
            )
        except EmailDeliveryNotConfigured:
            await repository.update_email_delivery(
                occurrence_id,
                status="FAILED",
                now=now,
                error_code="EMAIL_NOT_CONFIGURED",
            )
        except ParentEmailLookupFailed as error:
            terminal = attempts >= max_attempts
            delay_minutes = min(60, 2 ** max(0, attempts - 1))
            await repository.update_email_delivery(
                occurrence_id,
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
            terminal = attempts >= max_attempts
            delay_minutes = min(60, 2 ** max(0, attempts - 1))
            await repository.update_email_delivery(
                occurrence_id,
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
                occurrence_id,
                status="SENT",
                now=now,
            )
            delivered += 1
    return delivered


async def process_due_reminders_once(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    async with _advisory_lock_guard(READING_REMINDER_ADVISORY_LOCK_KEY) as acquired:
        if not acquired:
            logger.info("reading_reminder_skipped_lock_held")
            return 0
        async with AsyncSessionLocal() as session:
            repository = ReadingManagementRepository(session)
            await repository.create_due_occurrences_for_worker(now)
            claims = await repository.claim_due_email_occurrences(
                now, max_attempts=READING_REMINDER_MAX_ATTEMPTS
            )
            delivered = await deliver_claimed_occurrences(repository, claims, now)
        record_worker_success(_WORKER_KEY)
        return delivered


def validate_worker_configuration() -> None:
    if not email_delivery_is_configured():
        raise EmailDeliveryNotConfigured(
            "Set SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_APP_PASSWORD, and SMTP_FROM_EMAIL."
        )
    if not SUPABASE_ADMIN_KEY:
        raise RuntimeError("Set a server-only Supabase Admin API key for verified parent email lookup.")


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
            return await process_due_reminders_once()
        while not effective_stop.is_set():
            try:
                await process_due_reminders_once()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                record_worker_error(_WORKER_KEY, error)
                log_diagnostic(
                    logger,
                    logging.ERROR,
                    event="reading_reminder_worker_iteration_failed",
                    stage="scheduler",
                    exception=error,
                )
            if effective_stop.is_set():
                break
            try:
                await asyncio.wait_for(
                    effective_stop.wait(),
                    timeout=READING_REMINDER_POLL_SECONDS,
                )
                break
            except TimeoutError:
                pass
        return 0
    finally:
        await engine.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description="ViRead reading reminder email worker.")
    parser.add_argument("--once", action="store_true", help="Run one idempotent sweep and exit.")
    args = parser.parse_args()
    asyncio.run(run_worker(once=args.once))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
