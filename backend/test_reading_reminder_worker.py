import asyncio
import os
import unittest
from datetime import date, datetime, time, timezone
from types import SimpleNamespace
from uuid import UUID
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

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
        # SMTP settings are module-level configuration values. Patch the
        # provider dependency directly so this test is independent of test
        # discovery/import order and never changes the process environment.
        with patch(
            "app.providers.reading_reminder_email_provider.SMTP_FROM_EMAIL",
            "sender@example.test",
        ):
            first = build_reading_reminder_message(**values)
            second = build_reading_reminder_message(**values)
        self.assertEqual(first["Message-ID"], second["Message-ID"])
        self.assertEqual(first["Content-Language"], "vi")
        plain_body = first.get_body(preferencelist=("plain",)).get_content()
        html_body = first.get_body(preferencelist=("html",)).get_content()
        self.assertIn("Bé An", plain_body)
        self.assertIn("2026-11-04 lúc 19:30", plain_body)
        self.assertIn("Bé An", html_body)
        self.assertIn("2026-11-04 lúc 19:30", html_body)

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

    def test_deliver_claimed_occurrences_memoizes_parent_email_lookup_per_sweep(self):
        repo = FakeRepository()
        parent_id = UUID("22222222-2222-4222-8222-222222222222")
        lookup_calls = []
        sent = []

        async def recipient(pid):
            lookup_calls.append(pid)
            return "parent@example.com"

        def sender(**kwargs):
            sent.append(kwargs)

        claims = []
        for idx in range(3):
            occ, rem, child = claim()
            occ.Id = UUID(f"11111111-1111-4111-8111-11111111111{idx}")
            child.ParentId = parent_id
            claims.append((occ, rem, child))

        delivered = asyncio.run(
            deliver_claimed_occurrences(
                repo,
                claims,
                datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
                recipient_resolver=recipient,
                email_sender=sender,
            )
        )
        self.assertEqual(delivered, 3)
        self.assertEqual(len(sent), 3)
        self.assertEqual(len(lookup_calls), 1, "Same parent must be looked up only once per sweep")

    def test_deliver_claimed_occurrences_memoizes_unverified_parent_per_sweep(self):
        repo = FakeRepository()
        lookup_calls = 0

        async def recipient(_pid):
            nonlocal lookup_calls
            lookup_calls += 1
            raise ParentEmailUnavailable("PARENT_EMAIL_UNVERIFIED")

        claims = [claim(), claim()]
        delivered = asyncio.run(
            deliver_claimed_occurrences(
                repo,
                claims,
                datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
                recipient_resolver=recipient,
                email_sender=lambda **_kw: None,
            )
        )
        self.assertEqual(delivered, 0)
        self.assertEqual(lookup_calls, 1)
        self.assertEqual(len(repo.updates), 2)
        self.assertTrue(all(u[1]["error_code"] == "PARENT_EMAIL_UNVERIFIED" for u in repo.updates))

    def test_create_due_occurrences_batches_into_single_insert_statement(self):
        from unittest.mock import AsyncMock, MagicMock
        from app.repositories.reading_management_repository import ReadingManagementRepository

        now = datetime(2026, 11, 4, 13, 0, tzinfo=timezone.utc)  # 20:00 VN (Wed = 2)
        reminders = [
            SimpleNamespace(
                Id=UUID(f"33333333-3333-4333-8333-33333333333{i}"),
                RemindAt=time(19, 0 + i),
                Weekdays=[2],
                Timezone="Asia/Ho_Chi_Minh",
                EmailEnabled=True,
                IsActive=True,
                DeletedAt=None,
            )
            for i in range(4)
        ]

        executed_statements = []
        fake_db = MagicMock()

        async def _fake_execute(stmt):
            executed_statements.append(stmt)
            return SimpleNamespace(rowcount=4)

        fake_db.execute = AsyncMock(side_effect=_fake_execute)
        fake_db.commit = AsyncMock()

        repo = ReadingManagementRepository(fake_db)
        with patch.object(
            repo, "active_reminders_for_worker", new=AsyncMock(return_value=reminders)
        ):
            created = asyncio.run(repo.create_due_occurrences_for_worker(now))

        self.assertEqual(created, 4)
        self.assertEqual(len(executed_statements), 1, "Must execute 1 multi-row batch INSERT")
        fake_db.commit.assert_awaited_once()

    def test_children_read_in_windows_batches_multiple_windows_into_one_query(self):
        from unittest.mock import AsyncMock, MagicMock
        from app.repositories.reading_management_repository import ReadingManagementRepository

        child_a = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        child_b = UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        day_start = datetime(2026, 11, 3, 17, 0, tzinfo=timezone.utc)
        day_end = datetime(2026, 11, 4, 17, 0, tzinfo=timezone.utc)

        fake_db = MagicMock()
        fake_db.execute = AsyncMock(
            return_value=SimpleNamespace(
                all=lambda: [(child_a, datetime(2026, 11, 4, 10, 0, tzinfo=timezone.utc))]
            )
        )
        repo = ReadingManagementRepository(fake_db)
        matched = asyncio.run(
            repo.children_read_in_windows(
                [(child_a, day_start, day_end), (child_b, day_start, day_end)]
            )
        )
        self.assertEqual(matched, {(child_a, day_start, day_end)})
        fake_db.execute.assert_awaited_once()

    def test_presence_service_memoizes_recipient_lookup_across_alerts(self):
        from datetime import timedelta
        from unittest.mock import AsyncMock, MagicMock
        from app.services.reading_presence_service import PresenceLimits, ReadingPresenceService

        now = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)
        parent_id = UUID("22222222-2222-4222-8222-222222222222")
        alerts = [
            SimpleNamespace(
                Id=UUID(f"44444444-4444-4444-8444-44444444444{i}"),
                SessionId=UUID(f"55555555-5555-4555-8555-55555555555{i}"),
                ChildId=UUID(f"66666666-6666-4666-8666-66666666666{i}"),
                ParentId=parent_id,
                ExpiresAt=now + timedelta(minutes=5),
                Attempts=1,
            )
            for i in range(2)
        ]
        repo = MagicMock()
        repo.db = MagicMock(rollback=AsyncMock())
        repo.expire_and_recover = AsyncMock()
        repo.claim_due = AsyncMock(return_value=alerts)
        repo.delivery_context = AsyncMock(
            return_value=SimpleNamespace(
                session_state="LISTENING", child_alias="Bé An", email_enabled=True
            )
        )
        repo.finish_alert = AsyncMock()

        lookup_count = 0

        async def _resolve(_pid):
            nonlocal lookup_count
            lookup_count += 1
            return "parent@example.com"

        sent = []
        service = ReadingPresenceService(repo, PresenceLimits())
        delivered = asyncio.run(
            service.deliver_due(
                now,
                recipient_resolver=_resolve,
                email_sender=lambda **kw: sent.append(kw),
            )
        )
        self.assertEqual(delivered, 2)
        self.assertEqual(len(sent), 2)
        self.assertEqual(lookup_count, 1)
        self.assertEqual(repo.claim_due.await_args.kwargs.get("limit"), 5)

    def test_deliver_claimed_occurrences_dispatches_multiple_emails_concurrently(self):
        import time as _time

        repo = FakeRepository()
        parent_id = UUID("22222222-2222-4222-8222-222222222222")
        claims = []
        for idx in range(3):
            occ, rem, child = claim()
            occ.Id = UUID(f"77777777-7777-4777-8777-77777777777{idx}")
            child.ParentId = parent_id
            claims.append((occ, rem, child))

        async def _resolve(_pid):
            return "parent@example.com"

        def _slow_sender(**_kwargs):
            _time.sleep(0.25)

        t0 = _time.monotonic()
        delivered = asyncio.run(
            deliver_claimed_occurrences(
                repo,
                claims,
                datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
                recipient_resolver=_resolve,
                email_sender=_slow_sender,
            )
        )
        elapsed = _time.monotonic() - t0
        self.assertEqual(delivered, 3)
        self.assertEqual(len(repo.updates), 3)
        self.assertTrue(all(u[1]["status"] == "SENT" for u in repo.updates))
        self.assertLess(
            elapsed,
            0.55,
            f"3 x 0.25s emails should run concurrently (~0.25s), not sequentially (~0.75s); got {elapsed:.2f}s",
        )


if __name__ == "__main__":
    unittest.main()
