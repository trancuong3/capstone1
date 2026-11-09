"""Business rules for reading goals, plans and reminders (no database needed)."""

import asyncio
import os
import unittest
from datetime import date, datetime, time, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.schemas.reading_management import (
    ReadingGoalCreate,
    ReadingGoalTransition,
    ReadingPlanCreate,
    ReadingReminderCreate,
    ReadingReminderUpdate,
)
from app.services.reading_management_rules import (
    conflict_detail,
    goal_cycles,
    goal_streak,
    has_scheduled_day,
    item_phase,
    next_scheduled_date,
    reference_now,
    ranges_overlap,
)
from app.services.reading_management_service import (
    ManagementConflict,
    ReadingManagementService,
)

VN = "Asia/Ho_Chi_Minh"
ACTOR = UUID("11111111-1111-4111-8111-111111111111")
CHILD = UUID("22222222-2222-4222-8222-222222222222")
# Monday 2026-11-09, 12:00 in Vietnam.
NOW = datetime(2026, 11, 9, 5, 0, tzinfo=timezone.utc)


def vn(day: int, hour: int, minute: int = 0, month: int = 11, year: int = 2026) -> datetime:
    """A Vietnam wall-clock time as UTC (UTC+7, no DST)."""
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc) - timedelta(hours=7)


def read(start: datetime, minutes: int):
    return SimpleNamespace(
        State="COMPLETED", StartedAt=start, EndedAt=start + timedelta(minutes=minutes)
    )


