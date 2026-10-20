"""Orchestrate occurrence creation, verified-parent lookup and idempotent email delivery."""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from app.database.config import READING_REMINDER_CATCH_UP_MINUTES
from app.providers.resend_email_provider import ResendEmailProvider, ResendEmailProviderError
from app.providers.supabase_auth_contact_provider import SupabaseAuthContactProvider

MAX_ATTEMPTS = 5
DEFAULT_BATCH_SIZE = 100


class ReadingReminderEmailService:
    def __init__(self, repository, mailer=None, auth_provider=None):
        self.repository = repository
        self.mailer = mailer or ResendEmailProvider()
        self.auth_provider = auth_provider or SupabaseAuthContactProvider()

    async def run_once(self, *, now: datetime | None = None,
                       catch_up_minutes: int = READING_REMINDER_CATCH_UP_MINUTES,
                       batch_size: int = DEFAULT_BATCH_SIZE) -> dict[str, int]:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        stats = {"reminders_checked": 0, "occurrences_created": 0, "deliveries_created": 0,
                 "provider_accepted": 0, "skipped": 0, "failed": 0, "retried": 0,
                 "stale_claims_recovered": 0}
        stats["stale_claims_recovered"] = await self.repository.recover_stale_processing(now)
        queued = await self.repository.enqueue_due_deliveries(now, catch_up_minutes)
        for key in ("reminders_checked", "occurrences_created", "deliveries_created"):
            stats[key] = queued.get(key, 0)
        stats["skipped"] += await self.repository.skip_ineligible_deliveries(now)

        if not self.mailer.is_configured:
            stats["skipped"] += await self.repository.skip_waiting_deliveries(
                "email_provider_not_configured", now)
            return stats

        processed = 0
        while processed < batch_size:
            claim = await self.repository.claim_next_delivery(now)
            if claim is None:
                break
            processed += 1
            delivery_id = claim["delivery_id"]
            if not await self.repository.delivery_is_current(delivery_id):
                await self.repository.mark_skipped(delivery_id, "reminder_disabled_deleted_or_owner_changed", now)
                stats["skipped"] += 1
                continue

            try:
                contact = await self.auth_provider.get_contact_info(UUID(str(claim["parent_id"])))
            except Exception:
                retry = await self.repository.mark_failed(
                    delivery_id, "parent_auth_lookup_failed", retryable=True, now=now,
                    max_attempts=MAX_ATTEMPTS)
                stats["failed"] += 1
                stats["retried"] += int(retry)
                continue

            contact_status = contact.get("contact_info_status")
            if contact_status == "lookup_failed":
                retry = await self.repository.mark_failed(
                    delivery_id, "parent_auth_lookup_failed", retryable=True, now=now,
                    max_attempts=MAX_ATTEMPTS)
                stats["failed"] += 1
                stats["retried"] += int(retry)
                continue
            if contact_status != "available":
                reason = ("supabase_auth_admin_not_configured" if contact_status == "not_configured"
                          else "parent_auth_user_unavailable")
                await self.repository.mark_skipped(delivery_id, reason, now)
                stats["skipped"] += 1
                continue

            to_email = contact.get("email")
            if not isinstance(to_email, str) or not to_email.strip():
                await self.repository.mark_skipped(delivery_id, "parent_email_missing", now)
                stats["skipped"] += 1
                continue
            if contact.get("email_verified") is not True:
                await self.repository.mark_skipped(delivery_id, "parent_email_unverified", now)
                stats["skipped"] += 1
                continue

            try:
                provider_id = await self.mailer.send_reminder(
                    to_email=to_email, scheduled_for=claim["scheduled_for"],
                    timezone_name=claim["timezone"],
                    idempotency_key=str(claim["occurrence_key"]))
            except ResendEmailProviderError as error:
                retry = await self.repository.mark_failed(
                    delivery_id, error.code, retryable=error.retryable, now=now,
                    max_attempts=MAX_ATTEMPTS)
                stats["failed"] += 1
                stats["retried"] += int(retry)
                continue
            except Exception:
                retry = await self.repository.mark_failed(
                    delivery_id, "provider_unexpected_error", retryable=True, now=now,
                    max_attempts=MAX_ATTEMPTS)
                stats["failed"] += 1
                stats["retried"] += int(retry)
                continue

            await self.repository.mark_sent(delivery_id, provider_id, now)
            stats["provider_accepted"] += 1
        return stats
