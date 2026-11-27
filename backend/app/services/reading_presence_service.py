import asyncio
import inspect
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

from app.database.config import (
    READING_PRESENCE_GRACE_SECONDS,
    READING_PRESENCE_HEARTBEAT_SECONDS,
    READING_PRESENCE_MAX_PER_PARENT_PER_DAY,
    READING_PRESENCE_SESSION_COOLDOWN_SECONDS,
    READING_PRESENCE_TTL_SECONDS,
    READING_REMINDER_MAX_ATTEMPTS,
)
from app.diagnostic_logging import log_diagnostic
from app.providers.reading_presence_email_provider import (
    PresenceEmailRetryable,
    send_presence_email,
)
from app.providers.reading_reminder_email_provider import EmailDeliveryNotConfigured

logger = logging.getLogger(__name__)

# A session in one of these states may still be "being read".
ACTIVE_SESSION_STATES = frozenset(
    {"CREATED", "PAGE_READY", "LISTENING", "PAUSED", "IN_PROGRESS", "RECONNECTING"}
)
SENDING_STALE_AFTER = timedelta(minutes=5)


class _NeverRaised(Exception):
    """Default for optional exception filters: matches nothing."""


class PresenceNotFound(Exception):
    """Unknown id or not owned by the caller (never reveals which)."""


