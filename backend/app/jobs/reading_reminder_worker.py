from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager
import inspect
import logging
import signal
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
from app.services.i18n.locales import DEFAULT_LOCALE, resolve_supported_locale
from app.services.worker_telemetry import record_worker_error, record_worker_success

logger = logging.getLogger(__name__)
READING_REMINDER_ADVISORY_LOCK_KEY = 4201001
DEFAULT_REMINDER_CLAIM_LIMIT = 5
_WORKER_KEY = "reading_reminder"


class ParentEmailUnavailable(Exception):
    def __init__(self, code: str = "PARENT_EMAIL_UNVERIFIED") -> None:
        self.code = code
        super().__init__(code)


class ParentEmailLookupFailed(Exception):
    """Raised when the contact provider is temporarily unavailable."""


@asynccontextmanager
async def _advisory_lock_guard(_lock_key: int):
    """Deprecated no-op shim retained only for legacy test monkeypatch compatibility.

    Supavisor transaction pooler (port 6543) does not support session-level
    pg_try_advisory_lock safely; concurrency isolation is enforced atomically
    via FOR UPDATE SKIP LOCKED + ON CONFLICT DO NOTHING on a single DB session.
    """
    yield True


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


def _sender_accepts_locale(email_sender) -> bool:
    try:
        sig = inspect.signature(email_sender)
    except (TypeError, ValueError):
        return False
    for param in sig.parameters.values():
        if param.kind == inspect.Parameter.VAR_KEYWORD:
            return True
        if param.name == "locale" and param.kind in (
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        ):
            return True
    return False


def _extract_explicit_locale(reminder: ReadingReminder, child: ChildProfile) -> str:
    explicit = getattr(reminder, "Locale", None) or getattr(child, "Locale", None)
    if explicit:
        return resolve_supported_locale(explicit)
    settings = getattr(child, "Settings", None)
    if isinstance(settings, dict):
        pref = settings.get("preferred_locale") or settings.get("locale")
        if pref:
            return resolve_supported_locale(pref)
    return DEFAULT_LOCALE


async def _resolve_claim_locale(
    reminder: ReadingReminder,
    child: ChildProfile,
    locale_resolver=None,
) -> str:
    if locale_resolver is not None:
        raw = locale_resolver(child.ParentId)
        if inspect.isawaitable(raw):
            raw = await raw
        if raw:
            return resolve_supported_locale(raw)
    return _extract_explicit_locale(reminder, child)


async def deliver_claimed_occurrences(
    repository: ReadingManagementRepository,
    claims: list[tuple[ReadingReminderOccurrence, ReadingReminder, ChildProfile]],
    now: datetime,
    *,
    recipient_resolver=get_verified_parent_email,
    email_sender=send_reading_reminder_email,
    locale_resolver=None,
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
            _extract_explicit_locale(reminder, child),
        )
        for occurrence, reminder, child in claims
    ]
    delivered = 0
    supports_locale = _sender_accepts_locale(email_sender)
    # Memoize parent email & locale lookups per sweep so multiple reminders for the
    # same parent never trigger redundant Supabase Auth Admin HTTP calls.
    recipient_cache: dict[UUID, str] = {}
    unavailable_cache: dict[UUID, str] = {}
    lookup_failed_parents: set[UUID] = set()
    locale_cache: dict[UUID, str | None] = {}

    for (
        occurrence_id,
        attempts,
        local_date,
        local_time,
        timezone_name,
        parent_id,
        child_alias,
        explicit_locale,
    ) in claim_snapshots:
        await _release_repository_db(repository)
        try:
            if parent_id in recipient_cache:
                recipient = recipient_cache[parent_id]
            elif parent_id in unavailable_cache:
                raise ParentEmailUnavailable(unavailable_cache[parent_id])
            elif parent_id in lookup_failed_parents:
                raise ParentEmailLookupFailed()
            else:
                try:
                    recipient = await recipient_resolver(parent_id)
                except ParentEmailUnavailable as error:
                    unavailable_cache[parent_id] = error.code
                    raise
                except ParentEmailLookupFailed:
                    lookup_failed_parents.add(parent_id)
                    raise
                recipient_cache[parent_id] = recipient

            send_kwargs: dict[str, object] = {
                "recipient": recipient,
                "child_alias": child_alias,
                "local_date": local_date,
                "local_time": local_time,
                "timezone_name": timezone_name,
                "occurrence_id": occurrence_id,
            }
            if supports_locale:
                claim_locale = explicit_locale
                if locale_resolver is not None:
                    if parent_id not in locale_cache:
                        raw_locale = locale_resolver(parent_id)
                        if inspect.isawaitable(raw_locale):
                            raw_locale = await raw_locale
                        locale_cache[parent_id] = (
                            resolve_supported_locale(raw_locale) if raw_locale else None
                        )
                    cached_locale = locale_cache[parent_id]
                    if cached_locale:
                        claim_locale = cached_locale
                send_kwargs["locale"] = claim_locale
            await asyncio.to_thread(email_sender, **send_kwargs)
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


async def process_due_reminders_once(
    now: datetime | None = None,
    *,
    limit: int = DEFAULT_REMINDER_CLAIM_LIMIT,
) -> int:
    now = now or datetime.now(timezone.utc)
    try:
        async with AsyncSessionLocal() as session:
            repository = ReadingManagementRepository(session)
            await repository.create_due_occurrences_for_worker(now)
            claims = await repository.claim_due_email_occurrences(
                now,
                limit=max(1, int(limit)),
                max_attempts=READING_REMINDER_MAX_ATTEMPTS,
            )
            delivered = (
                await deliver_claimed_occurrences(repository, claims, now)
                if claims
                else 0
            )
        record_worker_success(_WORKER_KEY)
        return delivered
    except asyncio.CancelledError:
        raise
    except Exception as error:
        record_worker_error(_WORKER_KEY, error)
        raise


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
