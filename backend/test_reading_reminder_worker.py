import asyncio
import os
import unittest
from datetime import date, datetime, time, timezone
from types import SimpleNamespace
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("SMTP_FROM_EMAIL", "vireadforyou@gmail.com")

from app.jobs.reading_reminder_worker import ParentEmailUnavailable, deliver_claimed_occurrences
from app.providers.reading_reminder_email_provider import build_reading_reminder_message
from app.services.reading_reminder_schedule import local_schedule_to_utc


class FakeRepository:
    def __init__(self):
        self.updates = []

    async def update_email_delivery(self, occurrence_id, **values):
        self.updates.append((occurrence_id, values))


def claim(attempts=1):
    occurrence = SimpleNamespace(
        Id=UUID("11111111-1111-4111-8111-111111111111"),
        EmailAttempts=attempts,
        ScheduledLocalDate=date(2026, 11, 4),
    )
    reminder = SimpleNamespace(RemindAt=time(19, 30), Timezone="Asia/Ho_Chi_Minh")
    child = SimpleNamespace(
        ParentId=UUID("22222222-2222-4222-8222-222222222222"),
        Alias="Bé An",
    )
    return occurrence, reminder, child


class ReadingReminderWorkerTests(unittest.TestCase):
    def test_local_schedule_handles_regular_timezone(self):
        self.assertEqual(
            local_schedule_to_utc(date(2026, 11, 4), time(19, 0), "Asia/Ho_Chi_Minh"),
            datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc),
        )

    def test_nonexistent_dst_wall_time_is_skipped(self):
        self.assertIsNone(
            local_schedule_to_utc(date(2026, 3, 8), time(2, 30), "America/Los_Angeles")
        )

    def test_ambiguous_dst_wall_time_chooses_first_occurrence(self):
        self.assertEqual(
            local_schedule_to_utc(date(2026, 11, 1), time(1, 30), "America/Los_Angeles"),
            datetime(2026, 11, 1, 8, 30, tzinfo=timezone.utc),
        )

    def test_message_has_stable_id_and_child_reminder_copy(self):
        values = dict(
            recipient="parent@example.com",
            child_alias="Bé An",
            local_date="2026-11-04",
            local_time="19:30",
            timezone_name="Asia/Ho_Chi_Minh",
            occurrence_id=UUID("11111111-1111-4111-8111-111111111111"),
        )
        first = build_reading_reminder_message(**values)
        second = build_reading_reminder_message(**values)
        self.assertEqual(first["Message-ID"], second["Message-ID"])
        self.assertIn("Bé An", first.get_content())
        self.assertIn("2026-11-04 lúc 19:30", first.get_content())

    def test_successful_email_marks_occurrence_sent(self):
        repo = FakeRepository()
        sent = []

        async def recipient(_parent_id):
            return "parent@example.com"

        def sender(**kwargs):
            sent.append(kwargs)

        delivered = asyncio.run(
            deliver_claimed_occurrences(
                repo,
                [claim()],
                datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
                recipient_resolver=recipient,
                email_sender=sender,
            )
        )
        self.assertEqual(delivered, 1)
        self.assertEqual(repo.updates[0][1]["status"], "SENT")
        self.assertEqual(sent[0]["recipient"], "parent@example.com")

    def test_unverified_parent_email_is_not_sent(self):
        repo = FakeRepository()
        sent = []

        async def recipient(_parent_id):
            raise ParentEmailUnavailable()

        def sender(**kwargs):
            sent.append(kwargs)

        asyncio.run(
            deliver_claimed_occurrences(
                repo,
                [claim()],
                datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
                recipient_resolver=recipient,
                email_sender=sender,
            )
        )
        self.assertEqual(sent, [])
        self.assertEqual(repo.updates[0][1]["status"], "FAILED")
        self.assertEqual(repo.updates[0][1]["error_code"], "PARENT_EMAIL_UNVERIFIED")

    def test_transient_email_failure_schedules_retry_without_logging_recipient(self):
        repo = FakeRepository()
        now = datetime(2026, 11, 4, 12, tzinfo=timezone.utc)

        async def recipient(_parent_id):
            return "parent@example.com"

        def sender(**_kwargs):
            raise RuntimeError("private provider response")

        asyncio.run(
            deliver_claimed_occurrences(
                repo,
                [claim(attempts=1)],
                now,
                recipient_resolver=recipient,
                email_sender=sender,
            )
        )
        self.assertEqual(repo.updates[0][1]["status"], "RETRY")
        self.assertEqual(repo.updates[0][1]["error_code"], "SMTP_UNAVAILABLE")
        self.assertEqual(repo.updates[0][1]["next_attempt_at"], datetime(2026, 11, 4, 12, 1, tzinfo=timezone.utc))


if __name__ == "__main__":
    unittest.main()