class PresenceConflict(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class PresenceLimits:
    grace_seconds: int = READING_PRESENCE_GRACE_SECONDS
    ttl_seconds: int = READING_PRESENCE_TTL_SECONDS
    heartbeat_seconds: int = READING_PRESENCE_HEARTBEAT_SECONDS
    session_cooldown_seconds: int = READING_PRESENCE_SESSION_COOLDOWN_SECONDS
    max_per_parent_per_day: int = READING_PRESENCE_MAX_PER_PARENT_PER_DAY
    max_send_attempts: int = min(3, READING_REMINDER_MAX_ATTEMPTS)


class ReadingPresenceService:
    """Rules for the opt-in "nobody in frame" parent email.

    Authorization: the session must belong to the caller (404 otherwise).
    The recipient is never taken from the client; it is resolved from the
    verified auth email of the session owner at send time.
    """

    def __init__(self, repository, limits: PresenceLimits | None = None) -> None:
        self.repo = repository
        self.limits = limits or PresenceLimits()

    # -- settings ------------------------------------------------------
    async def email_enabled(self, parent_id: UUID) -> bool:
        row = await self.repo.get_settings(parent_id)
        return bool(row and row.EmailEnabled)

    async def set_email_enabled(
        self, parent_id: UUID, enabled: bool, now: datetime
    ) -> bool:
        row = await self.repo.upsert_settings(parent_id, enabled, now)
        if not enabled:
            # Opting out takes effect immediately for anything still waiting.
            await self.repo.cancel_pending_for_parent(parent_id, "OPT_OUT")
        return bool(row.EmailEnabled)

    # -- arming --------------------------------------------------------
    async def arm(
        self, parent_id: UUID, session_id: UUID, episode_id: UUID, now: datetime
    ):
        owned = await self.repo.owned_session(session_id, parent_id)
        if owned is None:
            raise PresenceNotFound()
        session, child = owned
        if session.State not in ACTIVE_SESSION_STATES or session.EndedAt is not None:
            raise PresenceConflict("SESSION_NOT_ACTIVE")
        if not await self.email_enabled(parent_id):
            raise PresenceConflict("PRESENCE_ALERT_DISABLED")

        existing = await self.repo.by_episode(session_id, episode_id)
        if existing is not None:
            return existing, False  # retry / refresh / second device: idempotent

        cooldown_start = now - timedelta(seconds=self.limits.session_cooldown_seconds)
        if await self.repo.session_alert_since(session_id, cooldown_start) is not None:
            raise PresenceConflict("SESSION_COOLDOWN")
        day_start = now - timedelta(days=1)
        if (
            await self.repo.count_parent_alerts_since(parent_id, day_start)
            >= self.limits.max_per_parent_per_day
        ):
            raise PresenceConflict("DAILY_LIMIT")

        due_at = now + timedelta(seconds=self.limits.grace_seconds)
        alert, created = await self.repo.insert_idempotent(
            SessionId=session_id,
            ParentId=parent_id,
            ChildId=child.Id,
            EpisodeId=episode_id,
            Status="PENDING",
            DueAt=due_at,
            ExpiresAt=due_at + timedelta(seconds=self.limits.ttl_seconds),
            LastConfirmedAt=now,
        )
        return alert, created

    async def confirm(self, parent_id: UUID, alert_id: UUID, now: datetime):
        """Heartbeat: the child is still absent and the app is in the foreground."""
        alert = await self.repo.confirm(alert_id, parent_id, now)
        if alert is None:
            raise PresenceNotFound()
        return alert

    async def cancel(
        self, parent_id: UUID, alert_id: UUID, reason: str = "RETURNED"
    ):
        alert = await self.repo.cancel(alert_id, parent_id, reason)
        if alert is None:
            raise PresenceNotFound()
        return alert

    async def cancel_for_session(self, session_id: UUID, reason: str = "SESSION_ENDED") -> int:
        return await self.repo.cancel_pending_for_session(session_id, reason)

    async def _release_db(self) -> None:
        """End any open read transaction so no DB permit is held during HTTP/SMTP I/O."""
        db = getattr(self.repo, "db", None)
        rollback = getattr(db, "rollback", None)
        if callable(rollback):
            res = rollback()
            if inspect.isawaitable(res):
                await res

    # -- delivery (worker) --------------------------------------------
    async def deliver_due(
        self,
        now: datetime,
        *,
        recipient_resolver,
        email_sender=send_presence_email,
        parent_email_unavailable: type[Exception] = _NeverRaised,
        parent_lookup_failed: type[Exception] = _NeverRaised,
        batch: int = 5,
    ) -> int:
        await self.repo.expire_and_recover(now, sending_stale_after=SENDING_STALE_AFTER)
        claimed = await self.repo.claim_due(
            now,
            heartbeat=timedelta(seconds=self.limits.heartbeat_seconds),
            limit=batch,
        )
        # Snapshot scalar fields up front so rollback()/commit() on one alert
        # never expires subsequent ORM instances in the same session.
        snapshots = [
            SimpleNamespace(
                Id=alert.Id,
                SessionId=alert.SessionId,
                ChildId=alert.ChildId,
                ParentId=alert.ParentId,
                ExpiresAt=alert.ExpiresAt,
                Attempts=alert.Attempts or 0,
            )
            for alert in claimed
        ]
        if not snapshots:
            await self._release_db()
            return 0
        delivered = 0
        recipient_cache: dict[UUID, str] = {}
        unavailable_parents: set[UUID] = set()
        lookup_failed_parents: set[UUID] = set()
        for alert in snapshots:
            ctx = await self.repo.delivery_context(alert)
            # Release the read transaction before external HTTP/SMTP calls.
            await self._release_db()
            # Re-check every precondition at the last moment.
            if now >= alert.ExpiresAt:
                await self.repo.finish_alert(alert.Id, status="EXPIRED", now=now)
                continue
            if not ctx.email_enabled:
                await self.repo.finish_alert(
                    alert.Id, status="CANCELLED", now=now, cancel_reason="OPT_OUT"
                )
                continue
            if ctx.session_state not in ACTIVE_SESSION_STATES:
                await self.repo.finish_alert(
                    alert.Id, status="CANCELLED", now=now, cancel_reason="SESSION_ENDED"
                )
                continue
            if alert.ParentId in recipient_cache:
                recipient = recipient_cache[alert.ParentId]
            elif alert.ParentId in unavailable_parents:
                await self.repo.finish_alert(
                    alert.Id, status="FAILED", now=now, error_code="PARENT_EMAIL_UNVERIFIED"
                )
                continue
            elif alert.ParentId in lookup_failed_parents:
                await self._retry_or_fail(alert, now, "PARENT_EMAIL_LOOKUP_FAILED")
                continue
            else:
                try:
                    recipient = await recipient_resolver(alert.ParentId)
                except parent_email_unavailable:
                    unavailable_parents.add(alert.ParentId)
                    await self.repo.finish_alert(
                        alert.Id, status="FAILED", now=now, error_code="PARENT_EMAIL_UNVERIFIED"
                    )
                    continue
                except parent_lookup_failed:
                    lookup_failed_parents.add(alert.ParentId)
                    await self._retry_or_fail(alert, now, "PARENT_EMAIL_LOOKUP_FAILED")
                    continue
                recipient_cache[alert.ParentId] = recipient
            try:
                await asyncio.to_thread(
                    email_sender,
                    recipient=recipient,
                    child_alias=ctx.child_alias,
                    alert_id=alert.Id,
                )
            except PresenceEmailRetryable:
                await self._retry_or_fail(alert, now, "SMTP_UNAVAILABLE")
            except EmailDeliveryNotConfigured:
                await self.repo.finish_alert(
                    alert.Id, status="FAILED", now=now, error_code="EMAIL_NOT_CONFIGURED"
                )
            except FileExistsError:
                # The sink already holds this alert's message: delivered before.
                await self.repo.finish_alert(alert.Id, status="SENT", now=now)
            except Exception as error:
                # Ambiguous (could have been sent): never retry, at most one email.
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="reading_presence_email_failed",
                    stage="email_delivery",
                    exception=error,
                    attempt=alert.Attempts,
                )
                await self.repo.finish_alert(
                    alert.Id, status="FAILED", now=now, error_code="DELIVERY_UNCERTAIN"
                )
            else:
                await self.repo.finish_alert(alert.Id, status="SENT", now=now)
                delivered += 1
        return delivered

    async def _retry_or_fail(self, alert, now: datetime, code: str) -> None:
        if (alert.Attempts or 0) < self.limits.max_send_attempts and now < alert.ExpiresAt:
            await self.repo.release_for_retry(alert.Id)
        else:
            await self.repo.finish_alert(alert.Id, status="FAILED", now=now, error_code=code)
