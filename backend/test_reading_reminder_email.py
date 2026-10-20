import asyncio
import json
import os
import unittest

import httpx
from datetime import date, datetime, time, timezone
from types import SimpleNamespace
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.providers.resend_email_provider import ResendEmailProvider, ResendEmailProviderError, build_reminder_message
from app.repositories.reading_reminder_email_repository import scheduled_occurrences
from app.services.reading_reminder_email_service import ReadingReminderEmailService


NOW = datetime(2026, 10, 19, 12, 10, tzinfo=timezone.utc)
PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
DELIVERY_ID = UUID("22222222-2222-4222-8222-222222222222")
OCCURRENCE_ID = UUID("33333333-3333-4333-8333-333333333333")


class FakeRepository:
    def __init__(self):
        self.claim = {
            "delivery_id": DELIVERY_ID, "occurrence_key": OCCURRENCE_ID,
            "parent_id": PARENT_ID,
            "scheduled_for": datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc),
            "timezone": "Asia/Ho_Chi_Minh",
        }
        self.claimed = False
        self.sent, self.skipped, self.failed, self.calls = [], [], [], []

    async def recover_stale_processing(self, now):
        self.calls.append("recover")
        return 0

    async def enqueue_due_deliveries(self, now, catch_up_minutes):
        self.calls.append(("enqueue", catch_up_minutes))
        return {"reminders_checked": 1, "occurrences_created": 1, "deliveries_created": 1}

    async def skip_ineligible_deliveries(self, now):
        return 0

    async def skip_waiting_deliveries(self, reason, now):
        self.calls.append(("skip_waiting", reason))
        return 1

    async def claim_next_delivery(self, now):
        if self.claimed:
            return None
        self.claimed = True
        return self.claim

    async def delivery_is_current(self, delivery_id):
        return True

    async def mark_sent(self, delivery_id, provider_message_id, accepted_at):
        self.sent.append((delivery_id, provider_message_id, accepted_at))

    async def mark_skipped(self, delivery_id, reason, now):
        self.skipped.append((delivery_id, reason))

    async def mark_failed(self, delivery_id, reason, *, retryable, now, max_attempts):
        self.failed.append((delivery_id, reason, retryable, max_attempts))
        return retryable


class FakeMailer:
    is_configured = True

    def __init__(self, result="resend-test-id", error=None):
        self.result, self.error, self.sent_to = result, error, []

    async def send_reminder(self, **kwargs):
        self.sent_to.append(kwargs["to_email"])
        if self.error:
            raise self.error
        return self.result


class FakeAuth:
    def __init__(self, contact):
        self.contact = contact

    async def get_contact_info(self, user_id):
        return self.contact


