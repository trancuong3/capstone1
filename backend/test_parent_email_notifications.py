"""Comprehensive unit & HTTP contract tests for ViRead parent email automation."""

from __future__ import annotations

import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from email import message_from_bytes, policy as email_policy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test"
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import deps
from app.api.routes import parent_notifications as route
from app.providers import parent_email_transport as transport
from app.repositories.parent_email_notification_repository import (
    ActiveParentBundle,
    ChildActivitySnapshot,
)
from app.schemas.parent_email_notification import ParentEmailPreferencesUpdate
from app.services import runtime_diagnostics
from app.services.parent_email_notification_service import (
    ParentEmailNotificationService,
    ParentNotificationError,
    compute_reading_streak_days,
    is_in_quiet_hours,
)
from app.jobs.reading_reminder_worker import ParentEmailUnavailable

PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
CHILD_A_ID = UUID("22222222-2222-4222-8222-222222222222")
CHILD_B_ID = UUID("33333333-3333-4333-8333-333333333333")
# Sunday 2026-11-29 09:00 Asia/Ho_Chi_Minh == 02:00 UTC
SUNDAY_MORNING_UTC = datetime(2026, 11, 29, 2, 0, tzinfo=timezone.utc)
# Monday 2026-11-30 09:00 Asia/Ho_Chi_Minh == 02:00 UTC
MONDAY_MORNING_UTC = datetime(2026, 11, 30, 2, 0, tzinfo=timezone.utc)
# Sunday 2026-11-29 22:30 Asia/Ho_Chi_Minh == 15:30 UTC (quiet hours)
SUNDAY_NIGHT_UTC = datetime(2026, 11, 29, 15, 30, tzinfo=timezone.utc)


def make_child(child_id: UUID, alias: str, created_days_ago: int = 20):
    return SimpleNamespace(
        Id=child_id,
        ParentId=PARENT_ID,
        Alias=alias,
        CreatedAt=SUNDAY_MORNING_UTC - timedelta(days=created_days_ago),
    )


def make_session(started_at: datetime, duration_minutes: int = 12):
    return SimpleNamespace(
        Id=uuid4(),
        State="COMPLETED",
        StartedAt=started_at,
        EndedAt=started_at + timedelta(minutes=duration_minutes),
    )


