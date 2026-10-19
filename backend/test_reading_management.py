import asyncio
import os
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from pydantic import ValidationError

from app.schemas.reading_management import (
    ReadingGoalCreate,
    ReadingGoalUpdate,
    ReadingReminderCreate,
    ReadingReminderUpdate,
)
from app.services.reading_management_service import (
    ManagementForbidden,
    ManagementNotFound,
    ReadingManagementService,
    completed_metric,
    goal_cycle_window,
)


def session(state, started_at, ended_at):
    return SimpleNamespace(State=state, StartedAt=started_at, EndedAt=ended_at)


class OwnershipRepository:
    def __init__(self, *, role_value="parent", owned=True):
        self.role_value = role_value
        self.owned = owned

    async def role(self, actor_id):
        return self.role_value

    async def owned_child(self, child_id, actor_id):
        return SimpleNamespace(Id=child_id) if self.owned else None

    async def goals(self, child_id):
        return []


class ReadingManagementTests(unittest.TestCase):
    def test_goal_create_validates_dates_and_iana_timezone(self):
        values = dict(
            child_id="00000000-0000-4000-8000-000000000001",
            metric="MINUTES",
            target_value=20,
            period="DAILY",
            starts_on=date(2026, 10, 1),
        )
        self.assertEqual(
            ReadingGoalCreate(**values, timezone="Asia/Ho_Chi_Minh").target_value,
            20,
        )
        with self.assertRaises(ValidationError):
            ReadingGoalCreate(**values, ends_on=date(2026, 9, 30))
        with self.assertRaises(ValidationError):
            ReadingGoalCreate(**values, timezone="Moon/Base")

    def test_reminder_schema_rejects_duplicate_or_invalid_weekdays(self):
        base = dict(
            child_id="00000000-0000-4000-8000-000000000001",
            remind_at="19:30:00",
            timezone="Asia/Ho_Chi_Minh",
        )
        with self.assertRaises(ValidationError):
            ReadingReminderCreate(**base, weekdays=[0, 0])
        with self.assertRaises(ValidationError):
            ReadingReminderCreate(**base, weekdays=[7])

    def test_progress_ignores_incomplete_or_invalid_sessions(self):
        now = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)
        start = now - timedelta(minutes=12, seconds=30)
        end = now - timedelta(minutes=1)
        rows = [
            session("FINISHED", start, end),
            session("COMPLETED", start, end),
            session("PAUSED", start, end),
            session("ABORTED", start, end),
            session("FINISHED", start, None),
            session("FINISHED", end, start),
            session("FINISHED", start, now + timedelta(minutes=1)),
        ]
        self.assertEqual(completed_metric(rows, "SESSIONS", now), 2)
        self.assertEqual(completed_metric(rows, "MINUTES", now), 23)

    def test_weekly_goal_window_respects_vietnam_timezone(self):
        goal = SimpleNamespace(
            Timezone="Asia/Ho_Chi_Minh",
            Period="WEEKLY",
            StartsOn=date(2026, 10, 1),
            EndsOn=None,
        )
        start, end = goal_cycle_window(
            goal, datetime(2026, 10, 19, 8, tzinfo=timezone.utc)
        )
        self.assertEqual(start, datetime(2026, 10, 18, 17, tzinfo=timezone.utc))
        self.assertEqual(end, datetime(2026, 10, 25, 17, tzinfo=timezone.utc))

    def test_minutes_are_clipped_to_goal_cycle_boundary(self):
        now = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)
        start = now - timedelta(minutes=20)
        end = now - timedelta(minutes=5)
        row = session("COMPLETED", start, end)
        cycle_start = now - timedelta(minutes=10)
        self.assertEqual(
            completed_metric([row], "MINUTES", now, cycle_start, now), 5
        )
        self.assertEqual(
            completed_metric([row], "SESSIONS", now, cycle_start, now), 1
        )

    def test_parent_cannot_list_goals_for_child_not_owned_by_them(self):
        service = ReadingManagementService(OwnershipRepository(owned=False))
        with self.assertRaises(ManagementNotFound):
            asyncio.run(
                service.list_goals(
                    UUID("11111111-1111-4111-8111-111111111111"),
                    UUID("22222222-2222-4222-8222-222222222222"),
                )
            )

    def test_non_parent_role_cannot_access_reading_management(self):
        service = ReadingManagementService(
            OwnershipRepository(role_value="admin", owned=True)
        )
        with self.assertRaises(ManagementForbidden):
            asyncio.run(
                service.list_goals(
                    UUID("11111111-1111-4111-8111-111111111111"),
                    UUID("22222222-2222-4222-8222-222222222222"),
                )
            )

    def test_reminder_and_goal_patch_reject_null_required_values(self):
        with self.assertRaises(ValidationError):
            ReadingReminderUpdate(is_active=None)
        with self.assertRaises(ValidationError):
            ReadingReminderUpdate(timezone=None)
        with self.assertRaises(ValidationError):
            ReadingGoalUpdate(target_value=None)