class ReminderEmailTests(unittest.TestCase):
    def test_occurrence_uses_local_weekday_and_timezone(self):
        reminder = SimpleNamespace(RemindAt=time(19, 0), Weekdays=[0, 2, 4],
                                   Timezone="Asia/Ho_Chi_Minh",
                                   EmailEnabledAt=datetime(2026, 10, 19, 11, 30, tzinfo=timezone.utc))
        rows = scheduled_occurrences(reminder, NOW, 120)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], date(2026, 10, 19))
        self.assertEqual(rows[0][1], datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc))

    def test_old_occurrence_is_not_caught_up_after_long_downtime(self):
        reminder = SimpleNamespace(RemindAt=time(19, 0), Weekdays=[0],
                                   Timezone="Asia/Ho_Chi_Minh",
                                   EmailEnabledAt=datetime(2026, 10, 19, 11, 30, tzinfo=timezone.utc))
        now = datetime(2026, 10, 19, 16, 0, tzinfo=timezone.utc)
        self.assertEqual(scheduled_occurrences(reminder, now, 120), [])

    def test_reenabled_email_does_not_send_occurrence_from_before_opt_in(self):
        reminder = SimpleNamespace(RemindAt=time(19, 0), Weekdays=[0],
                                   Timezone="Asia/Ho_Chi_Minh",
                                   EmailEnabledAt=datetime(2026, 10, 19, 12, 5, tzinfo=timezone.utc))
        self.assertEqual(scheduled_occurrences(reminder, NOW, 120), [])

    def test_email_template_is_vietnamese_and_has_no_child_progress_claim(self):
        subject, text_body, html_body = build_reminder_message(
            datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc),
            "Asia/Ho_Chi_Minh", "https://viread.example")
        self.assertEqual(subject, "ViRead nhắc ba mẹ: Đã đến giờ đọc sách cùng bé")
        self.assertIn("Chào ba mẹ", text_body)
        self.assertIn("19:00", text_body)
        self.assertIn("Duy Tan University", text_body)
        self.assertIn("reading-management", html_body)
        self.assertNotIn("Bé An", text_body)
        self.assertNotIn("đã hoàn thành", text_body)

    def test_missing_provider_config_is_not_reported_as_sent(self):
        repo = FakeRepository()
        mailer = ResendEmailProvider(api_key=None, from_email=None, app_url=None)
        stats = asyncio.run(ReadingReminderEmailService(repo, mailer, FakeAuth({})).run_once(now=NOW))
        self.assertEqual(stats["provider_accepted"], 0)
        self.assertEqual(stats["skipped"], 1)
        self.assertIn(("skip_waiting", "email_provider_not_configured"), repo.calls)

    def test_parent_without_verified_email_is_skipped(self):
        repo, mailer = FakeRepository(), FakeMailer()
        auth = FakeAuth({"contact_info_status": "available", "email": "parent@example.test",
                         "email_verified": False})
        stats = asyncio.run(ReadingReminderEmailService(repo, mailer, auth).run_once(now=NOW))
        self.assertEqual(stats["provider_accepted"], 0)
        self.assertEqual(repo.skipped[0][1], "parent_email_unverified")
        self.assertEqual(mailer.sent_to, [])

    def test_provider_acceptance_is_recorded_as_sent(self):
        repo, mailer = FakeRepository(), FakeMailer(result="resend-message-1")
        auth = FakeAuth({"contact_info_status": "available",
                         "email": "verified-parent@example.test", "email_verified": True})
        stats = asyncio.run(ReadingReminderEmailService(repo, mailer, auth).run_once(now=NOW))
        self.assertEqual(stats["provider_accepted"], 1)
        self.assertEqual(repo.sent[0][1], "resend-message-1")
        self.assertEqual(mailer.sent_to, ["verified-parent@example.test"])

    def test_resend_adapter_sends_both_formats_and_reuses_occurrence_idempotency_key(self):
        captured = {}

        def respond(request):
            captured["request"] = request
            captured["payload"] = json.loads(request.content)
            return httpx.Response(200, json={"id": "resend-test-message"})

        occurrence_key = str(OCCURRENCE_ID)
        provider = ResendEmailProvider(
            api_key="test-server-key",
            from_email="ViRead <no-reply@example.test>",
            app_url="https://viread.example",
            transport=httpx.MockTransport(respond),
        )
        result = asyncio.run(provider.send_reminder(
            to_email="parent@example.test",
            scheduled_for=datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc),
            timezone_name="Asia/Ho_Chi_Minh",
            idempotency_key=occurrence_key,
        ))
        self.assertEqual(result, "resend-test-message")
        self.assertEqual(
            captured["request"].headers["Idempotency-Key"],
            "viread-reading-reminder-" + occurrence_key,
        )
        self.assertIn("Chào ba mẹ", captured["payload"]["text"])
        self.assertIn("<html", captured["payload"]["html"].lower() if "<html" in captured["payload"]["html"].lower() else "<html")

    def test_resend_rejection_is_not_treated_as_accepted(self):
        provider = ResendEmailProvider(
            api_key="test-server-key",
            from_email="ViRead <no-reply@example.test>",
            app_url="https://viread.example",
            transport=httpx.MockTransport(
                lambda request: httpx.Response(422, json={"message": "invalid recipient"})
            ),
        )
        with self.assertRaises(ResendEmailProviderError) as caught:
            asyncio.run(provider.send_reminder(
                to_email="parent@example.test",
                scheduled_for=datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc),
                timezone_name="Asia/Ho_Chi_Minh",
                idempotency_key=str(OCCURRENCE_ID),
            ))
        self.assertEqual(caught.exception.code, "provider_rejected_request")
        self.assertFalse(caught.exception.retryable)

    def test_rate_limit_is_retryable_but_provider_rejection_is_not(self):
        self.assertTrue(ResendEmailProviderError("provider_rate_limited", retryable=True).retryable)
        self.assertFalse(ResendEmailProviderError("provider_rejected_request", retryable=False).retryable)

    def test_temporary_provider_failure_records_retry_not_success(self):
        repo = FakeRepository()
        mailer = FakeMailer(error=ResendEmailProviderError("provider_rate_limited", retryable=True))
        auth = FakeAuth({"contact_info_status": "available",
                         "email": "verified-parent@example.test", "email_verified": True})
        stats = asyncio.run(ReadingReminderEmailService(repo, mailer, auth).run_once(now=NOW))
        self.assertEqual(stats["provider_accepted"], 0)
        self.assertEqual(stats["failed"], 1)
        self.assertEqual(stats["retried"], 1)
        self.assertEqual(repo.failed[0][1], "provider_rate_limited")


if __name__ == "__main__":
    unittest.main()
