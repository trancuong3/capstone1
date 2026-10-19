import asyncio
import os
from datetime import date, datetime, timedelta, timezone

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
from types import SimpleNamespace
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.schemas.reading_management import ReadingGoalCreate, ReadingReminderCreate
from app.services.reading_management_service import (
    completed_metric, goal_cycle_window, ReadingManagementService, ManagementNotFound, ManagementForbidden,
)


def session(state, started_at, ended_at):
    return SimpleNamespace(State=state, StartedAt=started_at, EndedAt=ended_at)


def test_goal_create_validates_dates_and_iana_timezone():
    values = dict(child_id="00000000-0000-4000-8000-000000000001", metric="MINUTES",
                  target_value=20, period="DAILY", starts_on=date(2026, 10, 1))
    assert ReadingGoalCreate(**values, timezone="Asia/Ho_Chi_Minh").target_value == 20
    with pytest.raises(ValidationError):
        ReadingGoalCreate(**values, ends_on=date(2026, 9, 30))
    with pytest.raises(ValidationError):
        ReadingGoalCreate(**values, timezone="Moon/Base")


def test_reminder_schema_rejects_duplicate_or_invalid_weekdays():
    base = dict(child_id="00000000-0000-4000-8000-000000000001", remind_at="19:30:00", timezone="Asia/Ho_Chi_Minh")
    with pytest.raises(ValidationError):
        ReadingReminderCreate(**base, weekdays=[0, 0])
    with pytest.raises(ValidationError):
        ReadingReminderCreate(**base, weekdays=[7])


def test_progress_ignores_incomplete_or_invalid_sessions():
    now = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)
    start = now - timedelta(minutes=12, seconds=30)
    end = now - timedelta(minutes=1)
    rows = [session("FINISHED", start, end), session("COMPLETED", start, end), session("PAUSED", start, end),
            session("ABORTED", start, end), session("FINISHED", start, None),
            session("FINISHED", end, start), session("FINISHED", start, now + timedelta(minutes=1))]
    assert completed_metric(rows, "SESSIONS", now) == 1
    assert completed_metric(rows, "MINUTES", now) == 11


def test_weekly_goal_window_respects_vietnam_timezone():
    goal = SimpleNamespace(Timezone="Asia/Ho_Chi_Minh", Period="WEEKLY",
                           StartsOn=date(2026, 10, 1), EndsOn=None)
    start, end = goal_cycle_window(goal, datetime(2026, 10, 19, 8, tzinfo=timezone.utc))
    assert start == datetime(2026, 10, 18, 17, tzinfo=timezone.utc)
    assert end == datetime(2026, 10, 25, 17, tzinfo=timezone.utc)


def test_minutes_are_clipped_to_the_goal_cycle_boundary():
    now = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)
    start = now - timedelta(minutes=20)
    end = now - timedelta(minutes=5)
    row = session("COMPLETED", start, end)
    cycle_start = now - timedelta(minutes=10)
    assert completed_metric([row], "MINUTES", now, cycle_start, now) == 10
    assert completed_metric([row], "SESSIONS", now, cycle_start, now) == 1


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


def test_parent_cannot_list_goals_for_child_not_owned_by_them():
    service = ReadingManagementService(OwnershipRepository(owned=False))
    with pytest.raises(ManagementNotFound):
        asyncio.run(service.list_goals(
            UUID("11111111-1111-4111-8111-111111111111"),
            UUID("22222222-2222-4222-8222-222222222222"),
        ))


def test_non_parent_role_cannot_access_reading_management():
    service = ReadingManagementService(OwnershipRepository(role_value="admin", owned=True))
    with pytest.raises(ManagementForbidden):
        asyncio.run(service.list_goals(
            UUID("11111111-1111-4111-8111-111111111111"),
            UUID("22222222-2222-4222-8222-222222222222"),
        ))

    
def test_reminder_patch_rejects_null_for_required_fields():
    from app.schemas.reading_management import ReadingReminderUpdate, ReadingGoalUpdate
    with pytest.raises(ValidationError):
        ReadingReminderUpdate(is_active=None)
    with pytest.raises(ValidationError):
        ReadingReminderUpdate(timezone=None)
    with pytest.raises(ValidationError):
        ReadingGoalUpdate(target_value=None)