def make_prefs(**overrides):
    defaults = dict(
        ParentId=PARENT_ID,
        WeeklyDigestEnabled=True,
        InactivityAlertEnabled=True,
        InactivityDays=5,
        MilestoneEnabled=True,
        DigestWeekday=6,
        Timezone="Asia/Ho_Chi_Minh",
        QuietHoursStart=21,
        QuietHoursEnd=7,
        MaxEmailsPerWeek=4,
        UpdatedAt=SUNDAY_MORNING_UTC,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class FakeNotificationRepo:
    def __init__(
        self,
        *,
        bundles: list[ActiveParentBundle] | None = None,
        snapshots: dict[UUID, ChildActivitySnapshot] | None = None,
        prefs=None,
    ) -> None:
        self.bundles = bundles or []
        self.snapshots = snapshots or {}
        self.prefs = prefs
        self.deliveries: list[SimpleNamespace] = []
        self.profile = SimpleNamespace(Id=PARENT_ID, DisplayName="Mẹ Lan", Active=1)

    async def get_preferences(self, _parent_id: UUID):
        return self.prefs

    async def get_profile(self, _parent_id: UUID):
        return self.profile

    async def upsert_preferences(self, parent_id: UUID, values: dict, now: datetime):
        base = self.prefs or make_prefs(ParentId=parent_id)
        for key, value in values.items():
            setattr(base, key, value)
        base.UpdatedAt = now
        self.prefs = base
        return base

    async def list_recent_deliveries(self, parent_id: UUID, *, limit: int = 10):
        matching = [d for d in self.deliveries if d.ParentId == parent_id]
        return list(reversed(matching))[:limit]

    async def count_automated_sent_since(self, parent_id: UUID, since: datetime) -> int:
        return sum(
            1
            for d in self.deliveries
            if d.ParentId == parent_id
            and d.Category in ("WEEKLY_DIGEST", "INACTIVITY_ALERT", "MILESTONE")
            and d.Status in ("SENDING", "SENT")
            and d.CreatedAt >= since
        )

    async def last_sent_for_category(self, parent_id: UUID, category: str):
        matching = [
            d
            for d in self.deliveries
            if d.ParentId == parent_id
            and d.Category == category
            and d.Status == "SENT"
        ]
        if not matching:
            return None
        return max(matching, key=lambda d: d.SentAt or d.CreatedAt)

    async def count_inactivity_alerts_since(
        self, parent_id: UUID, since: datetime | None
    ) -> int:
        return sum(
            1
            for d in self.deliveries
            if d.ParentId == parent_id
            and d.Category == "INACTIVITY_ALERT"
            and d.Status == "SENT"
            and (since is None or (d.SentAt is not None and d.SentAt >= since))
        )

    async def is_storage_ready(self) -> bool:
        return True

    async def recover_stale_sending(
        self, now: datetime, *, stale_after: timedelta
    ) -> int:
        cutoff = now - stale_after
        recovered = 0
        for row in self.deliveries:
            if row.Status == "SENDING" and (
                row.LastAttemptAt is None or row.LastAttemptAt <= cutoff
            ):
                row.Status = "FAILED"
                row.ErrorCode = "UNKNOWN_DELIVERY"
                row.NextAttemptAt = None
                recovered += 1
        return recovered

    async def get_delivery_by_dedupe_key(self, dedupe_key: str):
        for row in self.deliveries:
            if row.DedupeKey == dedupe_key:
                return row
        return None

    async def delivery_exists(self, dedupe_key: str) -> bool:
        return (await self.get_delivery_by_dedupe_key(dedupe_key)) is not None

    async def insert_and_claim_delivery(
        self,
        *,
        parent_id: UUID,
        child_id: UUID | None,
        category: str,
        dedupe_key: str,
        subject: str,
        metadata: dict,
        now: datetime,
    ):
        if any(d.DedupeKey == dedupe_key for d in self.deliveries):
            return None
        row = SimpleNamespace(
            Id=uuid4(),
            ParentId=parent_id,
            ChildId=child_id,
            Category=category,
            DedupeKey=dedupe_key,
            Status="SENDING",
            Subject=subject,
            Attempts=1,
            LastAttemptAt=now,
            NextAttemptAt=None,
            SentAt=None,
            ErrorCode=None,
            Metadata=metadata,
            CreatedAt=now,
        )
        self.deliveries.append(row)
        return row

    async def claim_or_retry_delivery(
        self,
        *,
        parent_id: UUID,
        child_id: UUID | None,
        category: str,
        dedupe_key: str,
        subject: str,
        metadata: dict,
        now: datetime,
        max_attempts: int = 3,
    ):
        existing = await self.get_delivery_by_dedupe_key(dedupe_key)
        if existing is None:
            return await self.insert_and_claim_delivery(
                parent_id=parent_id,
                child_id=child_id,
                category=category,
                dedupe_key=dedupe_key,
                subject=subject,
                metadata=metadata,
                now=now,
            )
        if (
            existing.Status == "RETRY"
            and existing.Attempts < max_attempts
            and (existing.NextAttemptAt is None or existing.NextAttemptAt <= now)
        ):
            existing.Status = "SENDING"
            existing.Attempts += 1
            existing.LastAttemptAt = now
            existing.NextAttemptAt = None
            existing.Subject = subject[:200]
            existing.Metadata = metadata
            return existing
        return None

    async def finish_delivery(
        self,
        delivery_id: UUID,
        *,
        status: str,
        now: datetime,
        error_code: str | None = None,
        next_attempt_at: datetime | None = None,
    ) -> None:
        for row in self.deliveries:
            if row.Id == delivery_id:
                row.Status = status
                row.ErrorCode = error_code
                row.NextAttemptAt = next_attempt_at
                if status == "SENT":
                    row.SentAt = now
                return

    async def list_active_parents_with_children(
        self,
        *,
        limit: int = 200,
        after_created_at: datetime | None = None,
        after_id: UUID | None = None,
    ):
        ordered = sorted(
            self.bundles,
            key=lambda b: (b.created_at or datetime.min.replace(tzinfo=timezone.utc), b.parent_id),
        )
        if after_created_at is not None and after_id is not None:
            ordered = [
                b
                for b in ordered
                if b.created_at is not None
                and (
                    b.created_at > after_created_at
                    or (b.created_at == after_created_at and b.parent_id > after_id)
                )
            ]
        return ordered[:limit]

    async def get_child_activity_snapshot(self, child, _now: datetime):
        return self.snapshots[child.Id]


async def verified_parent(_parent_id: UUID) -> str:
    return "parent@example.test"


class PureRuleTests(unittest.TestCase):
    def test_quiet_hours_overnight_daytime_and_disabled(self):
        self.assertTrue(is_in_quiet_hours(21, 21, 7))
        self.assertTrue(is_in_quiet_hours(23, 21, 7))
        self.assertTrue(is_in_quiet_hours(0, 21, 7))
        self.assertTrue(is_in_quiet_hours(6, 21, 7))
        self.assertFalse(is_in_quiet_hours(7, 21, 7))
        self.assertFalse(is_in_quiet_hours(14, 21, 7))
        self.assertFalse(is_in_quiet_hours(20, 21, 7))
        # Daytime window
        self.assertTrue(is_in_quiet_hours(13, 12, 14))
        self.assertFalse(is_in_quiet_hours(14, 12, 14))
        # Equal start/end disables quiet hours
        self.assertFalse(is_in_quiet_hours(22, 0, 0))

    def test_reading_streak_counts_consecutive_days_ending_today_or_yesterday(self):
        today = date(2026, 11, 29)
        days = [today - timedelta(days=offset) for offset in range(7)]
        self.assertEqual(compute_reading_streak_days(days, today), 7)
        # Missing today, still counts streak ending yesterday
        self.assertEqual(compute_reading_streak_days(days[1:], today), 6)
        # Gap of 2 days resets streak to 0
        self.assertEqual(compute_reading_streak_days([today - timedelta(days=2)], today), 0)
        self.assertEqual(compute_reading_streak_days([], today), 0)

    def test_preferences_schema_forbids_unknown_fields_and_bad_timezone(self):
        with self.assertRaises(ValidationError):
            ParentEmailPreferencesUpdate(email="evil@example.test")
        with self.assertRaises(ValidationError):
            ParentEmailPreferencesUpdate(timezone="Mars/Olympus")
        valid = ParentEmailPreferencesUpdate(
            inactivity_days=7,
            max_emails_per_week=3,
            timezone="Asia/Ho_Chi_Minh",
        )
        self.assertEqual(valid.inactivity_days, 7)


class ScenarioAndAntiSpamTests(unittest.IsolatedAsyncioTestCase):
    async def test_weekly_digest_sends_once_on_sunday_and_suppresses_inactivity_same_day(self):
        child = make_child(CHILD_A_ID, "Bé An")
        bundle = ActiveParentBundle(
            parent_id=PARENT_ID,
            display_name="Mẹ Lan",
            children=(child,),
            preferences=make_prefs(DigestWeekday=6),
        )
        snap = ChildActivitySnapshot(
            child=child,
            sessions_last_7d=(),
            sessions_prev_7d_count=2,
            sessions_last_35d=(),
            total_completed_sessions=2,
            last_session_at=SUNDAY_MORNING_UTC - timedelta(days=9),
            avg_fluency_last_7d=None,
            top_difficult_words_last_7d=("nghiêng",),
            active_goals=(),
        )
        repo = FakeNotificationRepo(bundles=[bundle], snapshots={child.Id: snap})
        sent_messages = []

        def fake_send(msg):
            sent_messages.append(msg)
            return "resend"

        service = ParentEmailNotificationService(repo)
        with patch.object(
            transport, "parent_email_delivery_is_configured", return_value=True
        ), patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ), patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            first = await service.dispatch_engagement_emails(
                SUNDAY_MORNING_UTC,
                recipient_resolver=verified_parent,
                message_sender=fake_send,
            )
            # Re-running the same Sunday must be 100% idempotent (0 new emails)
            second = await service.dispatch_engagement_emails(
                SUNDAY_MORNING_UTC + timedelta(hours=2),
                recipient_resolver=verified_parent,
                message_sender=fake_send,
            )

        self.assertEqual(first, 1)
        self.assertEqual(second, 0)
        self.assertEqual(len(sent_messages), 1)
        self.assertEqual(repo.deliveries[0].Category, "WEEKLY_DIGEST")
        self.assertIn("Bé An", sent_messages[0].get_body(preferencelist=("plain",)).get_content())

    async def test_quiet_hours_block_all_automated_engagement_emails(self):
        child = make_child(CHILD_A_ID, "Bé An")
        bundle = ActiveParentBundle(
            parent_id=PARENT_ID,
            display_name="Mẹ Lan",
            children=(child,),
            preferences=make_prefs(QuietHoursStart=21, QuietHoursEnd=7),
        )
        snap = ChildActivitySnapshot(
            child=child,
            sessions_last_7d=(make_session(SUNDAY_NIGHT_UTC - timedelta(hours=3)),),
            sessions_prev_7d_count=0,
            sessions_last_35d=(make_session(SUNDAY_NIGHT_UTC - timedelta(hours=3)),),
            total_completed_sessions=1,
            last_session_at=SUNDAY_NIGHT_UTC - timedelta(hours=3),
            avg_fluency_last_7d=88.0,
            top_difficult_words_last_7d=(),
            active_goals=(),
        )
        repo = FakeNotificationRepo(bundles=[bundle], snapshots={child.Id: snap})
        sent = []
        service = ParentEmailNotificationService(repo)
        with patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ):
            count = await service.dispatch_engagement_emails(
                SUNDAY_NIGHT_UTC,
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "smtp",
            )
        self.assertEqual(count, 0)
        self.assertEqual(sent, [])

    async def test_inactivity_groups_children_and_stops_after_two_unanswered_alerts(self):
        child_a = make_child(CHILD_A_ID, "Bé An")
        child_b = make_child(CHILD_B_ID, "Bé Bo")
        last_read = MONDAY_MORNING_UTC - timedelta(days=8)
        bundle = ActiveParentBundle(
            parent_id=PARENT_ID,
            display_name="Mẹ Lan",
            children=(child_a, child_b),
            preferences=make_prefs(InactivityDays=5, DigestWeekday=6),
        )
        snapshots = {
            child_a.Id: ChildActivitySnapshot(
                child=child_a,
                sessions_last_7d=(),
                sessions_prev_7d_count=1,
                sessions_last_35d=(),
                total_completed_sessions=3,
                last_session_at=last_read,
                avg_fluency_last_7d=None,
                top_difficult_words_last_7d=(),
                active_goals=(),
            ),
            child_b.Id: ChildActivitySnapshot(
                child=child_b,
                sessions_last_7d=(),
                sessions_prev_7d_count=1,
                sessions_last_35d=(),
                total_completed_sessions=2,
                last_session_at=last_read - timedelta(days=2),
                avg_fluency_last_7d=None,
                top_difficult_words_last_7d=(),
                active_goals=(),
            ),
        }
        repo = FakeNotificationRepo(bundles=[bundle], snapshots=snapshots)
        sent = []
        service = ParentEmailNotificationService(repo)

        with patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ), patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            # Week 1 Monday -> sends 1 grouped family email
            c1 = await service.dispatch_engagement_emails(
                MONDAY_MORNING_UTC,
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )
            # 3 days later -> blocked by 7-day cooldown
            c_cooldown = await service.dispatch_engagement_emails(
                MONDAY_MORNING_UTC + timedelta(days=3),
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )
            # Week 2 Monday (8 days later) -> sends 2nd unanswered alert
            c2 = await service.dispatch_engagement_emails(
                MONDAY_MORNING_UTC + timedelta(days=8),
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )
            # Week 3 Monday (16 days later) -> STOPS because 2 unanswered alerts already sent!
            c3 = await service.dispatch_engagement_emails(
                MONDAY_MORNING_UTC + timedelta(days=16),
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )

        self.assertEqual((c1, c_cooldown, c2, c3), (1, 0, 1, 0))
        self.assertEqual(len(sent), 2)
        body = sent[0].get_body(preferencelist=("plain",)).get_content()
        self.assertIn("Bé An", body)
        self.assertIn("Bé Bo", body)

    async def test_milestone_streak_celebrated_once_and_respects_weekly_cap(self):
        child = make_child(CHILD_A_ID, "Bé An")
        # 7 consecutive days ending Monday morning
        sessions = tuple(
            make_session(MONDAY_MORNING_UTC - timedelta(days=offset, hours=1))
            for offset in range(7)
        )
        bundle = ActiveParentBundle(
            parent_id=PARENT_ID,
            display_name="Mẹ Lan",
            children=(child,),
            preferences=make_prefs(MaxEmailsPerWeek=1, DigestWeekday=6),
        )
        snap = ChildActivitySnapshot(
            child=child,
            sessions_last_7d=sessions,
            sessions_prev_7d_count=3,
            sessions_last_35d=sessions,
            total_completed_sessions=10,
            last_session_at=sessions[0].StartedAt,
            avg_fluency_last_7d=91.5,
            top_difficult_words_last_7d=(),
            active_goals=(),
        )
        repo = FakeNotificationRepo(bundles=[bundle], snapshots={child.Id: snap})
        sent = []
        service = ParentEmailNotificationService(repo)
        with patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ), patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            first = await service.dispatch_engagement_emails(
                MONDAY_MORNING_UTC,
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )
            # Same milestone next day -> deduped AND weekly cap = 1 reached
            second = await service.dispatch_engagement_emails(
                MONDAY_MORNING_UTC + timedelta(days=1),
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )
        self.assertEqual((first, second), (1, 0))
        self.assertEqual(repo.deliveries[0].Category, "MILESTONE")
        self.assertIn("7 ngày", sent[0]["Subject"])

    async def test_test_email_writes_to_mail_sink_and_enforces_cooldown(self):
        repo = FakeNotificationRepo()
        service = ParentEmailNotificationService(repo)
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(transport.settings, "PARENT_EMAIL_MAIL_SINK_DIR", folder):
                res = await service.send_test_email(
                    PARENT_ID,
                    now=MONDAY_MORNING_UTC,
                    recipient_resolver=verified_parent,
                )
                self.assertEqual(res.status, "SENT")
                self.assertEqual(res.provider, "mail_sink")
                files = list(Path(folder).glob("*.eml"))
                self.assertEqual(len(files), 1)
                parsed = message_from_bytes(
                    files[0].read_bytes(), policy=email_policy.default
                )
                self.assertIn("List-Unsubscribe", parsed)
                self.assertEqual(parsed["To"], "parent@example.test")

                # Second test email within 5 minutes is rate-limited
                with self.assertRaises(ParentNotificationError) as err:
                    await service.send_test_email(
                        PARENT_ID,
                        now=MONDAY_MORNING_UTC + timedelta(seconds=60),
                        recipient_resolver=verified_parent,
                    )
                self.assertEqual(err.exception.code, "TEST_EMAIL_RATE_LIMITED")
                self.assertEqual(err.exception.status_code, 429)

    async def test_test_email_rejects_unverified_parent_email(self):
        repo = FakeNotificationRepo()
        service = ParentEmailNotificationService(repo)

        async def unverified(_pid: UUID) -> str:
            raise ParentEmailUnavailable()

        with patch(
            "app.services.parent_email_notification_service.active_email_provider",
            return_value="resend",
        ):
            with self.assertRaises(ParentNotificationError) as err:
                await service.send_test_email(
                    PARENT_ID, now=MONDAY_MORNING_UTC, recipient_resolver=unverified
                )
        self.assertEqual(err.exception.code, "PARENT_EMAIL_UNVERIFIED")
        self.assertEqual(err.exception.status_code, 409)


