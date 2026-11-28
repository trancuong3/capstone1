from __future__ import annotations

import asyncio
import inspect
import logging
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Iterable
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.diagnostic_logging import log_diagnostic
from app.jobs.reading_reminder_worker import (
    ParentEmailLookupFailed,
    ParentEmailUnavailable,
    get_verified_parent_email,
)
from app.models.parent_email_notification import ParentEmailPreference
from app.providers.parent_email_transport import (
    ChildInactivityItem,
    ChildMilestoneItem,
    ChildWeeklyDigestItem,
    EmailTransportPermanent,
    EmailTransportRetryable,
    active_email_provider,
    build_inactivity_alert_message,
    build_milestone_message,
    build_test_email_message,
    build_weekly_digest_message,
    parent_email_automation_readiness,
    parent_email_delivery_is_configured,
    send_email_message,
)
from app.providers.reading_reminder_email_provider import EmailDeliveryNotConfigured
from app.repositories.parent_email_notification_repository import (
    ActiveParentBundle,
    ChildActivitySnapshot,
    ParentDeliverySummary,
    ParentEmailNotificationRepository,
)
from app.schemas.parent_email_notification import (
    ParentEmailDeliveryRead,
    ParentEmailPreferencesRead,
    ParentEmailPreferencesUpdate,
    ParentEmailTestResponse,
)
from app.services.reading_management_service import (
    completed_metric,
    goal_cycle_window,
    union_duration_seconds,
)

logger = logging.getLogger(__name__)

INACTIVITY_COOLDOWN_DAYS = 7
MAX_CONSECUTIVE_UNANSWERED_INACTIVITY_ALERTS = 2
MILESTONE_COOLDOWN_HOURS = 24
TEST_EMAIL_COOLDOWN_SECONDS = 300
FIRST_SESSION_WINDOW_HOURS = 48
MAX_DELIVERY_ATTEMPTS = 3
SENDING_STALE_AFTER = timedelta(minutes=10)
MAX_PAGINATION_PAGES = 500
STREAK_MILESTONES = (30, 14, 7)


class ParentNotificationError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


@dataclass(frozen=True)
class EffectiveEmailPreferences:
    weekly_digest_enabled: bool = True
    inactivity_alert_enabled: bool = True
    inactivity_days: int = 5
    milestone_enabled: bool = True
    digest_weekday: int = 6  # Sunday (0=Mon .. 6=Sun)
    timezone: str = "Asia/Ho_Chi_Minh"
    quiet_hours_start: int = 21
    quiet_hours_end: int = 7
    max_emails_per_week: int = 4
    updated_at: datetime | None = None


def effective_preferences(
    row: ParentEmailPreference | None,
) -> EffectiveEmailPreferences:
    if row is None:
        return EffectiveEmailPreferences()
    return EffectiveEmailPreferences(
        weekly_digest_enabled=bool(row.WeeklyDigestEnabled),
        inactivity_alert_enabled=bool(row.InactivityAlertEnabled),
        inactivity_days=int(row.InactivityDays),
        milestone_enabled=bool(row.MilestoneEnabled),
        digest_weekday=int(row.DigestWeekday),
        timezone=str(row.Timezone or "Asia/Ho_Chi_Minh"),
        quiet_hours_start=int(row.QuietHoursStart),
        quiet_hours_end=int(row.QuietHoursEnd),
        max_emails_per_week=int(row.MaxEmailsPerWeek),
        updated_at=row.UpdatedAt,
    )