def goal(**overrides):
    values = dict(
        Id=UUID("33333333-3333-4333-8333-333333333333"),
        ChildId=CHILD,
        Metric="MINUTES",
        TargetValue=20,
        Period="DAILY",
        StartsOn=date(2026, 11, 1),
        EndsOn=None,
        Timezone=VN,
        Status="ACTIVE",
        CompletedValue=None,
        CompletedAt=None,
        CreatedAt=NOW,
        UpdatedAt=NOW,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


def plan(**overrides):
    values = dict(
        Id=UUID("44444444-4444-4444-8444-444444444444"),
        ChildId=CHILD,
        BookId=None,
        Title="Đọc buổi tối",
        TargetMinutes=20,
        Weekdays=[0, 2, 4],
        StartsOn=date(2026, 11, 1),
        EndsOn=None,
        Timezone=VN,
        Status="ACTIVE",
        CompletedAt=None,
        CreatedAt=NOW,
        UpdatedAt=NOW,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


class FakeRepository:
    def __init__(self, *, goals=(), sessions=(), plan_sessions=(), reminders=()):
        self._goals = list(goals)
        self._sessions = list(sessions)
        self._plan_sessions = list(plan_sessions)
        self._reminders = list(reminders)
        self.saved = []

    async def role(self, actor_id):
        return "parent"

    async def owned_child(self, child_id, actor_id):
        return SimpleNamespace(Id=child_id)

    async def children(self, actor_id):
        return [SimpleNamespace(Id=CHILD)]

    async def goals(self, child_id):
        return list(self._goals)

    async def goal(self, goal_id, child_id):
        return next((g for g in self._goals if g.Id == goal_id), None)

    async def completed_sessions(self, child_id, starts_at, ends_at):
        return [
            s
            for s in self._sessions
            if s.EndedAt is not None and starts_at <= s.EndedAt < ends_at and s.StartedAt < ends_at
        ]

    async def completed_plan_sessions(self, child_id, starts_at, ends_at, now, book_id=None):
        return list(self._plan_sessions)

    async def book(self, book_id):
        return None

    async def eligible_book(self, book_id):
        return None

    async def reminders(self, child_id):
        return list(self._reminders)

    async def save(self, obj):
        self.saved.append(obj)
        return obj


def run(coro):
    return asyncio.run(coro)


class PhaseTests(unittest.TestCase):
    def test_phase_by_date_and_status(self):
        args = (date(2026, 11, 1), date(2026, 11, 5), VN)
        self.assertEqual(item_phase("ACTIVE", *args, NOW), "EXPIRED")
        self.assertEqual(item_phase("ACTIVE", date(2026, 11, 20), None, VN, NOW), "UPCOMING")
        self.assertEqual(item_phase("PAUSED", date(2026, 11, 1), None, VN, NOW), "RUNNING")
        self.assertEqual(item_phase("COMPLETED", *args, NOW), "FINISHED")
        self.assertEqual(item_phase("ENDED", date(2026, 11, 1), None, VN, NOW), "FINISHED")

    def test_last_day_is_still_running_in_the_goal_timezone(self):
        # 23:30 on the end date in Vietnam is still that day (16:30 UTC).
        late = vn(9, 23, 30)
        self.assertEqual(item_phase("ACTIVE", date(2026, 11, 1), date(2026, 11, 9), VN, late), "RUNNING")
        after = vn(10, 0, 1)
        self.assertEqual(item_phase("ACTIVE", date(2026, 11, 1), date(2026, 11, 9), VN, after), "EXPIRED")

    def test_reference_now_clamps_to_the_last_instant_of_the_end_date(self):
        self.assertEqual(reference_now(None, VN, NOW), NOW)
        self.assertEqual(reference_now(date(2026, 11, 20), VN, NOW), NOW)
        clamped = reference_now(date(2026, 11, 5), VN, NOW)
        self.assertEqual(clamped, vn(6, 0) - timedelta(microseconds=1))


class RangeAndScheduleTests(unittest.TestCase):
    def test_ranges_overlap_handles_open_ended_ranges(self):
        d = date
        self.assertTrue(ranges_overlap(d(2026, 11, 1), None, d(2026, 12, 1), None))
        self.assertTrue(ranges_overlap(d(2026, 11, 1), d(2026, 11, 10), d(2026, 11, 10), None))
        self.assertFalse(ranges_overlap(d(2026, 11, 1), d(2026, 11, 9), d(2026, 11, 10), None))
        self.assertFalse(ranges_overlap(d(2026, 11, 10), None, d(2026, 11, 1), d(2026, 11, 9)))

    def test_has_scheduled_day_needs_a_matching_weekday_in_range(self):
        # Tue 10th .. Thu 12th contains no Monday but does contain a Wednesday.
        self.assertFalse(has_scheduled_day([0], date(2026, 11, 10), date(2026, 11, 12)))
        self.assertTrue(has_scheduled_day([2], date(2026, 11, 10), date(2026, 11, 12)))
        self.assertTrue(has_scheduled_day([0], date(2026, 11, 10), None))
        self.assertFalse(has_scheduled_day([], date(2026, 11, 10), None))

    def test_next_scheduled_date_includes_today_and_respects_the_range(self):
        monday = date(2026, 11, 9)
        self.assertEqual(next_scheduled_date([0, 2], date(2026, 11, 1), None, monday), monday)
        self.assertEqual(next_scheduled_date([2], date(2026, 11, 1), None, monday), date(2026, 11, 11))
        self.assertEqual(next_scheduled_date([0], date(2026, 11, 20), None, monday), date(2026, 11, 23))
        self.assertIsNone(next_scheduled_date([2], date(2026, 11, 1), date(2026, 11, 10), monday))


class CycleAndStreakTests(unittest.TestCase):
    def test_daily_cycles_stop_at_the_start_date(self):
        cycles = goal_cycles(goal(StartsOn=date(2026, 11, 7)), NOW)
        self.assertEqual([c.first_day for c in cycles], [date(2026, 11, 7), date(2026, 11, 8), date(2026, 11, 9)])

    def test_weekly_cycles_start_on_monday_and_clip_to_the_range(self):
        cycles = goal_cycles(goal(Period="WEEKLY", StartsOn=date(2026, 10, 28)), NOW)
        self.assertEqual(cycles[-1].first_day, date(2026, 11, 9))
        self.assertEqual(cycles[-1].last_day, date(2026, 11, 15))
        self.assertEqual(cycles[0].first_day, date(2026, 10, 28))  # clipped by starts_on
        self.assertEqual(len(cycles), 3)

    def test_no_cycles_before_the_start_date_and_final_cycle_after_the_end(self):
        self.assertEqual(goal_cycles(goal(StartsOn=date(2026, 11, 20)), NOW), [])
        expired = goal_cycles(goal(StartsOn=date(2026, 11, 1), EndsOn=date(2026, 11, 5)), NOW)
        self.assertEqual(expired[-1].last_day, date(2026, 11, 5))

    def test_streak_ignores_an_unfinished_current_cycle_but_not_a_missed_past_one(self):
        cycles = goal_cycles(goal(), NOW)
        met = {cycles[-2].first_day, cycles[-3].first_day}
        value = lambda cycle: 20 if cycle.first_day in met else 0
        self.assertEqual(goal_streak(cycles, 20, value, last_in_progress=True), 2)
        self.assertEqual(goal_streak(cycles, 20, value, last_in_progress=False), 0)
        met.add(cycles[-1].first_day)
        self.assertEqual(goal_streak(cycles, 20, value, last_in_progress=True), 3)


class GoalServiceTests(unittest.TestCase):
    def test_running_goal_reports_phase_streak_and_cycle(self):
        sessions = [read(vn(8, 20), 20), read(vn(7, 20), 25)]
        service = ReadingManagementService(FakeRepository(goals=[goal()], sessions=sessions))
        [row] = run(service.list_goals(ACTOR, CHILD, NOW))
        self.assertEqual(row["phase"], "RUNNING")
        self.assertEqual(row["current_value"], 0)
        self.assertEqual(row["streak_cycles"], 2)
        self.assertEqual(row["cycle_starts_on"], date(2026, 11, 9))
        self.assertEqual(row["cycle_ends_on"], date(2026, 11, 9))

    def test_expired_goal_keeps_its_final_cycle_result_instead_of_zero(self):
        expired = goal(EndsOn=date(2026, 11, 5))
        service = ReadingManagementService(
            FakeRepository(goals=[expired], sessions=[read(vn(5, 20), 30)])
        )
        [row] = run(service.list_goals(ACTOR, CHILD, NOW))
        self.assertEqual(row["phase"], "EXPIRED")
        self.assertEqual(row["current_value"], 30)
        self.assertEqual(row["progress_percent"], 100.0)
        self.assertEqual(row["cycle_ends_on"], date(2026, 11, 5))

    def test_upcoming_goal_is_zero_without_a_cycle(self):
        service = ReadingManagementService(
            FakeRepository(goals=[goal(StartsOn=date(2026, 11, 20))])
        )
        [row] = run(service.list_goals(ACTOR, CHILD, NOW))
        self.assertEqual(row["phase"], "UPCOMING")
        self.assertEqual(row["current_value"], 0)
        self.assertIsNone(row["cycle_starts_on"])

    def test_finished_goal_uses_the_stored_result(self):
        done = goal(Status="COMPLETED", CompletedValue=42)
        service = ReadingManagementService(FakeRepository(goals=[done]))
        [row] = run(service.list_goals(ACTOR, CHILD, NOW))
        self.assertEqual(row["phase"], "FINISHED")
        self.assertEqual(row["current_value"], 42)
        self.assertEqual(row["streak_cycles"], 0)

    def test_completing_an_expired_goal_records_the_final_cycle(self):
        old = goal(StartsOn=date(2020, 1, 1), EndsOn=date(2020, 1, 10))
        repo = FakeRepository(
            goals=[old], sessions=[read(vn(10, 20, month=1, year=2020), 30)]
        )
        service = ReadingManagementService(repo)
        saved = run(service.transition_goal(ACTOR, old.Id, ReadingGoalTransition(status="COMPLETED")))
        self.assertEqual(saved.CompletedValue, 30)
        self.assertEqual(saved.Status, "COMPLETED")

    def _goal_payload(self, **overrides):
        values = dict(
            child_id=CHILD, metric="MINUTES", target_value=30, period="DAILY",
            starts_on=date(2026, 11, 9),
        )
        values.update(overrides)
        return ReadingGoalCreate(**values)

    def test_overlapping_goal_of_the_same_kind_is_rejected(self):
        repo = FakeRepository(goals=[goal()])
        service = ReadingManagementService(repo)
        with self.assertRaises(ManagementConflict) as caught:
            run(service.create_goal(ACTOR, self._goal_payload(), NOW))
        self.assertEqual(caught.exception.reason, "GOAL_DUPLICATE")
        self.assertEqual(repo.saved, [])

    def test_goals_of_another_kind_period_or_status_are_allowed(self):
        for existing in (
            goal(Metric="SESSIONS"),
            goal(Period="WEEKLY"),
            goal(Status="ENDED"),
            goal(EndsOn=date(2026, 11, 8)),
        ):
            repo = FakeRepository(goals=[existing])
            run(ReadingManagementService(repo).create_goal(ACTOR, self._goal_payload(), NOW))
            self.assertEqual(len(repo.saved), 1)

    def test_goal_already_past_its_end_date_is_rejected(self):
        service = ReadingManagementService(FakeRepository())
        payload = self._goal_payload(starts_on=date(2026, 11, 1), ends_on=date(2026, 11, 5))
        with self.assertRaises(ManagementConflict) as caught:
            run(service.create_goal(ACTOR, payload, NOW))
        self.assertEqual(caught.exception.reason, "GOAL_ALREADY_EXPIRED")


class PlanServiceTests(unittest.TestCase):
    def test_running_plan_reports_today_and_the_week(self):
        sessions = [read(vn(9, 9), 25)]
        service = ReadingManagementService(FakeRepository(plan_sessions=sessions))
        row = run(service.plan_dict(plan(), NOW))
        self.assertEqual(row["phase"], "RUNNING")
        self.assertTrue(row["is_scheduled_today"])
        self.assertEqual(row["minutes_today"], 25)
        self.assertEqual(row["scheduled_days_this_week"], 3)
        self.assertEqual(row["completed_days_this_week"], 1)
        self.assertEqual(row["next_scheduled_date"], date(2026, 11, 9))

    def test_reading_on_an_unscheduled_day_counts_as_minutes_today_only(self):
        tuesday = vn(10, 20)
        now = tuesday + timedelta(hours=1)
        service = ReadingManagementService(FakeRepository(plan_sessions=[read(tuesday, 15)]))
        row = run(service.plan_dict(plan(), now))
        self.assertFalse(row["is_scheduled_today"])
        self.assertEqual(row["minutes_today"], 15)
        self.assertEqual(row["completed_days_this_week"], 0)
        self.assertEqual(row["next_scheduled_date"], date(2026, 11, 11))

    def test_expired_plan_keeps_showing_its_final_week(self):
        expired = plan(EndsOn=date(2026, 11, 6))
        service = ReadingManagementService(FakeRepository(plan_sessions=[read(vn(4, 20), 30)]))
        row = run(service.plan_dict(expired, NOW))
        self.assertEqual(row["phase"], "EXPIRED")
        self.assertEqual(row["scheduled_days_this_week"], 3)
        self.assertEqual(row["completed_days_this_week"], 1)
        self.assertFalse(row["is_scheduled_today"])
        self.assertEqual(row["minutes_today"], 0)
        self.assertIsNone(row["next_scheduled_date"])

    def test_paused_plan_has_no_next_day_or_today_flag(self):
        row = run(ReadingManagementService(FakeRepository()).plan_dict(plan(Status="PAUSED"), NOW))
        self.assertFalse(row["is_scheduled_today"])
        self.assertIsNone(row["next_scheduled_date"])

    def _plan_payload(self, **overrides):
        values = dict(
            child_id=CHILD, title="Đọc", target_minutes=20, weekdays=[0],
            starts_on=date(2026, 11, 10), ends_on=date(2026, 11, 12),
        )
        values.update(overrides)
        return ReadingPlanCreate(**values)

    def test_plan_without_any_reading_day_in_range_is_rejected(self):
        service = ReadingManagementService(FakeRepository())
        with self.assertRaises(ManagementConflict) as caught:
            run(service.create_plan(ACTOR, self._plan_payload(), NOW))
        self.assertEqual(caught.exception.reason, "PLAN_NO_SCHEDULED_DAY")

    def test_plan_already_past_its_end_date_is_rejected(self):
        service = ReadingManagementService(FakeRepository())
        payload = self._plan_payload(weekdays=[2], starts_on=date(2026, 11, 1), ends_on=date(2026, 11, 5))
        with self.assertRaises(ManagementConflict) as caught:
            run(service.create_plan(ACTOR, payload, NOW))
        self.assertEqual(caught.exception.reason, "PLAN_ALREADY_EXPIRED")

    def test_valid_plan_is_saved(self):
        repo = FakeRepository()
        run(ReadingManagementService(repo).create_plan(ACTOR, self._plan_payload(weekdays=[2]), NOW))
        self.assertEqual(len(repo.saved), 1)


def reminder(**overrides):
    values = dict(
        Id=UUID("55555555-5555-4555-8555-555555555555"),
        ChildId=CHILD,
        RemindAt=time(19, 0),
        Weekdays=[0, 1, 2],
        Timezone=VN,
        IsActive=True,
        EmailEnabled=False,
        DeletedAt=None,
        CreatedAt=NOW,
        UpdatedAt=NOW,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


class ReminderServiceTests(unittest.TestCase):
    def _payload(self, **overrides):
        values = dict(child_id=CHILD, remind_at=time(19, 0, 30), weekdays=[2, 3], timezone=VN)
        values.update(overrides)
        return ReadingReminderCreate(**values)

    def test_same_time_on_a_shared_day_is_a_duplicate(self):
        repo = FakeRepository(reminders=[reminder()])
        with self.assertRaises(ManagementConflict) as caught:
            run(ReadingManagementService(repo).create_reminder(ACTOR, self._payload()))
        self.assertEqual(caught.exception.reason, "REMINDER_DUPLICATE")

    def test_other_days_other_times_inactive_or_other_zone_are_not_duplicates(self):
        for existing, payload in (
            (reminder(), self._payload(weekdays=[3, 4])),
            (reminder(), self._payload(remind_at=time(19, 1))),
            (reminder(IsActive=False), self._payload()),
            (reminder(), self._payload(timezone="Asia/Bangkok")),
            (reminder(), self._payload(is_active=False)),
        ):
            repo = FakeRepository(reminders=[existing])
            run(ReadingManagementService(repo).create_reminder(ACTOR, payload))
            self.assertEqual(len(repo.saved), 1)

    def test_editing_a_reminder_does_not_clash_with_itself(self):
        own = reminder()

        class Repo(FakeRepository):
            async def reminder_for_actor(self, reminder_id, actor_id):
                return own

            async def refresh_unsent_email_occurrences(self, saved):
                return None

        repo = Repo(reminders=[own])
        service = ReadingManagementService(repo)
        run(service.update_reminder(ACTOR, own.Id, ReadingReminderUpdate(weekdays=[0, 1])))
        self.assertEqual(own.Weekdays, [0, 1])

    def test_moving_onto_another_reminders_slot_is_rejected(self):
        own = reminder()
        other = reminder(Id=UUID("66666666-6666-4666-8666-666666666666"), RemindAt=time(20, 0))

        class Repo(FakeRepository):
            async def reminder_for_actor(self, reminder_id, actor_id):
                return own

        service = ReadingManagementService(Repo(reminders=[own, other]))
        with self.assertRaises(ManagementConflict):
            run(service.update_reminder(ACTOR, own.Id, ReadingReminderUpdate(remind_at=time(20, 0))))


class ConflictMessageTests(unittest.TestCase):
    def test_known_reasons_have_their_own_detail_and_unknown_fall_back(self):
        default = conflict_detail(None)
        self.assertEqual(default, "The requested state transition is not allowed")
        self.assertEqual(conflict_detail("not-a-reason"), default)
        for reason in (
            "GOAL_DUPLICATE", "GOAL_ALREADY_EXPIRED", "GOAL_END_BEFORE_START",
            "PLAN_ALREADY_EXPIRED", "PLAN_NO_SCHEDULED_DAY", "BOOK_UNAVAILABLE", "REMINDER_DUPLICATE",
        ):
            self.assertNotEqual(conflict_detail(reason), default, reason)


if __name__ == "__main__":
    unittest.main()