class TransportAndHealthTests(unittest.TestCase):
    def test_html_template_escapes_user_provided_alias(self):
        with patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            msg = transport.build_inactivity_alert_message(
                recipient="parent@example.test",
                parent_name="<b>Mẹ</b>",
                items=[
                    transport.ChildInactivityItem(
                        child_alias='<script>alert("x")</script>',
                        days_inactive=6,
                        had_prior_sessions=True,
                    )
                ],
                delivery_id=uuid4(),
            )
        html_body = msg.get_body(preferencelist=("html",)).get_content()
        self.assertNotIn("<script>", html_body)
        self.assertIn("&lt;script&gt;", html_body)

    def test_resend_transport_classifies_429_retryable_and_422_permanent(self):
        with patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            msg = transport.build_test_email_message(
                recipient="parent@example.test",
                parent_name="Mẹ Lan",
                delivery_id=uuid4(),
            )

        def fake_client(status_code: int):
            client_instance = MagicMock()
            client_instance.__enter__.return_value = client_instance
            client_instance.post.return_value = SimpleNamespace(status_code=status_code)
            return client_instance

        with patch.object(transport.settings, "RESEND_API_KEY", "re_test_key"):
            with patch.object(transport.httpx, "Client", return_value=fake_client(200)):
                transport._send_via_resend(msg)
            with patch.object(transport.httpx, "Client", return_value=fake_client(429)):
                with self.assertRaises(transport.EmailTransportRetryable):
                    transport._send_via_resend(msg)
            with patch.object(transport.httpx, "Client", return_value=fake_client(422)):
                with self.assertRaises(transport.EmailTransportPermanent):
                    transport._send_via_resend(msg)

    def test_admin_health_reports_email_delivery_status_without_leaking_secrets(self):
        with patch.object(transport, "active_email_provider", return_value="unconfigured"):
            item = runtime_diagnostics.collect_email_delivery_health()
            self.assertEqual(item["status"], "UNAVAILABLE")
            self.assertEqual(item["detail_status"], "disabled")

        with patch.object(transport, "active_email_provider", return_value="resend"), patch.object(
            runtime_diagnostics, "SUPABASE_ADMIN_KEY", "secret-key-should-not-leak"
        ), patch.object(transport.settings, "APP_ENVIRONMENT", "production"), patch.object(
            transport.settings, "PARENT_EMAIL_APP_URL", "http://localhost:3000"
        ):
            item = runtime_diagnostics.collect_email_delivery_health()
            self.assertEqual(item["status"], "DEGRADED")
            self.assertEqual(item["detail_status"], "unknown")
            self.assertNotIn("secret-key-should-not-leak", str(item))


class RouteSecurityTests(unittest.TestCase):
    def make_client(self, actor: UUID | None = PARENT_ID, repo=None):
        repo = repo or FakeNotificationRepo()
        service = ParentEmailNotificationService(repo)
        app = FastAPI()
        app.include_router(route.router, prefix="/parent-notifications")
        app.dependency_overrides[deps.get_db] = lambda: None
        if actor is not None:
            app.dependency_overrides[deps.require_parent_id] = lambda: actor
        patcher = patch.object(route, "build_service", lambda _db: service)
        patcher.start()
        self.addCleanup(patcher.stop)
        return TestClient(app), repo

    def test_cron_dispatch_fails_closed_without_valid_secret(self):
        client, _ = self.make_client(actor=None)
        with patch.object(route.settings, "PARENT_EMAIL_CRON_SECRET", None):
            resp = client.post("/parent-notifications/cron/dispatch")
            self.assertEqual(resp.status_code, 503)

        secret = "super-secret-cron-token-123456"
        with patch.object(route.settings, "PARENT_EMAIL_CRON_SECRET", secret):
            missing = client.post("/parent-notifications/cron/dispatch")
            self.assertEqual(missing.status_code, 401)
            wrong = client.post(
                "/parent-notifications/cron/dispatch",
                headers={"X-Cron-Secret": "wrong-secret"},
            )
            self.assertEqual(wrong.status_code, 401)

            fake_summary = {
                "scope": "all",
                "delivery_configured": True,
                "delivery_provider": "resend",
                "presence_sent": 0,
                "reminders_sent": 2,
                "engagement_sent": 1,
                "checked_at": MONDAY_MORNING_UTC,
            }
            with patch.object(
                route, "dispatch_all_once", new=AsyncMock(return_value=fake_summary)
            ):
                ok_header = client.post(
                    "/parent-notifications/cron/dispatch",
                    headers={"X-Cron-Secret": secret},
                )
                self.assertEqual(ok_header.status_code, 200)
                self.assertEqual(ok_header.json()["reminders_sent"], 2)

                ok_bearer = client.post(
                    "/parent-notifications/cron/dispatch?scope=engagement",
                    headers={"Authorization": f"Bearer {secret}"},
                )
                self.assertEqual(ok_bearer.status_code, 200)

    def test_parent_preferences_get_and_put_roundtrip(self):
        client, _ = self.make_client()
        got = client.get("/parent-notifications/preferences")
        self.assertEqual(got.status_code, 200)
        self.assertTrue(got.json()["weekly_digest_enabled"])
        self.assertEqual(got.json()["inactivity_days"], 5)

        updated = client.put(
            "/parent-notifications/preferences",
            json={
                "weekly_digest_enabled": False,
                "inactivity_days": 7,
                "max_emails_per_week": 2,
            },
        )
        self.assertEqual(updated.status_code, 200)
        self.assertFalse(updated.json()["weekly_digest_enabled"])
        self.assertEqual(updated.json()["inactivity_days"], 7)
        self.assertEqual(updated.json()["max_emails_per_week"], 2)

    def test_pre_migration_storage_degrades_gracefully_across_settings_routes(self):
        class UnmigratedRepo(FakeNotificationRepo):
            async def is_storage_ready(self) -> bool:
                return False

            async def get_preferences(self, _parent_id: UUID):
                raise AssertionError("get_preferences must not query missing table")

            async def upsert_preferences(self, _parent_id: UUID, _values: dict, _now: datetime):
                raise AssertionError("upsert_preferences must not query missing table")

            async def list_recent_deliveries(self, _parent_id: UUID, *, limit: int = 10):
                raise AssertionError("list_recent_deliveries must not query missing table")

            async def last_sent_for_category(self, _parent_id: UUID, _category: str):
                raise AssertionError("last_sent_for_category must not query missing table")

        client, _ = self.make_client(repo=UnmigratedRepo())
        with patch(
            "app.services.parent_email_notification_service.parent_email_automation_readiness",
            return_value=(True, "resend", "READY"),
        ):
            prefs_resp = client.get("/parent-notifications/preferences")
            self.assertEqual(prefs_resp.status_code, 200)
            body = prefs_resp.json()
            self.assertTrue(body["weekly_digest_enabled"])
            self.assertEqual(body["inactivity_days"], 5)
            self.assertFalse(body["delivery_configured"])
            self.assertEqual(body["delivery_provider"], "resend")

            hist_resp = client.get("/parent-notifications/history")
            self.assertEqual(hist_resp.status_code, 200)
            self.assertEqual(hist_resp.json(), [])

            put_resp = client.put(
                "/parent-notifications/preferences",
                json={"weekly_digest_enabled": False},
            )
            self.assertEqual(put_resp.status_code, 503)
            self.assertEqual(
                put_resp.json()["detail"]["code"], "EMAIL_STORAGE_NOT_MIGRATED"
            )

            test_resp = client.post("/parent-notifications/test-email")
            self.assertEqual(test_resp.status_code, 503)
            self.assertEqual(
                test_resp.json()["detail"]["code"], "EMAIL_STORAGE_NOT_MIGRATED"
            )