def safe_zone(tz_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("Asia/Ho_Chi_Minh")


def is_in_quiet_hours(local_hour: int, start_hour: int, end_hour: int) -> bool:
    """Return True if local_hour falls inside [start_hour, end_hour) with wrap-around."""
    if start_hour == end_hour:
        return False
    if start_hour < end_hour:
        return start_hour <= local_hour < end_hour
    # Overnight window (e.g. 21:00 -> 07:00)
    return local_hour >= start_hour or local_hour < end_hour


def compute_reading_streak_days(session_dates: Iterable[date], today: date) -> int:
    """Count consecutive calendar days with >= 1 completed session ending today or yesterday."""
    unique_days = set(session_dates)
    if today in unique_days:
        cursor = today
    elif (today - timedelta(days=1)) in unique_days:
        cursor = today - timedelta(days=1)
    else:
        return 0
    streak = 0
    while cursor in unique_days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def sum_unique_reading_minutes(sessions, now: datetime) -> int:
    intervals: list[tuple[datetime, datetime]] = []
    for session in sessions:
        started = getattr(session, "StartedAt", None)
        ended = getattr(session, "EndedAt", None)
        if started is None or ended is None or ended <= started or ended > now:
            continue
        intervals.append((started, ended))
    return max(0, int(union_duration_seconds(intervals) // 60))


def _format_goal_summary(snapshot: ChildActivitySnapshot, now: datetime) -> str | None:
    for goal in snapshot.active_goals:
        try:
            window = goal_cycle_window(goal, now)
        except (ZoneInfoNotFoundError, ValueError):
            continue
        if window is None:
            continue
        starts_at, ends_at = window
        value = completed_metric(
            snapshot.sessions_last_35d, goal.Metric, now, starts_at, ends_at
        )
        unit = "phút" if goal.Metric == "MINUTES" else "buổi"
        period_label = "ngày" if goal.Period == "DAILY" else "tuần"
        pct = min(100, round(value * 100 / max(1, goal.TargetValue)))
        return f"{value}/{goal.TargetValue} {unit}/{period_label} ({pct}%)"
    return None


def _as_utc_or_none(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _snapshot_child(child) -> SimpleNamespace:
    """Copy scalar ChildProfile attributes so DB rollbacks never expire ORM state."""
    return SimpleNamespace(
        Id=child.Id,
        ParentId=getattr(child, "ParentId", None),
        Alias=child.Alias,
        CreatedAt=_as_utc_or_none(getattr(child, "CreatedAt", None)),
    )


def _snapshot_session(session) -> SimpleNamespace:
    return SimpleNamespace(
        Id=getattr(session, "Id", None),
        ChildId=getattr(session, "ChildId", None),
        State=getattr(session, "State", None),
        StartedAt=_as_utc_or_none(getattr(session, "StartedAt", None)),
        EndedAt=_as_utc_or_none(getattr(session, "EndedAt", None)),
    )


def _snapshot_goal(goal) -> SimpleNamespace:
    return SimpleNamespace(
        Id=goal.Id,
        ChildId=getattr(goal, "ChildId", None),
        Metric=goal.Metric,
        Period=goal.Period,
        TargetValue=goal.TargetValue,
        Timezone=goal.Timezone,
        StartsOn=getattr(goal, "StartsOn", None),
        EndsOn=getattr(goal, "EndsOn", None),
        Status=getattr(goal, "Status", "ACTIVE"),
    )


def _snapshot_retry(row) -> SimpleNamespace:
    return SimpleNamespace(
        Status=getattr(row, "Status", None),
        Attempts=getattr(row, "Attempts", 0),
        NextAttemptAt=_as_utc_or_none(getattr(row, "NextAttemptAt", None)),
        DedupeKey=getattr(row, "DedupeKey", None),
    )


def _snapshot_summary(summary: ParentDeliverySummary) -> ParentDeliverySummary:
    return ParentDeliverySummary(
        automated_sent_last_7d=summary.automated_sent_last_7d,
        last_digest_sent_at=_as_utc_or_none(summary.last_digest_sent_at),
        last_milestone_sent_at=_as_utc_or_none(summary.last_milestone_sent_at),
        last_inactivity_sent_at=_as_utc_or_none(summary.last_inactivity_sent_at),
    )


def _snapshot_activity(snapshot: ChildActivitySnapshot) -> ChildActivitySnapshot:
    """Detach all ORM rows inside a ChildActivitySnapshot before DB rollbacks."""
    return ChildActivitySnapshot(
        child=_snapshot_child(snapshot.child),  # type: ignore[arg-type]
        sessions_last_7d=tuple(_snapshot_session(s) for s in snapshot.sessions_last_7d),  # type: ignore[arg-type]
        sessions_prev_7d_count=snapshot.sessions_prev_7d_count,
        sessions_last_35d=tuple(_snapshot_session(s) for s in snapshot.sessions_last_35d),  # type: ignore[arg-type]
        total_completed_sessions=snapshot.total_completed_sessions,
        last_session_at=_as_utc_or_none(snapshot.last_session_at),
        avg_fluency_last_7d=snapshot.avg_fluency_last_7d,
        top_difficult_words_last_7d=tuple(snapshot.top_difficult_words_last_7d),
        active_goals=tuple(_snapshot_goal(g) for g in snapshot.active_goals),  # type: ignore[arg-type]
        first_completed_session_at=_as_utc_or_none(snapshot.first_completed_session_at),
    )


class ParentEmailNotificationService:
    """Orchestrates parent email preferences, anti-spam guardrails, and scenario dispatch."""

    def __init__(self, repository: ParentEmailNotificationRepository) -> None:
        self.repo = repository

    async def _is_storage_ready(self) -> bool:
        is_ready_fn = getattr(self.repo, "is_storage_ready", None)
        if is_ready_fn is None:
            return True
        return bool(await is_ready_fn())

    async def get_preferences(self, parent_id: UUID) -> ParentEmailPreferencesRead:
        ready, provider, _reason = parent_email_automation_readiness()
        if not await self._is_storage_ready():
            prefs = EffectiveEmailPreferences()
            return ParentEmailPreferencesRead(
                weekly_digest_enabled=prefs.weekly_digest_enabled,
                inactivity_alert_enabled=prefs.inactivity_alert_enabled,
                inactivity_days=prefs.inactivity_days,
                milestone_enabled=prefs.milestone_enabled,
                digest_weekday=prefs.digest_weekday,
                timezone=prefs.timezone,
                quiet_hours_start=prefs.quiet_hours_start,
                quiet_hours_end=prefs.quiet_hours_end,
                max_emails_per_week=prefs.max_emails_per_week,
                delivery_configured=False,
                delivery_provider=provider,
                updated_at=prefs.updated_at,
            )
        prefs = effective_preferences(await self.repo.get_preferences(parent_id))
        return ParentEmailPreferencesRead(
            weekly_digest_enabled=prefs.weekly_digest_enabled,
            inactivity_alert_enabled=prefs.inactivity_alert_enabled,
            inactivity_days=prefs.inactivity_days,
            milestone_enabled=prefs.milestone_enabled,
            digest_weekday=prefs.digest_weekday,
            timezone=prefs.timezone,
            quiet_hours_start=prefs.quiet_hours_start,
            quiet_hours_end=prefs.quiet_hours_end,
            max_emails_per_week=prefs.max_emails_per_week,
            delivery_configured=ready,
            delivery_provider=provider,
            updated_at=prefs.updated_at,
        )

    async def update_preferences(
        self,
        parent_id: UUID,
        payload: ParentEmailPreferencesUpdate,
        now: datetime | None = None,
    ) -> ParentEmailPreferencesRead:
        if not await self._is_storage_ready():
            raise ParentNotificationError(
                code="EMAIL_STORAGE_NOT_MIGRATED",
                message="Cơ sở dữ liệu thông báo email chưa được cập nhật. Vui lòng áp dụng migration Supabase trước khi lưu cài đặt.",
                status_code=503,
            )
        now = now or datetime.now(timezone.utc)
        mapping = {
            "weekly_digest_enabled": "WeeklyDigestEnabled",
            "inactivity_alert_enabled": "InactivityAlertEnabled",
            "inactivity_days": "InactivityDays",
            "milestone_enabled": "MilestoneEnabled",
            "digest_weekday": "DigestWeekday",
            "timezone": "Timezone",
            "quiet_hours_start": "QuietHoursStart",
            "quiet_hours_end": "QuietHoursEnd",
            "max_emails_per_week": "MaxEmailsPerWeek",
        }
        raw = payload.model_dump(exclude_unset=True)
        values = {
            mapping[key]: value
            for key, value in raw.items()
            if key in mapping and value is not None
        }
        if values:
            await self.repo.upsert_preferences(parent_id, values, now)
        return await self.get_preferences(parent_id)

    async def list_history(
        self, parent_id: UUID, *, limit: int = 10
    ) -> list[ParentEmailDeliveryRead]:
        if not await self._is_storage_ready():
            return []
        rows = await self.repo.list_recent_deliveries(parent_id, limit=limit)
        return [
            ParentEmailDeliveryRead(
                id=row.Id,
                category=row.Category,
                status=row.Status,
                subject=row.Subject,
                sent_at=row.SentAt,
                created_at=row.CreatedAt,
                error_code=row.ErrorCode,
            )
            for row in rows
        ]

    async def send_test_email(
        self,
        parent_id: UUID,
        now: datetime | None = None,
        *,
        recipient_resolver=get_verified_parent_email,
        message_sender=send_email_message,
    ) -> ParentEmailTestResponse:
        now = now or datetime.now(timezone.utc)
        if not await self._is_storage_ready():
            raise ParentNotificationError(
                code="EMAIL_STORAGE_NOT_MIGRATED",
                message="Cơ sở dữ liệu thông báo email chưa được cập nhật. Vui lòng áp dụng migration Supabase trước khi gửi email thử nghiệm.",
                status_code=503,
            )
        provider = active_email_provider()
        if provider == "unconfigured":
            raise ParentNotificationError(
                code="EMAIL_NOT_CONFIGURED",
                message="Máy chủ chưa cấu hình dịch vụ gửi email (Resend hoặc SMTP).",
                status_code=503,
            )

        last_test = await self.repo.last_sent_for_category(parent_id, "TEST_EMAIL")
        if (
            last_test is not None
            and last_test.SentAt is not None
            and (now - last_test.SentAt).total_seconds() < TEST_EMAIL_COOLDOWN_SECONDS
        ):
            raise ParentNotificationError(
                code="TEST_EMAIL_RATE_LIMITED",
                message="Ba mẹ vừa gửi email thử nghiệm gần đây. Vui lòng đợi 5 phút trước khi thử lại.",
                status_code=429,
            )

        try:
            recipient = await recipient_resolver(parent_id)
        except ParentEmailUnavailable:
            raise ParentNotificationError(
                code="PARENT_EMAIL_UNVERIFIED",
                message="Email tài khoản chưa được xác minh nên hệ thống không thể gửi thông báo.",
                status_code=409,
            ) from None
        except ParentEmailLookupFailed:
            raise ParentNotificationError(
                code="PARENT_EMAIL_LOOKUP_FAILED",
                message="Chưa thể kiểm tra địa chỉ email xác minh lúc này. Ba mẹ thử lại sau nhé.",
                status_code=503,
            ) from None

        profile = await self.repo.get_profile(parent_id)
        parent_name = profile.DisplayName if profile is not None else None
        dedupe_key = f"test_email:{parent_id}:{uuid4().hex}"
        delivery = await self.repo.insert_and_claim_delivery(
            parent_id=parent_id,
            child_id=None,
            category="TEST_EMAIL",
            dedupe_key=dedupe_key,
            subject="ViRead: Xác nhận kết nối email thông báo thành công",
            metadata={"provider": provider},
            now=now,
        )
        if delivery is None:  # pragma: no cover - unique uuid4
            raise ParentNotificationError(
                code="DELIVERY_CONFLICT",
                message="Không thể tạo bản ghi gửi email thử nghiệm.",
                status_code=409,
            )

        delivery_id = delivery.Id
        await self._release_db()
        message = build_test_email_message(
            recipient=recipient,
            parent_name=parent_name,
            delivery_id=delivery_id,
        )
        try:
            used_provider = await asyncio.to_thread(message_sender, message)
        except EmailDeliveryNotConfigured:
            await self.repo.finish_delivery(
                delivery_id, status="FAILED", now=now, error_code="EMAIL_NOT_CONFIGURED"
            )
            raise ParentNotificationError(
                code="EMAIL_NOT_CONFIGURED",
                message="Máy chủ chưa cấu hình dịch vụ gửi email.",
                status_code=503,
            ) from None
        except (EmailTransportRetryable, EmailTransportPermanent, Exception) as error:
            code = (
                "EMAIL_PROVIDER_REJECTED"
                if isinstance(error, EmailTransportPermanent)
                else "EMAIL_PROVIDER_UNAVAILABLE"
            )
            await self.repo.finish_delivery(
                delivery_id, status="FAILED", now=now, error_code=code
            )
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_test_email_failed",
                stage="email_delivery",
                exception=error,
                delivery_error_code=code,
                provider=provider,
            )
            return ParentEmailTestResponse(
                status="FAILED",
                delivery_id=delivery_id,
                provider=provider,
                error_code=code,
                message="Chưa gửi được email thử nghiệm. Vui lòng kiểm tra lại cấu hình gửi email trên máy chủ.",
            )

        await self.repo.finish_delivery(delivery_id, status="SENT", now=now)
        return ParentEmailTestResponse(
            status="SENT",
            delivery_id=delivery_id,
            provider=used_provider,
            message="Đã gửi email thử nghiệm đến địa chỉ email đã xác minh của ba mẹ.",
        )

    async def _release_db(self) -> None:
        """End any open read transaction so no DB connection is held during HTTP/SMTP I/O."""
        db = getattr(self.repo, "db", None)
        rollback = getattr(db, "rollback", None)
        if callable(rollback):
            res = rollback()
            if inspect.isawaitable(res):
                await res

    @staticmethod
    def _is_row_due_retry(row, now: datetime) -> bool:
        if row is None or row.Status != "RETRY" or (row.Attempts or 0) >= MAX_DELIVERY_ATTEMPTS:
            return False
        next_attempt = _as_utc_or_none(getattr(row, "NextAttemptAt", None))
        utc_now = _as_utc_or_none(now) or now
        return next_attempt is None or next_attempt <= utc_now

    async def _can_attempt_dedupe_key(
        self,
        dedupe_key: str,
        now: datetime,
        *,
        prefetched_retries: dict[str, object] | None = None,
    ) -> bool:
        """Return True if dedupe_key has not been sent/failed yet OR is due for a retry."""
        if prefetched_retries is not None and dedupe_key in prefetched_retries:
            return self._is_row_due_retry(prefetched_retries[dedupe_key], now)
        get_delivery = getattr(self.repo, "get_delivery_by_dedupe_key", None)
        if get_delivery is None:
            return not await self.repo.delivery_exists(dedupe_key)
        row = await get_delivery(dedupe_key)
        if row is None:
            return True
        return self._is_row_due_retry(row, now)

    async def _has_due_retry(
        self,
        dedupe_key: str,
        now: datetime,
        *,
        prefetched_retries: dict[str, object] | None = None,
    ) -> bool:
        if prefetched_retries is not None:
            return self._is_row_due_retry(prefetched_retries.get(dedupe_key), now)
        get_delivery = getattr(self.repo, "get_delivery_by_dedupe_key", None)
        if get_delivery is None:
            return False
        row = await get_delivery(dedupe_key)
        return self._is_row_due_retry(row, now)

    @staticmethod
    def _make_memoized_recipient_resolver(recipient_resolver):
        resolved: dict[UUID, str] = {}
        unavailable: dict[UUID, str] = {}
        lookup_failed: set[UUID] = set()

        async def _memoized(parent_id: UUID) -> str:
            if parent_id in resolved:
                return resolved[parent_id]
            if parent_id in unavailable:
                raise ParentEmailUnavailable(unavailable[parent_id])
            if parent_id in lookup_failed:
                raise ParentEmailLookupFailed()
            try:
                email = await recipient_resolver(parent_id)
            except ParentEmailUnavailable as error:
                unavailable[parent_id] = error.code
                raise
            except ParentEmailLookupFailed:
                lookup_failed.add(parent_id)
                raise
            resolved[parent_id] = email
            return email

        return _memoized

    async def dispatch_engagement_emails(
        self,
        now: datetime | None = None,
        *,
        recipient_resolver=get_verified_parent_email,
        message_sender=send_email_message,
        batch_limit: int = 50,
        max_emails: int | None = None,
        max_seconds: float | None = None,
    ) -> int:
        """Evaluate weekly digest, inactivity alert, and milestones for active parents."""
        now = now or datetime.now(timezone.utc)
        if not parent_email_delivery_is_configured():
            return 0
        if recipient_resolver is get_verified_parent_email:
            ready, _provider, _reason = parent_email_automation_readiness()
            if not ready:
                return 0

        is_ready_fn = getattr(self.repo, "is_storage_ready", None)
        if is_ready_fn is not None and not await is_ready_fn():
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_email_tables_not_migrated",
                stage="engagement_dispatch",
                error_code="PARENT_EMAIL_TABLES_NOT_MIGRATED",
            )
            return 0

        recover_fn = getattr(self.repo, "recover_stale_sending", None)
        if recover_fn is not None:
            await recover_fn(now, stale_after=SENDING_STALE_AFTER)

        expire_retries_fn = getattr(self.repo, "expire_stale_retries", None)
        if expire_retries_fn is not None:
            await expire_retries_fn(now, max_attempts=MAX_DELIVERY_ATTEMPTS)

        deadline = (
            time.monotonic() + max(0.5, float(max_seconds))
            if max_seconds is not None
            else None
        )
        memoized_resolver = self._make_memoized_recipient_resolver(recipient_resolver)
        raw_summaries_fn = getattr(self.repo, "get_parent_delivery_summaries_batch", None)
        raw_retries_fn = getattr(self.repo, "list_retry_deliveries_batch", None)
        raw_snapshots_fn = getattr(self.repo, "get_children_activity_snapshots_batch", None)
        batch_summaries_fn = (
            raw_summaries_fn if inspect.iscoroutinefunction(raw_summaries_fn) else None
        )
        batch_retries_fn = (
            raw_retries_fn if inspect.iscoroutinefunction(raw_retries_fn) else None
        )
        batch_snapshots_fn = (
            raw_snapshots_fn if inspect.iscoroutinefunction(raw_snapshots_fn) else None
        )

        delivered = 0
        after_created_at: datetime | None = None
        after_id: UUID | None = None
        seen_parent_ids: set[UUID] = set()

        for _page in range(MAX_PAGINATION_PAGES):
            if max_emails is not None and delivered >= max_emails:
                break
            if deadline is not None and time.monotonic() >= deadline:
                break

            if after_created_at is not None and after_id is not None:
                bundles = await self.repo.list_active_parents_with_children(
                    limit=batch_limit,
                    after_created_at=after_created_at,
                    after_id=after_id,
                )
            else:
                bundles = await self.repo.list_active_parents_with_children(
                    limit=batch_limit
                )
            if not bundles:
                break

            page_size = len(bundles)
            last_bundle_created_at = _as_utc_or_none(bundles[-1].created_at)
            last_bundle_parent_id = bundles[-1].parent_id

            # Pre-filter quiet-hours and all-disabled parents BEFORE hitting DB for stats/snapshots,
            # and snapshot ORM ChildProfile / ParentEmailPreference fields so later DB rollbacks
            # before external email sends can never expire prefetched ORM instances (MissingGreenlet).
            candidate_entries: list[
                tuple[ActiveParentBundle, EffectiveEmailPreferences, ZoneInfo, datetime]
            ] = []
            for bundle in bundles:
                if bundle.parent_id in seen_parent_ids:
                    continue
                seen_parent_ids.add(bundle.parent_id)
                prefs = effective_preferences(bundle.preferences)
                zone = safe_zone(prefs.timezone)
                local_now = now.astimezone(zone)
                if is_in_quiet_hours(
                    local_now.hour, prefs.quiet_hours_start, prefs.quiet_hours_end
                ):
                    continue
                if not (
                    prefs.weekly_digest_enabled
                    or prefs.inactivity_alert_enabled
                    or prefs.milestone_enabled
                ):
                    continue
                detached_bundle = ActiveParentBundle(
                    parent_id=bundle.parent_id,
                    display_name=bundle.display_name,
                    children=tuple(_snapshot_child(c) for c in bundle.children),  # type: ignore[arg-type]
                    preferences=None,
                    created_at=_as_utc_or_none(bundle.created_at),
                )
                candidate_entries.append((detached_bundle, prefs, zone, local_now))

            prefetched_summaries: dict[UUID, ParentDeliverySummary] | None = None
            prefetched_retries: dict[str, object] | None = None
            prefetched_snapshots: dict[UUID, ChildActivitySnapshot] | None = None

            if candidate_entries:
                candidate_parent_ids = [b.parent_id for b, _, _, _ in candidate_entries]
                if batch_summaries_fn is not None:
                    raw_summaries = await batch_summaries_fn(candidate_parent_ids, now)
                    prefetched_summaries = {
                        pid: _snapshot_summary(summary)
                        for pid, summary in raw_summaries.items()
                    }
                    candidate_entries = [
                        entry
                        for entry in candidate_entries
                        if (
                            entry[1].max_emails_per_week
                            - (
                                prefetched_summaries[entry[0].parent_id].automated_sent_last_7d
                                if entry[0].parent_id in prefetched_summaries
                                else 0
                            )
                        )
                        > 0
                    ]

                if candidate_entries and batch_retries_fn is not None:
                    raw_retries = await batch_retries_fn(
                        [b.parent_id for b, _, _, _ in candidate_entries]
                    )
                    prefetched_retries = {
                        key: _snapshot_retry(row) for key, row in raw_retries.items()
                    }

                if candidate_entries and batch_snapshots_fn is not None:
                    digest_child_ids: set[UUID] = set()
                    all_children = []
                    for bundle, prefs, zone, local_now in candidate_entries:
                        all_children.extend(bundle.children)
                        if not prefs.weekly_digest_enabled:
                            continue
                        iso_year, iso_week, _ = local_now.isocalendar()
                        week_token = f"{iso_year}-W{iso_week:02d}"
                        yesterday_date = local_now.date() - timedelta(days=1)
                        prev_iso_year, prev_iso_week, _ = yesterday_date.isocalendar()
                        yesterday_week_token = f"{prev_iso_year}-W{prev_iso_week:02d}"
                        cur_key = f"weekly_digest:{bundle.parent_id}:{week_token}"
                        prev_key = f"weekly_digest:{bundle.parent_id}:{yesterday_week_token}"
                        already_sent_this_week = False
                        if prefetched_summaries is not None:
                            summary = prefetched_summaries.get(bundle.parent_id)
                            if (
                                summary is not None
                                and summary.last_digest_sent_at is not None
                            ):
                                sent_iso = (
                                    summary.last_digest_sent_at.astimezone(zone).isocalendar()
                                )
                                already_sent_this_week = (
                                    sent_iso[0],
                                    sent_iso[1],
                                ) == (iso_year, iso_week)
                        needs_digest = (
                            local_now.weekday() == prefs.digest_weekday
                            and not already_sent_this_week
                        )
                        if not needs_digest and prefetched_retries is not None:
                            needs_digest = self._is_row_due_retry(
                                prefetched_retries.get(cur_key), now
                            ) or (
                                yesterday_week_token != week_token
                                and self._is_row_due_retry(
                                    prefetched_retries.get(prev_key), now
                                )
                            )
                        if needs_digest:
                            digest_child_ids.update(c.Id for c in bundle.children)

                    raw_snapshots = await batch_snapshots_fn(
                        all_children,
                        now,
                        digest_child_ids=digest_child_ids,
                    )
                    prefetched_snapshots = {
                        cid: _snapshot_activity(snap)
                        for cid, snap in raw_snapshots.items()
                    }

            # Release read transaction after all ORM objects on this page have been snapshotted.
            await self._release_db()

            for bundle, prefs, _zone, _local_now in candidate_entries:
                if max_emails is not None and delivered >= max_emails:
                    break
                if deadline is not None and time.monotonic() >= deadline:
                    break
                remaining_cap = (
                    max(0, max_emails - delivered) if max_emails is not None else None
                )
                delivered += await self._process_parent_bundle(
                    bundle,
                    now,
                    recipient_resolver=memoized_resolver,
                    message_sender=message_sender,
                    effective_prefs=prefs,
                    prefetched_summary=(
                        prefetched_summaries.get(bundle.parent_id)
                        if prefetched_summaries is not None
                        else None
                    ),
                    prefetched_retries=prefetched_retries,
                    prefetched_snapshots=prefetched_snapshots,
                    max_emails_remaining=remaining_cap,
                    deadline=deadline,
                )

            if page_size < batch_limit:
                break
            if last_bundle_created_at is None:
                break
            after_created_at = last_bundle_created_at
            after_id = last_bundle_parent_id

        await self._release_db()
        return delivered

    async def _process_parent_bundle(
        self,
        bundle: ActiveParentBundle,
        now: datetime,
        *,
        recipient_resolver,
        message_sender,
        effective_prefs: EffectiveEmailPreferences | None = None,
        prefetched_summary: ParentDeliverySummary | None = None,
        prefetched_retries: dict[str, object] | None = None,
        prefetched_snapshots: dict[UUID, ChildActivitySnapshot] | None = None,
        max_emails_remaining: int | None = None,
        deadline: float | None = None,
    ) -> int:
        prefs = (
            effective_prefs
            if effective_prefs is not None
            else effective_preferences(bundle.preferences)
        )
        zone = safe_zone(prefs.timezone)
        local_now = now.astimezone(zone)
        if is_in_quiet_hours(local_now.hour, prefs.quiet_hours_start, prefs.quiet_hours_end):
            return 0

        if not (
            prefs.weekly_digest_enabled
            or prefs.inactivity_alert_enabled
            or prefs.milestone_enabled
        ):
            return 0

        if prefetched_summary is not None:
            sent_last_7d = prefetched_summary.automated_sent_last_7d
        else:
            sent_last_7d = await self.repo.count_automated_sent_since(
                bundle.parent_id, now - timedelta(days=7)
            )
        remaining_weekly_budget = prefs.max_emails_per_week - sent_last_7d
        if remaining_weekly_budget <= 0:
            return 0

        if prefetched_snapshots is not None:
            snapshots = [
                prefetched_snapshots[child.Id]
                for child in bundle.children
                if child.Id in prefetched_snapshots
            ]
        else:
            snapshots = [
                _snapshot_activity(
                    await self.repo.get_child_activity_snapshot(child, now)
                )
                for child in bundle.children
            ]

        delivered = 0
        digest_sent_today = False
        iso_year, iso_week, _ = local_now.isocalendar()
        week_token = f"{iso_year}-W{iso_week:02d}"
        yesterday_date = local_now.date() - timedelta(days=1)
        prev_iso_year, prev_iso_week, _ = yesterday_date.isocalendar()
        yesterday_week_token = f"{prev_iso_year}-W{prev_iso_week:02d}"

        def _can_send_more() -> bool:
            if max_emails_remaining is not None and delivered >= max_emails_remaining:
                return False
            if deadline is not None and time.monotonic() >= deadline:
                return False
            return True

        # 1. Weekly Progress Digest (highest signal, at most once/week on chosen weekday,
        # plus clean recovery if a transient failure on digest evening rolls past midnight).
        if prefs.weekly_digest_enabled and remaining_weekly_budget > 0 and _can_send_more():
            digest_key: str | None = None
            digest_week_token = week_token
            digest_end_date = local_now.date()
            current_digest_key = f"weekly_digest:{bundle.parent_id}:{week_token}"
            prev_digest_key = f"weekly_digest:{bundle.parent_id}:{yesterday_week_token}"

            if local_now.weekday() == prefs.digest_weekday:
                if await self._can_attempt_dedupe_key(
                    current_digest_key, now, prefetched_retries=prefetched_retries
                ):
                    digest_key = current_digest_key
            elif await self._has_due_retry(
                current_digest_key, now, prefetched_retries=prefetched_retries
            ):
                digest_key = current_digest_key
            elif (
                yesterday_week_token != week_token
                and await self._has_due_retry(
                    prev_digest_key, now, prefetched_retries=prefetched_retries
                )
            ):
                digest_key = prev_digest_key
                digest_week_token = yesterday_week_token
                digest_end_date = yesterday_date

            if digest_key is not None:
                items = [
                    ChildWeeklyDigestItem(
                        child_alias=snap.child.Alias,
                        sessions_count=len(snap.sessions_last_7d),
                        total_minutes=sum_unique_reading_minutes(
                            snap.sessions_last_7d, now
                        ),
                        prev_sessions_count=snap.sessions_prev_7d_count,
                        avg_fluency_score=snap.avg_fluency_last_7d,
                        goal_summary=_format_goal_summary(snap, now),
                        top_difficult_words=snap.top_difficult_words_last_7d,
                    )
                    for snap in snapshots
                ]
                week_start = (digest_end_date - timedelta(days=6)).strftime("%d/%m")
                week_end = digest_end_date.strftime("%d/%m")
                week_label = f"{week_start}–{week_end}"
                sent = await self._claim_and_send(
                    parent_id=bundle.parent_id,
                    child_id=None,
                    category="WEEKLY_DIGEST",
                    dedupe_key=digest_key,
                    subject=f"Báo cáo đọc sách tuần {week_label} của gia đình trên ViRead",
                    metadata={
                        "week": digest_week_token,
                        "children_count": len(items),
                        "total_sessions": sum(i.sessions_count for i in items),
                    },
                    now=now,
                    recipient_resolver=recipient_resolver,
                    message_sender=message_sender,
                    message_builder=lambda recipient, delivery_id: build_weekly_digest_message(
                        recipient=recipient,
                        parent_name=bundle.display_name,
                        week_label=week_label,
                        items=items,
                        delivery_id=delivery_id,
                    ),
                )
                if sent:
                    delivered += 1
                    remaining_weekly_budget -= 1
                    digest_sent_today = True

        # 2. Milestone Celebration (at most 1/day, deduped forever per milestone)
        if prefs.milestone_enabled and remaining_weekly_budget > 0 and _can_send_more():
            candidate = await self._select_milestone_candidate(
                bundle.parent_id,
                snapshots,
                now,
                local_now.date(),
                zone,
                prefetched_summary=prefetched_summary,
                prefetched_retries=prefetched_retries,
            )
            if candidate is not None:
                child_id, milestone_key, item = candidate
                sent = await self._claim_and_send(
                    parent_id=bundle.parent_id,
                    child_id=child_id,
                    category="MILESTONE",
                    dedupe_key=milestone_key,
                    subject=f"Chúc mừng {item.child_alias}: {item.milestone_label}!",
                    metadata={"milestone_key": milestone_key},
                    now=now,
                    recipient_resolver=recipient_resolver,
                    message_sender=message_sender,
                    message_builder=lambda recipient, delivery_id: build_milestone_message(
                        recipient=recipient,
                        parent_name=bundle.display_name,
                        items=[item],
                        delivery_id=delivery_id,
                    ),
                )
                if sent:
                    delivered += 1
                    remaining_weekly_budget -= 1

        # 3. Long Inactivity Alert (gentle nudge, suppressed on digest day when digest is
        # enabled, suppressed when another email already sent in this pass or digest sent
        # within 24h; stops after 2 unanswered)
        is_digest_day = (
            prefs.weekly_digest_enabled
            and local_now.weekday() == prefs.digest_weekday
        )
        if (
            prefs.inactivity_alert_enabled
            and remaining_weekly_budget > 0
            and not digest_sent_today
            and not is_digest_day
            and delivered == 0
            and _can_send_more()
        ):
            inactivity_items = self._find_inactive_children(
                snapshots, prefs.inactivity_days, local_now.date(), zone
            )
            if inactivity_items and await self._inactivity_allowed(
                bundle.parent_id,
                snapshots,
                now,
                prefetched_summary=prefetched_summary,
            ):
                inactivity_key = f"inactivity:{bundle.parent_id}:{week_token}"
                if await self._can_attempt_dedupe_key(
                    inactivity_key, now, prefetched_retries=prefetched_retries
                ):
                    subject = (
                        f"Nhắc nhẹ: {inactivity_items[0].child_alias} đã {inactivity_items[0].days_inactive} ngày chưa đọc sách trên ViRead"
                        if len(inactivity_items) == 1
                        else "Nhắc nhẹ: Các bé đã vài ngày chưa đọc sách trên ViRead"
                    )
                    sent = await self._claim_and_send(
                        parent_id=bundle.parent_id,
                        child_id=None,
                        category="INACTIVITY_ALERT",
                        dedupe_key=inactivity_key,
                        subject=subject,
                        metadata={
                            "week": week_token,
                            "inactive_children": len(inactivity_items),
                            "max_days_inactive": max(
                                i.days_inactive for i in inactivity_items
                            ),
                        },
                        now=now,
                        recipient_resolver=recipient_resolver,
                        message_sender=message_sender,
                        message_builder=lambda recipient, delivery_id: build_inactivity_alert_message(
                            recipient=recipient,
                            parent_name=bundle.display_name,
                            items=inactivity_items,
                            delivery_id=delivery_id,
                        ),
                    )
                    if sent:
                        delivered += 1

        return delivered

    async def _inactivity_allowed(
        self,
        parent_id: UUID,
        snapshots: list[ChildActivitySnapshot],
        now: datetime,
        *,
        prefetched_summary: ParentDeliverySummary | None = None,
    ) -> bool:
        # Suppress if a weekly digest was sent within the last 24 hours.
        if prefetched_summary is not None:
            last_digest_at = prefetched_summary.last_digest_sent_at
        else:
            last_digest = await self.repo.last_sent_for_category(parent_id, "WEEKLY_DIGEST")
            last_digest_at = last_digest.SentAt if last_digest is not None else None
        if last_digest_at is not None and now - last_digest_at < timedelta(hours=24):
            return False

        # Cooldown: at least 7 days since last inactivity alert.
        if prefetched_summary is not None:
            last_alert_at = prefetched_summary.last_inactivity_sent_at
        else:
            last_alert = await self.repo.last_sent_for_category(
                parent_id, "INACTIVITY_ALERT"
            )
            last_alert_at = last_alert.SentAt if last_alert is not None else None
        if (
            last_alert_at is not None
            and now - last_alert_at < timedelta(days=INACTIVITY_COOLDOWN_DAYS)
        ):
            return False

        # Stop nagging after 2 consecutive unanswered inactivity alerts since latest reading session.
        if prefetched_summary is not None and last_alert_at is None:
            return True
        latest_family_activity = max(
            (s.last_session_at for s in snapshots if s.last_session_at is not None),
            default=None,
        )
        unanswered = await self.repo.count_inactivity_alerts_since(
            parent_id, latest_family_activity
        )
        return unanswered < MAX_CONSECUTIVE_UNANSWERED_INACTIVITY_ALERTS

    @staticmethod
    def _find_inactive_children(
        snapshots: list[ChildActivitySnapshot],
        threshold_days: int,
        local_today: date,
        zone: ZoneInfo,
    ) -> list[ChildInactivityItem]:
        inactive: list[ChildInactivityItem] = []
        for snap in snapshots:
            if snap.last_session_at is not None:
                last_date = snap.last_session_at.astimezone(zone).date()
                days_inactive = (local_today - last_date).days
                had_prior = True
            else:
                created_at = snap.child.CreatedAt
                if created_at is None:
                    continue
                created_date = created_at.astimezone(zone).date()
                days_inactive = (local_today - created_date).days
                had_prior = False
            if days_inactive >= threshold_days:
                inactive.append(
                    ChildInactivityItem(
                        child_alias=snap.child.Alias,
                        days_inactive=days_inactive,
                        had_prior_sessions=had_prior,
                    )
                )
        return inactive

    async def _select_milestone_candidate(
        self,
        parent_id: UUID,
        snapshots: list[ChildActivitySnapshot],
        now: datetime,
        local_today: date,
        zone: ZoneInfo,
        *,
        prefetched_summary: ParentDeliverySummary | None = None,
        prefetched_retries: dict[str, object] | None = None,
    ) -> tuple[UUID, str, ChildMilestoneItem] | None:
        if prefetched_summary is not None:
            last_milestone_at = prefetched_summary.last_milestone_sent_at
        else:
            last_milestone = await self.repo.last_sent_for_category(parent_id, "MILESTONE")
            last_milestone_at = (
                last_milestone.SentAt if last_milestone is not None else None
            )
        if (
            last_milestone_at is not None
            and now - last_milestone_at < timedelta(hours=MILESTONE_COOLDOWN_HOURS)
        ):
            return None

        candidates: list[tuple[int, UUID, str, ChildMilestoneItem]] = []
        for snap in snapshots:
            session_dates = [
                s.StartedAt.astimezone(zone).date()
                for s in snap.sessions_last_35d
                if s.StartedAt is not None
            ]
            streak = compute_reading_streak_days(session_dates, local_today)
            for milestone_days in STREAK_MILESTONES:
                if streak >= milestone_days:
                    key = f"milestone:{snap.child.Id}:STREAK_{milestone_days}"
                    candidates.append(
                        (
                            100 + milestone_days,
                            snap.child.Id,
                            key,
                            ChildMilestoneItem(
                                child_alias=snap.child.Alias,
                                milestone_label=f"Chuỗi {milestone_days} ngày đọc liên tiếp",
                                detail=(
                                    f"{snap.child.Alias} đã duy trì đọc sách đều đặn "
                                    f"{streak} ngày liên tiếp trên ViRead."
                                ),
                            ),
                        )
                    )
                    break

            for goal in snap.active_goals:
                try:
                    window = goal_cycle_window(goal, now)
                except (ZoneInfoNotFoundError, ValueError):
                    continue
                if window is None:
                    continue
                starts_at, ends_at = window
                value = completed_metric(
                    snap.sessions_last_35d, goal.Metric, now, starts_at, ends_at
                )
                if value >= goal.TargetValue:
                    cycle_day = starts_at.astimezone(zone).date().isoformat()
                    key = f"milestone:{goal.Id}:GOAL:{cycle_day}"
                    unit = "phút" if goal.Metric == "MINUTES" else "buổi đọc"
                    period_text = "hôm nay" if goal.Period == "DAILY" else "tuần này"
                    candidates.append(
                        (
                            80,
                            snap.child.Id,
                            key,
                            ChildMilestoneItem(
                                child_alias=snap.child.Alias,
                                milestone_label=f"Hoàn thành mục tiêu {period_text}",
                                detail=(
                                    f"{snap.child.Alias} đã đạt {value}/{goal.TargetValue} "
                                    f"{unit} cho mục tiêu đọc {period_text}."
                                ),
                            ),
                        )
                    )

            first_completed_at = snap.first_completed_session_at
            if (
                first_completed_at is None
                and snap.total_completed_sessions == 1
                and snap.sessions_last_7d
            ):
                first_completed_at = snap.sessions_last_7d[0].EndedAt
            if (
                snap.total_completed_sessions >= 1
                and first_completed_at is not None
                and now - first_completed_at <= timedelta(hours=FIRST_SESSION_WINDOW_HOURS)
            ):
                key = f"milestone:{snap.child.Id}:FIRST_SESSION"
                candidates.append(
                    (
                        60,
                        snap.child.Id,
                        key,
                        ChildMilestoneItem(
                            child_alias=snap.child.Alias,
                            milestone_label="Hoàn thành buổi đọc đầu tiên",
                            detail=(
                                f"{snap.child.Alias} vừa hoàn thành buổi đọc đầu tiên trên ViRead. "
                                "Khởi đầu thật tuyệt vời!"
                            ),
                        ),
                    )
                )

        # Highest priority first; allow new milestones or due retries.
        for _priority, child_id, key, item in sorted(
            candidates, key=lambda entry: entry[0], reverse=True
        ):
            if await self._can_attempt_dedupe_key(
                key, now, prefetched_retries=prefetched_retries
            ):
                return child_id, key, item
        return None

    async def _claim_and_send(
        self,
        *,
        parent_id: UUID,
        child_id: UUID | None,
        category: str,
        dedupe_key: str,
        subject: str,
        metadata: dict[str, object],
        now: datetime,
        recipient_resolver,
        message_sender,
        message_builder,
    ) -> bool:
        await self._release_db()
        try:
            recipient = await recipient_resolver(parent_id)
        except ParentEmailUnavailable:
            return False
        except ParentEmailLookupFailed as error:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_notification_recipient_lookup_failed",
                stage="parent_email_lookup",
                exception=error,
                category=category,
            )
            return False

        claim_fn = getattr(self.repo, "claim_or_retry_delivery", None)
        if claim_fn is not None:
            delivery = await claim_fn(
                parent_id=parent_id,
                child_id=child_id,
                category=category,
                dedupe_key=dedupe_key,
                subject=subject,
                metadata=metadata,
                now=now,
                max_attempts=MAX_DELIVERY_ATTEMPTS,
            )
        else:
            delivery = await self.repo.insert_and_claim_delivery(
                parent_id=parent_id,
                child_id=child_id,
                category=category,
                dedupe_key=dedupe_key,
                subject=subject,
                metadata=metadata,
                now=now,
            )
        if delivery is None:
            return False

        delivery_id = delivery.Id
        attempts = int(getattr(delivery, "Attempts", 1) or 1)
        await self._release_db()

        message = message_builder(recipient, delivery_id)
        try:
            await asyncio.to_thread(message_sender, message)
        except EmailDeliveryNotConfigured:
            await self.repo.finish_delivery(
                delivery_id, status="FAILED", now=now, error_code="EMAIL_NOT_CONFIGURED"
            )
            return False
        except EmailTransportRetryable as error:
            terminal = attempts >= MAX_DELIVERY_ATTEMPTS
            backoff_minutes = 15 * (2 ** max(0, attempts - 1))
            await self.repo.finish_delivery(
                delivery_id,
                status="FAILED" if terminal else "RETRY",
                now=now,
                error_code="EMAIL_PROVIDER_UNAVAILABLE",
                next_attempt_at=(
                    None if terminal else now + timedelta(minutes=backoff_minutes)
                ),
            )
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_notification_email_retryable_failure",
                stage="email_delivery",
                exception=error,
                category=category,
                attempt=attempts,
                terminal=terminal,
            )
            return False
        except Exception as error:
            code = (
                "EMAIL_PROVIDER_REJECTED"
                if isinstance(error, EmailTransportPermanent)
                else "DELIVERY_FAILED"
            )
            await self.repo.finish_delivery(
                delivery_id, status="FAILED", now=now, error_code=code
            )
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_notification_email_failed",
                stage="email_delivery",
                exception=error,
                category=category,
                error_code=code,
            )
            return False

        await self.repo.finish_delivery(delivery_id, status="SENT", now=now)
        return True