class RobustnessAndRegressionTests(unittest.IsolatedAsyncioTestCase):
    def test_display_name_from_address_never_corrupts_headers(self):
        with patch.object(
            transport.settings,
            "EMAIL_FROM_ADDRESS",
            "ViRead <noreply@viread.app>",
        ):
            msg = transport.build_test_email_message(
                recipient="parent@example.test",
                parent_name="Mẹ Lan",
                delivery_id=uuid4(),
            )
        self.assertEqual(msg["From"], "ViRead <noreply@viread.app>")
        self.assertTrue(msg["Message-ID"].endswith("@viread.app>"))
        self.assertNotIn(">>", msg["Message-ID"])

    def test_presence_and_reminder_messages_use_email_from_address_on_resend(self):
        from app.providers import reading_presence_email_provider as presence_provider
        from app.providers import reading_reminder_email_provider as reminder_provider

        with patch.object(presence_provider, "SMTP_FROM_EMAIL", None), patch.object(
            reminder_provider, "SMTP_FROM_EMAIL", None
        ), patch.object(
            transport.settings, "EMAIL_FROM_ADDRESS", "ViRead <noreply@viread.app>"
        ):
            p_msg = presence_provider.build_presence_message(
                recipient="parent@example.test",
                child_alias="Bé An",
                alert_id=uuid4(),
            )
            r_msg = reminder_provider.build_reading_reminder_message(
                recipient="parent@example.test",
                child_alias="Bé An",
                local_date="2026-11-29",
                local_time="19:00",
                timezone_name="Asia/Ho_Chi_Minh",
                occurrence_id=uuid4(),
            )
        self.assertEqual(p_msg["From"], "ViRead <noreply@viread.app>")
        self.assertNotIn("viread@localhost", p_msg["From"])
        self.assertTrue(p_msg["Message-ID"].endswith("@viread.app>"))
        self.assertNotIn(">>", p_msg["Message-ID"])
        self.assertEqual(r_msg["From"], "ViRead <noreply@viread.app>")
        self.assertTrue(r_msg["Message-ID"].endswith("@viread.app>"))
        self.assertNotIn(">>", r_msg["Message-ID"])

    def test_all_email_providers_apply_email_from_name_to_bare_sender_address(self):
        from app.providers import reading_presence_email_provider as presence_provider
        from app.providers import reading_reminder_email_provider as reminder_provider

        with patch.object(presence_provider, "SMTP_FROM_EMAIL", None), patch.object(
            reminder_provider, "SMTP_FROM_EMAIL", None
        ), patch.object(
            transport.settings, "EMAIL_FROM_ADDRESS", "noreply@viread.app"
        ), patch.object(
            transport.settings, "EMAIL_FROM_NAME", "ViRead"
        ):
            t_msg = transport.build_test_email_message(
                recipient="parent@example.test",
                parent_name="Mẹ Lan",
                delivery_id=uuid4(),
            )
            p_msg = presence_provider.build_presence_message(
                recipient="parent@example.test",
                child_alias="Bé An",
                alert_id=uuid4(),
            )
            r_msg = reminder_provider.build_reading_reminder_message(
                recipient="parent@example.test",
                child_alias="Bé An",
                local_date="2026-11-29",
                local_time="19:00",
                timezone_name="Asia/Ho_Chi_Minh",
                occurrence_id=uuid4(),
            )
        self.assertEqual(t_msg["From"], "ViRead <noreply@viread.app>")
        self.assertEqual(p_msg["From"], "ViRead <noreply@viread.app>")
        self.assertEqual(r_msg["From"], "ViRead <noreply@viread.app>")
        for msg in (t_msg, p_msg, r_msg):
            self.assertTrue(msg["Message-ID"].endswith("@viread.app>"))
            self.assertNotIn(">>", msg["Message-ID"])

    def test_presence_and_reminder_deliver_to_parent_email_mail_sink_without_smtp(self):
        from app.providers import reading_presence_email_provider as presence_provider
        from app.providers import reading_reminder_email_provider as reminder_provider

        with tempfile.TemporaryDirectory() as folder:
            with patch.object(
                presence_provider, "READING_PRESENCE_MAIL_SINK_DIR", None
            ), patch.object(
                presence_provider, "SMTP_FROM_EMAIL", None
            ), patch.object(
                reminder_provider, "SMTP_FROM_EMAIL", None
            ), patch.object(
                transport.settings, "PARENT_EMAIL_MAIL_SINK_DIR", folder
            ), patch.object(
                transport.settings, "RESEND_API_KEY", None
            ):
                presence_provider.send_presence_email(
                    recipient="parent@example.test",
                    child_alias="Bé An",
                    alert_id=uuid4(),
                )
                reminder_provider.send_reading_reminder_email(
                    recipient="parent@example.test",
                    child_alias="Bé An",
                    local_date="2026-11-29",
                    local_time="19:00",
                    timezone_name="Asia/Ho_Chi_Minh",
                    occurrence_id=uuid4(),
                )
            files = sorted(Path(folder).glob("*.eml"))
            self.assertEqual(len(files), 2)

    async def test_retryable_failure_retries_across_sunday_to_monday_iso_week_rollover(self):
        child = make_child(CHILD_A_ID, "Bé An")
        bundle = ActiveParentBundle(
            parent_id=PARENT_ID,
            display_name="Mẹ Lan",
            children=(child,),
            preferences=make_prefs(DigestWeekday=6, QuietHoursStart=21, QuietHoursEnd=7),
            created_at=SUNDAY_MORNING_UTC - timedelta(days=30),
        )
        snap = ChildActivitySnapshot(
            child=child,
            sessions_last_7d=(make_session(SUNDAY_MORNING_UTC - timedelta(hours=1)),),
            sessions_prev_7d_count=1,
            sessions_last_35d=(make_session(SUNDAY_MORNING_UTC - timedelta(hours=1)),),
            total_completed_sessions=2,
            last_session_at=SUNDAY_MORNING_UTC - timedelta(hours=1),
            avg_fluency_last_7d=90.0,
            top_difficult_words_last_7d=(),
            active_goals=(),
        )
        repo = FakeNotificationRepo(bundles=[bundle], snapshots={child.Id: snap})
        service = ParentEmailNotificationService(repo)
        sent: list = []

        def fail_once(msg):
            if not sent:
                sent.append("failed")
                raise transport.EmailTransportRetryable("429 rate limited")
            sent.append(msg)
            return "resend"

        # Sunday 20:55 VN == 13:55 UTC (right before quiet hours 21:00)
        sunday_evening_utc = datetime(2026, 11, 29, 13, 55, tzinfo=timezone.utc)
        # Monday 07:30 VN == 00:30 UTC (next ISO week!)
        monday_early_utc = datetime(2026, 11, 30, 0, 30, tzinfo=timezone.utc)

        with patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ), patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            first = await service.dispatch_engagement_emails(
                sunday_evening_utc,
                recipient_resolver=verified_parent,
                message_sender=fail_once,
            )
            self.assertEqual(first, 0)
            self.assertEqual(repo.deliveries[0].Status, "RETRY")
            self.assertEqual(repo.deliveries[0].Attempts, 1)

            # Before backoff expires (only 5m later, still Sunday 21:00 -> quiet hours)
            quiet = await service.dispatch_engagement_emails(
                sunday_evening_utc + timedelta(minutes=5),
                recipient_resolver=verified_parent,
                message_sender=fail_once,
            )
            self.assertEqual(quiet, 0)

            # Monday morning (new ISO week): recovers Sunday's RETRY delivery!
            retried = await service.dispatch_engagement_emails(
                monday_early_utc,
                recipient_resolver=verified_parent,
                message_sender=fail_once,
            )
            self.assertEqual(retried, 1)
            self.assertEqual(repo.deliveries[0].Status, "SENT")
            self.assertEqual(repo.deliveries[0].Attempts, 2)

    async def test_retryable_failure_stops_as_failed_after_max_attempts(self):
        child = make_child(CHILD_A_ID, "Bé An")
        bundle = ActiveParentBundle(
            parent_id=PARENT_ID,
            display_name="Mẹ Lan",
            children=(child,),
            preferences=make_prefs(DigestWeekday=6),
            created_at=SUNDAY_MORNING_UTC - timedelta(days=30),
        )
        snap = ChildActivitySnapshot(
            child=child,
            sessions_last_7d=(),
            sessions_prev_7d_count=0,
            sessions_last_35d=(),
            total_completed_sessions=0,
            last_session_at=None,
            avg_fluency_last_7d=None,
            top_difficult_words_last_7d=(),
            active_goals=(),
        )
        repo = FakeNotificationRepo(bundles=[bundle], snapshots={child.Id: snap})
        service = ParentEmailNotificationService(repo)
        calls = 0

        def always_transient(_msg):
            nonlocal calls
            calls += 1
            raise transport.EmailTransportRetryable("Resend 503")

        with patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ), patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            t0 = SUNDAY_MORNING_UTC
            await service.dispatch_engagement_emails(
                t0, recipient_resolver=verified_parent, message_sender=always_transient
            )
            self.assertEqual(repo.deliveries[0].Status, "RETRY")
            # Attempt 2 after 15m backoff
            await service.dispatch_engagement_emails(
                t0 + timedelta(minutes=16),
                recipient_resolver=verified_parent,
                message_sender=always_transient,
            )
            self.assertEqual(repo.deliveries[0].Status, "RETRY")
            self.assertEqual(repo.deliveries[0].Attempts, 2)
            # Attempt 3 after 30m backoff -> terminal FAILED
            await service.dispatch_engagement_emails(
                t0 + timedelta(minutes=60),
                recipient_resolver=verified_parent,
                message_sender=always_transient,
            )
            self.assertEqual(repo.deliveries[0].Status, "FAILED")
            self.assertEqual(repo.deliveries[0].Attempts, 3)
            # Attempt 4 does NOT run
            await service.dispatch_engagement_emails(
                t0 + timedelta(minutes=180),
                recipient_resolver=verified_parent,
                message_sender=always_transient,
            )
        self.assertEqual(calls, 3)

    async def test_pagination_processes_all_active_parents_across_multiple_batches(self):
        bundles = []
        snapshots = {}
        for idx in range(5):
            pid = UUID(f"00000000-0000-4000-8000-00000000000{idx + 1}")
            cid = UUID(f"10000000-0000-4000-8000-00000000000{idx + 1}")
            child = SimpleNamespace(
                Id=cid,
                ParentId=pid,
                Alias=f"Bé {idx + 1}",
                CreatedAt=SUNDAY_MORNING_UTC - timedelta(days=15),
            )
            bundles.append(
                ActiveParentBundle(
                    parent_id=pid,
                    display_name=f"Phụ huynh {idx + 1}",
                    children=(child,),
                    preferences=make_prefs(ParentId=pid, DigestWeekday=6),
                    created_at=SUNDAY_MORNING_UTC - timedelta(days=20 - idx),
                )
            )
            snapshots[cid] = ChildActivitySnapshot(
                child=child,
                sessions_last_7d=(),
                sessions_prev_7d_count=0,
                sessions_last_35d=(),
                total_completed_sessions=0,
                last_session_at=None,
                avg_fluency_last_7d=None,
                top_difficult_words_last_7d=(),
                active_goals=(),
            )
        repo = FakeNotificationRepo(bundles=bundles, snapshots=snapshots)
        service = ParentEmailNotificationService(repo)
        sent = []
        with patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ), patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            total = await service.dispatch_engagement_emails(
                SUNDAY_MORNING_UTC,
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
                batch_limit=2,
            )
        self.assertEqual(total, 5)
        self.assertEqual(len(sent), 5)

    async def test_first_session_milestone_triggers_even_after_two_sessions_on_day_one_and_suppresses_inactivity(self):
        child_a = make_child(CHILD_A_ID, "Bé An")
        child_b = make_child(CHILD_B_ID, "Bé Bo")
        s1 = make_session(MONDAY_MORNING_UTC - timedelta(hours=3))
        s2 = make_session(MONDAY_MORNING_UTC - timedelta(hours=1))
        bundle = ActiveParentBundle(
            parent_id=PARENT_ID,
            display_name="Mẹ Lan",
            children=(child_a, child_b),
            preferences=make_prefs(DigestWeekday=6, InactivityDays=5),
            created_at=MONDAY_MORNING_UTC - timedelta(days=20),
        )
        snapshots = {
            child_a.Id: ChildActivitySnapshot(
                child=child_a,
                sessions_last_7d=(s2, s1),
                sessions_prev_7d_count=0,
                sessions_last_35d=(s2, s1),
                total_completed_sessions=2,
                last_session_at=s2.StartedAt,
                avg_fluency_last_7d=85.0,
                top_difficult_words_last_7d=(),
                active_goals=(),
                first_completed_session_at=s1.EndedAt,
            ),
            child_b.Id: ChildActivitySnapshot(
                child=child_b,
                sessions_last_7d=(),
                sessions_prev_7d_count=0,
                sessions_last_35d=(),
                total_completed_sessions=1,
                last_session_at=MONDAY_MORNING_UTC - timedelta(days=8),
                avg_fluency_last_7d=None,
                top_difficult_words_last_7d=(),
                active_goals=(),
            ),
        }
        repo = FakeNotificationRepo(bundles=[bundle], snapshots=snapshots)
        service = ParentEmailNotificationService(repo)
        sent = []
        with patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ), patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            count = await service.dispatch_engagement_emails(
                MONDAY_MORNING_UTC,
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )
        # Sends ONLY the MILESTONE (suppresses simultaneous INACTIVITY_ALERT in same pass)
        self.assertEqual(count, 1)
        self.assertEqual(repo.deliveries[0].Category, "MILESTONE")
        self.assertIn("buổi đọc đầu tiên", sent[0]["Subject"])

    async def test_stale_sending_recovery_frees_weekly_budget(self):
        child = make_child(CHILD_A_ID, "Bé An")
        bundle = ActiveParentBundle(
            parent_id=PARENT_ID,
            display_name="Mẹ Lan",
            children=(child,),
            preferences=make_prefs(DigestWeekday=6, MaxEmailsPerWeek=1),
            created_at=SUNDAY_MORNING_UTC - timedelta(days=20),
        )
        snap = ChildActivitySnapshot(
            child=child,
            sessions_last_7d=(),
            sessions_prev_7d_count=0,
            sessions_last_35d=(),
            total_completed_sessions=0,
            last_session_at=None,
            avg_fluency_last_7d=None,
            top_difficult_words_last_7d=(),
            active_goals=(),
        )
        repo = FakeNotificationRepo(bundles=[bundle], snapshots={child.Id: snap})
        # Simulate a crashed worker leaving a stale SENDING row from 30 minutes ago
        repo.deliveries.append(
            SimpleNamespace(
                Id=uuid4(),
                ParentId=PARENT_ID,
                ChildId=None,
                Category="MILESTONE",
                DedupeKey="milestone:old:FIRST_SESSION",
                Status="SENDING",
                Subject="Crashed send",
                Attempts=1,
                LastAttemptAt=SUNDAY_MORNING_UTC - timedelta(minutes=30),
                NextAttemptAt=None,
                SentAt=None,
                ErrorCode=None,
                Metadata={},
                CreatedAt=SUNDAY_MORNING_UTC - timedelta(minutes=30),
            )
        )
        service = ParentEmailNotificationService(repo)
        sent = []
        with patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ), patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            delivered = await service.dispatch_engagement_emails(
                SUNDAY_MORNING_UTC,
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )
        self.assertEqual(repo.deliveries[0].Status, "FAILED")
        self.assertEqual(repo.deliveries[0].ErrorCode, "UNKNOWN_DELIVERY")
        self.assertEqual(delivered, 1)
        self.assertEqual(len(sent), 1)

    async def test_repository_sqlalchemy_queries_compile_cleanly_for_postgresql(self):
        from sqlalchemy.dialects import postgresql
        from app.repositories.parent_email_notification_repository import (
            ParentEmailNotificationRepository,
        )

        compiled_sql: list[str] = []
        compiled_literals: list[str] = []
        dialect = postgresql.dialect()

        class CaptureSession:
            async def execute(self, stmt, *_args, **_kwargs):
                compiled_sql.append(str(stmt.compile(dialect=dialect)))
                try:
                    compiled_literals.append(
                        str(
                            stmt.compile(
                                dialect=dialect,
                                compile_kwargs={"literal_binds": True},
                            )
                        )
                    )
                except NotImplementedError:
                    pass
                return SimpleNamespace(
                    scalars=lambda: SimpleNamespace(all=lambda: []),
                    all=lambda: [],
                )

            async def scalar(self, stmt, *_args, **_kwargs):
                compiled_sql.append(str(stmt.compile(dialect=dialect)))
                return None

            async def commit(self):
                return None

            async def get(self, *_args, **_kwargs):
                return None

        repo = ParentEmailNotificationRepository(CaptureSession())  # type: ignore[arg-type]
        child = make_child(CHILD_A_ID, "Bé An")

        await repo.is_storage_ready()
        await repo.get_preferences(PARENT_ID)
        await repo.get_profile(PARENT_ID)
        await repo.list_recent_deliveries(PARENT_ID)
        await repo.count_automated_sent_since(PARENT_ID, SUNDAY_MORNING_UTC)
        await repo.last_sent_for_category(PARENT_ID, "WEEKLY_DIGEST")
        await repo.count_inactivity_alerts_since(PARENT_ID, SUNDAY_MORNING_UTC)
        await repo.get_delivery_by_dedupe_key("k")
        await repo.recover_stale_sending(
            SUNDAY_MORNING_UTC, stale_after=timedelta(minutes=10)
        )
        await repo.expire_stale_retries(SUNDAY_MORNING_UTC)
        await repo.claim_or_retry_delivery(
            parent_id=PARENT_ID,
            child_id=None,
            category="WEEKLY_DIGEST",
            dedupe_key="k",
            subject="s",
            metadata={},
            now=SUNDAY_MORNING_UTC,
        )
        await repo.finish_delivery(uuid4(), status="SENT", now=SUNDAY_MORNING_UTC)
        await repo.list_active_parents_with_children(
            limit=50,
            after_created_at=SUNDAY_MORNING_UTC,
            after_id=PARENT_ID,
        )
        await repo.get_child_activity_snapshot(child, SUNDAY_MORNING_UTC)

        joined = "\n".join(compiled_sql)
        self.assertIn("ON CONFLICT (dedupekey) DO NOTHING", joined)
        self.assertIn("parentemaildeliveries.status = %(status_1)s", joined)
        self.assertIn("FROM readingcomparisonreports JOIN readingsessions", joined)
        self.assertIn("NOT IN", joined)  # IGNORED_BY_GATE / DISMISSED filter
        self.assertGreaterEqual(len(compiled_sql), 16)

        event_sql = next(
            sql for sql in compiled_literals if "FROM pagerevisionwords JOIN readingevents" in sql
        )
        self.assertIn(
            "readingevents.status NOT IN ('IGNORED_BY_GATE', 'DISMISSED')",
            event_sql,
        )
        self.assertIn(
            "readingevents.type = 'WORD_RETRY' AND readingevents.status IN ('FAILED', 'UNCERTAIN')",
            event_sql,
        )
        self.assertNotIn("CONFIRMED", event_sql)

    async def test_snapshot_falls_back_to_comparison_reports_and_merges_difficult_words(self):
        from app.repositories.parent_email_notification_repository import (
            ParentEmailNotificationRepository,
        )

        session_a = uuid4()
        session_b = uuid4()
        page_1 = uuid4()
        rev_1 = uuid4()
        page_2 = uuid4()
        rev_2 = uuid4()
        recent_session = make_session(SUNDAY_MORNING_UTC - timedelta(days=1))
        recent_session.Id = session_a

        # Earliest finalized v1 snapshot for (session_a, page_1, rev_1): 3/4 correct, 1 error ("nghiêng")
        v1_first_pass = SimpleNamespace(
            SessionId=session_a,
            PageId=page_1,
            PageRevisionId=rev_1,
            CreatedAt=SUNDAY_MORNING_UTC - timedelta(days=1, minutes=5),
            Transcript="con mèo nghiêng đầu",
            Alignment=[],
            Summary={
                "assessment_version": 1,
                "initial_assessment": [
                    {"word_id": "w1", "word_index": 0, "text": "con", "status": "CORRECT"},
                    {"word_id": "w2", "word_index": 1, "text": "mèo", "status": "CORRECT"},
                    {"word_id": "w3", "word_index": 2, "text": "Nghiêng,", "status": "MISPRONUNCIATION"},
                    {"word_id": "w4", "word_index": 3, "text": "đầu", "status": "CORRECT"},
                ],
            },
        )
        # Later duplicate report for the same page/revision must NOT overwrite earliest first-pass
        v1_duplicate = SimpleNamespace(
            SessionId=session_a,
            PageId=page_1,
            PageRevisionId=rev_1,
            CreatedAt=SUNDAY_MORNING_UTC - timedelta(days=1, minutes=1),
            Transcript="",
            Alignment=[],
            Summary={
                "assessment_version": 1,
                "initial_assessment": [
                    {"word_id": "w1", "word_index": 0, "text": "sai", "status": "OMISSION"},
                    {"word_id": "w2", "word_index": 1, "text": "hết", "status": "OMISSION"},
                ],
            },
        )
        # Legacy alignment-only report: 2/4 correct, errors "nghiêng" and "khúc"
        legacy_report = SimpleNamespace(
            SessionId=session_b,
            PageId=page_2,
            PageRevisionId=rev_2,
            CreatedAt=SUNDAY_MORNING_UTC - timedelta(days=2),
            Transcript="trên đường đi",
            Summary={},
            Alignment=[
                {"book_index": 0, "book_word": "trên", "status": "MATCH"},
                {"book_index": 1, "book_word": "nghiêng", "spoken_word": "nghiên", "status": "SUBSTITUTE"},
                {"book_index": 2, "book_word": "khúc", "status": "DELETE"},
                {"book_index": 3, "book_word": "đường", "status": "MATCH"},
            ],
        )
        # Malformed report must be safely skipped
        malformed_report = SimpleNamespace(
            SessionId=uuid4(),
            PageId=uuid4(),
            PageRevisionId=uuid4(),
            CreatedAt=None,
            Transcript=None,
            Summary={"assessment_version": 1, "initial_assessment": "not-a-list"},
            Alignment="bad-alignment",
        )

        event_word_rows = [
            ("Nghiêng!", 2),
            ("tròn", 3),
            ("khúc", 1),
            ("xanh", 1),
            ("biển", 1),
            ("mây", 1),
        ]

        class SnapshotStubSession:
            def __init__(self, fluency_score):
                self.fluency_score = fluency_score
                self.scalar_calls = 0
                self.execute_calls = 0

            async def scalar(self, _stmt, *_args, **_kwargs):
                self.scalar_calls += 1
                # Order: total_completed, first_completed_session_at, last_session_at, avg_fluency_raw
                if self.scalar_calls == 1:
                    return 2
                if self.scalar_calls == 2:
                    return recent_session.EndedAt
                if self.scalar_calls == 3:
                    return recent_session.StartedAt
                return self.fluency_score

            async def execute(self, _stmt, *_args, **_kwargs):
                self.execute_calls += 1
                # Order: recent_sessions, comparison_report_rows, difficult_words_rows, active_goals
                if self.execute_calls == 1:
                    return SimpleNamespace(
                        scalars=lambda: SimpleNamespace(all=lambda: [recent_session])
                    )
                if self.execute_calls == 2:
                    return SimpleNamespace(
                        scalars=lambda: SimpleNamespace(
                            all=lambda: [
                                v1_duplicate,
                                v1_first_pass,
                                legacy_report,
                                malformed_report,
                            ]
                        )
                    )
                if self.execute_calls == 3:
                    return SimpleNamespace(all=lambda: event_word_rows)
                return SimpleNamespace(
                    scalars=lambda: SimpleNamespace(all=lambda: [])
                )

        child = make_child(CHILD_A_ID, "Bé An")

        # Case 1: FluencyAssessment absent -> fallback to ReadingComparisonReport accuracy (5/8 = 62.5%)
        repo_fallback = ParentEmailNotificationRepository(SnapshotStubSession(None))  # type: ignore[arg-type]
        snap = await repo_fallback.get_child_activity_snapshot(child, SUNDAY_MORNING_UTC)
        self.assertEqual(snap.avg_fluency_last_7d, 62.5)
        # Counts: nghiêng=4 (1+1+2), tròn=3, khúc=2 (1+1), biển=1, mây=1 (xanh=1 dropped by top-5)
        self.assertEqual(
            snap.top_difficult_words_last_7d,
            ("nghiêng", "tròn", "khúc", "biển", "mây"),
        )

        # Case 2: FluencyAssessment present (0.84 -> 84.0) -> preserve primary score, still merge words
        repo_primary = ParentEmailNotificationRepository(SnapshotStubSession(0.84))  # type: ignore[arg-type]
        snap_primary = await repo_primary.get_child_activity_snapshot(
            child, SUNDAY_MORNING_UTC
        )
        self.assertEqual(snap_primary.avg_fluency_last_7d, 84.0)
        self.assertEqual(
            snap_primary.top_difficult_words_last_7d,
            ("nghiêng", "tròn", "khúc", "biển", "mây"),
        )

    def test_summarize_comparison_reports_handles_zero_reached_and_empty_inputs(self):
        from app.repositories.parent_email_notification_repository import (
            _summarize_comparison_reports,
        )

        acc_empty, words_empty = _summarize_comparison_reports([], SUNDAY_MORNING_UTC)
        self.assertIsNone(acc_empty)
        self.assertEqual(dict(words_empty), {})

        # All words UNCERTAIN -> reached == 0 -> accuracy must be None, no ZeroDivisionError
        all_uncertain = SimpleNamespace(
            SessionId=uuid4(),
            PageId=uuid4(),
            PageRevisionId=uuid4(),
            CreatedAt=SUNDAY_MORNING_UTC,
            Transcript="",
            Alignment=[],
            Summary={
                "assessment_version": 1,
                "initial_assessment": [
                    {"word_id": "w1", "word_index": 0, "text": "mèo", "status": "UNCERTAIN"},
                ],
            },
        )
        acc_uncertain, words_uncertain = _summarize_comparison_reports(
            [all_uncertain], SUNDAY_MORNING_UTC
        )
        self.assertIsNone(acc_uncertain)
        self.assertEqual(dict(words_uncertain), {})

    async def test_expire_stale_retries_skips_resumed_inactivity_keeps_active_multichild_and_expires_ttl(self):
        from app.repositories.parent_email_notification_repository import (
            ParentEmailNotificationRepository,
        )

        parent_resumed = uuid4()
        parent_still_inactive = uuid4()
        child_resumed = uuid4()
        child_read_today = uuid4()
        child_still_idle = uuid4()

        # naive UTC timestamps verify _ensure_utc normalization safety
        now_utc = SUNDAY_NIGHT_UTC  # 22:30 VN (quiet hours)
        created_recent = now_utc - timedelta(hours=14)
        created_expired = now_utc - timedelta(hours=25)
        created_digest_expired = now_utc - timedelta(hours=37)

        row_resumed = SimpleNamespace(
            Id=uuid4(),
            ParentId=parent_resumed,
            Category="INACTIVITY_ALERT",
            Status="RETRY",
            Attempts=1,
            NextAttemptAt=now_utc - timedelta(hours=10),
            ErrorCode="EMAIL_PROVIDER_UNAVAILABLE",
            CreatedAt=created_recent.replace(tzinfo=None),
        )
        row_multichild = SimpleNamespace(
            Id=uuid4(),
            ParentId=parent_still_inactive,
            Category="INACTIVITY_ALERT",
            Status="RETRY",
            Attempts=1,
            NextAttemptAt=now_utc - timedelta(hours=10),
            ErrorCode="EMAIL_PROVIDER_UNAVAILABLE",
            CreatedAt=created_recent,
        )
        row_ttl_expired = SimpleNamespace(
            Id=uuid4(),
            ParentId=parent_still_inactive,
            Category="WEEKLY_DIGEST",
            Status="RETRY",
            Attempts=1,
            NextAttemptAt=now_utc - timedelta(hours=2),
            ErrorCode="EMAIL_PROVIDER_UNAVAILABLE",
            CreatedAt=created_digest_expired,
        )
        row_inactivity_ttl_expired = SimpleNamespace(
            Id=uuid4(),
            ParentId=parent_still_inactive,
            Category="INACTIVITY_ALERT",
            Status="RETRY",
            Attempts=1,
            NextAttemptAt=now_utc - timedelta(hours=2),
            ErrorCode="EMAIL_PROVIDER_UNAVAILABLE",
            CreatedAt=created_expired,
        )
        row_max_attempts = SimpleNamespace(
            Id=uuid4(),
            ParentId=parent_resumed,
            Category="MILESTONE",
            Status="RETRY",
            Attempts=3,
            NextAttemptAt=now_utc - timedelta(minutes=5),
            ErrorCode=None,
            CreatedAt=created_recent,
        )

        class RetryStubSession:
            def __init__(self) -> None:
                self.calls = 0
                self.committed = False
                self.compiled_sql: list[str] = []

            async def execute(self, stmt, *_args, **_kwargs):
                from sqlalchemy.dialects import postgresql

                self.compiled_sql.append(str(stmt.compile(dialect=postgresql.dialect())))
                self.calls += 1
                if self.calls == 1:
                    return SimpleNamespace(
                        scalars=lambda: SimpleNamespace(
                            all=lambda: [
                                row_resumed,
                                row_multichild,
                                row_ttl_expired,
                                row_inactivity_ttl_expired,
                                row_max_attempts,
                            ]
                        )
                    )
                if self.calls == 2:
                    return SimpleNamespace(
                        all=lambda: [
                            (parent_resumed, 1),
                            (parent_still_inactive, 1),
                        ]
                    )
                if self.calls == 3:
                    return SimpleNamespace(
                        scalars=lambda: SimpleNamespace(
                            all=lambda: [
                                make_prefs(
                                    ParentId=parent_resumed,
                                    InactivityAlertEnabled=True,
                                    InactivityDays=5,
                                    Timezone="Asia/Ho_Chi_Minh",
                                ),
                                make_prefs(
                                    ParentId=parent_still_inactive,
                                    InactivityAlertEnabled=True,
                                    InactivityDays=5,
                                    Timezone="Asia/Ho_Chi_Minh",
                                ),
                            ]
                        )
                    )
                if self.calls == 4:
                    return SimpleNamespace(
                        all=lambda: [
                            (child_resumed, parent_resumed, now_utc - timedelta(days=10)),
                            (child_read_today, parent_still_inactive, now_utc - timedelta(days=10)),
                            (child_still_idle, parent_still_inactive, now_utc - timedelta(days=10)),
                        ]
                    )
                return SimpleNamespace(
                    all=lambda: [
                        (child_resumed, (now_utc - timedelta(hours=3)).replace(tzinfo=None)),
                        (child_read_today, now_utc - timedelta(hours=2)),
                        (child_still_idle, now_utc - timedelta(days=7)),
                    ]
                )

            async def commit(self) -> None:
                self.committed = True

        stub_session = RetryStubSession()
        repo = ParentEmailNotificationRepository(stub_session)  # type: ignore[arg-type]
        updated = await repo.expire_stale_retries(now_utc, max_attempts=3)

        self.assertEqual(updated, 4)
        self.assertTrue(stub_session.committed)
        self.assertEqual(row_resumed.Status, "SKIPPED")
        self.assertEqual(row_resumed.ErrorCode, "CHILD_ACTIVITY_RESUMED")
        self.assertIsNone(row_resumed.NextAttemptAt)

        # Multi-child parent still has child_still_idle inactive for 7 days >= 5
        self.assertEqual(row_multichild.Status, "RETRY")
        self.assertIsNotNone(row_multichild.NextAttemptAt)

        # TTL expired rows are skipped
        self.assertEqual(row_ttl_expired.Status, "SKIPPED")
        self.assertEqual(row_ttl_expired.ErrorCode, "RETRY_EXPIRED")
        self.assertEqual(row_inactivity_ttl_expired.Status, "SKIPPED")
        self.assertEqual(row_inactivity_ttl_expired.ErrorCode, "RETRY_EXPIRED")

        # Attempts >= max_attempts becomes terminal FAILED
        self.assertEqual(row_max_attempts.Status, "FAILED")
        self.assertEqual(row_max_attempts.ErrorCode, "DELIVERY_RETRY_LIMIT")
        self.assertEqual(len(stub_session.compiled_sql), 5)

    async def test_batch_dispatch_snapshots_orm_objects_and_runs_retry_expiry_during_quiet_hours(self):
        from app.repositories.parent_email_notification_repository import (
            ParentDeliverySummary,
        )

        parent_a = PARENT_ID
        parent_b = UUID("44444444-4444-4444-8444-444444444444")
        child_a = CHILD_A_ID
        child_b = CHILD_B_ID

        class ExpiringDb:
            def __init__(self) -> None:
                self.expired = False
                self.rollback_calls = 0

            async def rollback(self) -> None:
                self.expired = True
                self.rollback_calls += 1

        class ExpiringRow:
            def __init__(self, db_ref: ExpiringDb, **attrs: object) -> None:
                object.__setattr__(self, "_db_ref", db_ref)
                object.__setattr__(self, "_attrs", attrs)

            def __getattr__(self, name: str):
                db_ref = object.__getattribute__(self, "_db_ref")
                if db_ref.expired:
                    raise RuntimeError(f"MissingGreenlet: expired access to {name}")
                attrs = object.__getattribute__(self, "_attrs")
                if name in attrs:
                    return attrs[name]
                raise AttributeError(name)

        class BatchExpiringRepo(FakeNotificationRepo):
            def __init__(self) -> None:
                super().__init__()
                self.db = ExpiringDb()
                self.expire_stale_retries_calls = 0

            async def expire_stale_retries(self, _now: datetime, *, max_attempts: int = 3) -> int:
                self.expire_stale_retries_calls += 1
                self.db.expired = False
                return 1

            async def list_active_parents_with_children(
                self,
                *,
                limit: int = 200,
                after_created_at: datetime | None = None,
                after_id: UUID | None = None,
            ):
                self.db.expired = False
                return [
                    ActiveParentBundle(
                        parent_id=parent_a,
                        display_name="Mẹ Lan",
                        children=(
                            ExpiringRow(  # type: ignore[arg-type]
                                self.db,
                                Id=child_a,
                                ParentId=parent_a,
                                Alias="Bé An",
                                CreatedAt=SUNDAY_MORNING_UTC - timedelta(days=20),
                            ),
                        ),
                        preferences=ExpiringRow(  # type: ignore[arg-type]
                            self.db,
                            ParentId=parent_a,
                            WeeklyDigestEnabled=True,
                            InactivityAlertEnabled=True,
                            InactivityDays=5,
                            MilestoneEnabled=True,
                            DigestWeekday=6,
                            Timezone="Asia/Ho_Chi_Minh",
                            QuietHoursStart=21,
                            QuietHoursEnd=7,
                            MaxEmailsPerWeek=4,
                            UpdatedAt=SUNDAY_MORNING_UTC,
                        ),
                        created_at=SUNDAY_MORNING_UTC - timedelta(days=20),
                    ),
                    ActiveParentBundle(
                        parent_id=parent_b,
                        display_name="Bố Minh",
                        children=(
                            ExpiringRow(  # type: ignore[arg-type]
                                self.db,
                                Id=child_b,
                                ParentId=parent_b,
                                Alias="Bé Bo",
                                CreatedAt=SUNDAY_MORNING_UTC - timedelta(days=20),
                            ),
                        ),
                        preferences=ExpiringRow(  # type: ignore[arg-type]
                            self.db,
                            ParentId=parent_b,
                            WeeklyDigestEnabled=True,
                            InactivityAlertEnabled=True,
                            InactivityDays=5,
                            MilestoneEnabled=True,
                            DigestWeekday=6,
                            Timezone="Asia/Ho_Chi_Minh",
                            QuietHoursStart=21,
                            QuietHoursEnd=7,
                            MaxEmailsPerWeek=4,
                            UpdatedAt=SUNDAY_MORNING_UTC,
                        ),
                        created_at=SUNDAY_MORNING_UTC - timedelta(days=19),
                    ),
                ]

            async def get_parent_delivery_summaries_batch(
                self, parent_ids: list[UUID], _now: datetime
            ) -> dict[UUID, ParentDeliverySummary]:
                return {
                    pid: ParentDeliverySummary(automated_sent_last_7d=0)
                    for pid in parent_ids
                }

            async def list_retry_deliveries_batch(self, _parent_ids: list[UUID]):
                return {}

            async def get_children_activity_snapshots_batch(
                self, children, _now: datetime, *, digest_child_ids=None
            ):
                out = {}
                for c in children:
                    cid = c.Id
                    sess = ExpiringRow(
                        self.db,
                        Id=uuid4(),
                        ChildId=cid,
                        State="COMPLETED",
                        StartedAt=SUNDAY_MORNING_UTC - timedelta(hours=3),
                        EndedAt=SUNDAY_MORNING_UTC - timedelta(hours=2, minutes=45),
                    )
                    goal = ExpiringRow(
                        self.db,
                        Id=uuid4(),
                        ChildId=cid,
                        Metric="MINUTES",
                        Period="DAILY",
                        TargetValue=15,
                        Timezone="Asia/Ho_Chi_Minh",
                        StartsOn=SUNDAY_MORNING_UTC.date() - timedelta(days=7),
                        EndsOn=None,
                        Status="ACTIVE",
                    )
                    out[cid] = ChildActivitySnapshot(
                        child=c,
                        sessions_last_7d=(sess,),  # type: ignore[arg-type]
                        sessions_prev_7d_count=1,
                        sessions_last_35d=(sess,),  # type: ignore[arg-type]
                        total_completed_sessions=1,
                        last_session_at=sess.StartedAt,
                        avg_fluency_last_7d=88.0,
                        top_difficult_words_last_7d=(),
                        active_goals=(goal,),  # type: ignore[arg-type]
                        first_completed_session_at=sess.EndedAt,
                    )
                return out

            async def claim_or_retry_delivery(self, **kwargs):
                row = await super().claim_or_retry_delivery(**kwargs)
                if row is None:
                    return None
                self.db.expired = False
                return ExpiringRow(
                    self.db,
                    Id=row.Id,
                    Attempts=row.Attempts,
                    Status=row.Status,
                )

        repo = BatchExpiringRepo()
        service = ParentEmailNotificationService(repo)  # type: ignore[arg-type]
        sent = []
        with patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ), patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            # Quiet hours still runs expire_stale_retries cleanly
            quiet_delivered = await service.dispatch_engagement_emails(
                SUNDAY_NIGHT_UTC,
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )
            self.assertEqual(quiet_delivered, 0)
            self.assertEqual(repo.expire_stale_retries_calls, 1)

            # Active window sends both parents without triggering MissingGreenlet across rollbacks
            active_delivered = await service.dispatch_engagement_emails(
                SUNDAY_MORNING_UTC,
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )
        self.assertEqual(active_delivered, 4)
        self.assertEqual(len(sent), 4)
        self.assertGreaterEqual(repo.db.rollback_calls, 4)


class GlobalDailyCapAndDryRunTests(unittest.IsolatedAsyncioTestCase):
    async def test_max_daily_emails_global_caps_dispatch_and_handles_pre_migration(self):
        bundles = []
        snapshots = {}
        for idx in range(4):
            pid = uuid4()
            cid = uuid4()
            child = SimpleNamespace(
                Id=cid,
                ParentId=pid,
                Alias=f"Bé {idx}",
                CreatedAt=SUNDAY_MORNING_UTC - timedelta(days=30),
            )
            bundles.append(
                ActiveParentBundle(
                    parent_id=pid,
                    display_name=f"Parent {idx}",
                    children=(child,),  # type: ignore[arg-type]
                    preferences=None,
                    created_at=SUNDAY_MORNING_UTC - timedelta(days=30 - idx),
                )
            )
            snapshots[cid] = ChildActivitySnapshot(
                child=child,  # type: ignore[arg-type]
                sessions_last_7d=(),
                sessions_prev_7d_count=0,
                sessions_last_35d=(),
                total_completed_sessions=0,
                last_session_at=None,
                avg_fluency_last_7d=None,
                top_difficult_words_last_7d=(),
                active_goals=(),
                first_completed_session_at=None,
            )

        repo = FakeNotificationRepo(bundles=bundles, snapshots=snapshots)

        sent_counter = {"count": 0}

        async def _count_global(_since: datetime) -> int:
            return sent_counter["count"]

        repo.count_global_sent_since = _count_global  # type: ignore[attr-defined]
        service = ParentEmailNotificationService(repo)  # type: ignore[arg-type]

        async def verified_parent(pid: UUID) -> str:
            return f"{pid}@example.test"

        sent: list = []
        with patch(
            "app.services.parent_email_notification_service.parent_email_delivery_is_configured",
            return_value=True,
        ), patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            # 1. Already at global cap -> 0 emails sent
            sent_counter["count"] = 3
            with patch.dict(os.environ, {"MAX_DAILY_EMAILS_GLOBAL": "3"}, clear=False):
                delivered = await service.dispatch_engagement_emails(
                    SUNDAY_MORNING_UTC,
                    recipient_resolver=verified_parent,
                    message_sender=lambda m: sent.append(m) or "resend",
                )
            self.assertEqual(delivered, 0)
            self.assertEqual(len(sent), 0)

            # 2. Remaining global budget = 1 -> caps total across parents to 1
            sent_counter["count"] = 2
            with patch.dict(os.environ, {"MAX_DAILY_EMAILS_GLOBAL": "3"}, clear=False):
                delivered = await service.dispatch_engagement_emails(
                    SUNDAY_MORNING_UTC,
                    recipient_resolver=verified_parent,
                    message_sender=lambda m: sent.append(m) or "resend",
                )
            self.assertEqual(delivered, 1)
            self.assertEqual(len(sent), 1)

            # 3. Pre-migration is_storage_ready() == False skips before calling count_global_sent_since
            repo.is_storage_ready = AsyncMock(return_value=False)  # type: ignore[method-assign]
            repo.count_global_sent_since = AsyncMock(  # type: ignore[attr-defined]
                side_effect=AssertionError("must not query missing table")
            )
            delivered_unmigrated = await service.dispatch_engagement_emails(
                SUNDAY_MORNING_UTC,
                recipient_resolver=verified_parent,
                message_sender=lambda m: sent.append(m) or "resend",
            )
            self.assertEqual(delivered_unmigrated, 0)

    def test_cron_dispatch_dry_run_route_is_non_mutating(self):
        app = FastAPI()
        app.include_router(route.router, prefix="/parent-notifications")
        client = TestClient(app)
        secret = "super-secret-cron-token-123456"

        with (
            patch.object(route.settings, "PARENT_EMAIL_CRON_SECRET", secret),
            patch(
                "app.jobs.parent_email_dispatcher_worker._worker_ready",
                return_value=(True, "resend"),
            ),
            patch(
                "app.jobs.parent_email_dispatcher_worker.active_email_provider",
                return_value="resend",
            ),
            patch(
                "app.jobs.parent_email_dispatcher_worker.process_due_alerts_once",
                new=AsyncMock(side_effect=AssertionError("dry_run must not run presence")),
            ),
            patch(
                "app.jobs.parent_email_dispatcher_worker.process_due_reminders_once",
                new=AsyncMock(side_effect=AssertionError("dry_run must not run reminders")),
            ),
            patch(
                "app.jobs.parent_email_dispatcher_worker.process_engagement_emails_once",
                new=AsyncMock(side_effect=AssertionError("dry_run must not run engagement")),
            ),
            patch(
                "app.jobs.parent_email_dispatcher_worker.persist_worker_heartbeats_batch_with_factory",
                new=AsyncMock(side_effect=AssertionError("dry_run must not write heartbeats")),
            ),
        ):
            resp = client.post(
                "/parent-notifications/cron/dispatch?scope=all&dry_run=true",
                headers={"X-Cron-Secret": secret},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["dry_run"])
        self.assertEqual(body["presence_sent"], 0)
        self.assertEqual(body["reminders_sent"], 0)
        self.assertEqual(body["engagement_sent"], 0)


if __name__ == "__main__":
    unittest.main()
