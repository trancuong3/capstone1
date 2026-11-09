"""Pure business rules for reading goals, plans and reminders.

No database or HTTP code lives here: every function takes plain values so the
rules can be tested without a session. The service and repository call them.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Callable, NamedTuple
from zoneinfo import ZoneInfo

# How many past cycles are examined when computing a streak.
MAX_STREAK_LOOKBACK = 30
# Pending reminders older than this are treated as missed and no longer listed.
STALE_REMINDER_HOURS = 36

# Reason code -> English API detail. The frontend maps these to Vietnamese text.
CONFLICT_MESSAGES: dict[str, str] = {
    "GOAL_DUPLICATE": "An active goal with the same metric and period already overlaps these dates",
    "GOAL_ALREADY_EXPIRED": "The end date is already in the past",
    "GOAL_END_BEFORE_START": "The end date must not be before the start date",
    "PLAN_ALREADY_EXPIRED": "The plan end date is already in the past",
    "PLAN_NO_SCHEDULED_DAY": "The plan has no reading day between its start and end dates",
    "BOOK_UNAVAILABLE": "The selected book is not available to read",
    "REMINDER_DUPLICATE": "A reminder with the same time and overlapping days already exists",
}
DEFAULT_CONFLICT_MESSAGE = "The requested state transition is not allowed"


def conflict_detail(reason: str | None) -> str:
    return CONFLICT_MESSAGES.get(reason or "", DEFAULT_CONFLICT_MESSAGE)


def local_date(now: datetime, timezone_name: str) -> date:
    return now.astimezone(ZoneInfo(timezone_name)).date()


def day_start_utc(day: date, timezone_name: str) -> datetime:
    zone = ZoneInfo(timezone_name)
    return datetime.combine(day, time.min, tzinfo=zone).astimezone(timezone.utc)


def local_day_bounds(day: date, timezone_name: str) -> tuple[datetime, datetime]:
    """UTC [start, end) of one local calendar day."""
    return day_start_utc(day, timezone_name), day_start_utc(day + timedelta(days=1), timezone_name)


def reference_now(ends_on: date | None, timezone_name: str, now: datetime) -> datetime:
    """Instant used to pick which cycle to show.

    While an item is running this is simply ``now``. Once its end date has passed it
    is the last instant of that end date, so the final cycle's result is still shown
    instead of dropping to zero.
    """
    if ends_on is None or local_date(now, timezone_name) <= ends_on:
        return now
    return day_start_utc(ends_on + timedelta(days=1), timezone_name) - timedelta(microseconds=1)


def item_phase(status: str, starts_on: date, ends_on: date | None, timezone_name: str, now: datetime) -> str:
    """UPCOMING / RUNNING / EXPIRED by date, FINISHED once completed or ended."""
    if status in ("COMPLETED", "ENDED"):
        return "FINISHED"
    today = local_date(now, timezone_name)
    if today < starts_on:
        return "UPCOMING"
    if ends_on is not None and today > ends_on:
        return "EXPIRED"
    return "RUNNING"


def ranges_overlap(
    a_start: date, a_end: date | None, b_start: date, b_end: date | None
) -> bool:
    """Inclusive date ranges; ``None`` as an end means open-ended."""
    return (a_end is None or b_start <= a_end) and (b_end is None or a_start <= b_end)


def has_scheduled_day(weekdays: list[int], starts_on: date, ends_on: date | None) -> bool:
    """True when at least one chosen weekday falls inside the date range."""
    if not weekdays:
        return False
    if ends_on is None:
        return True
    cursor = starts_on
    for _ in range(7):
        if cursor > ends_on:
            return False
        if cursor.weekday() in weekdays:
            return True
        cursor += timedelta(days=1)
    return False


def next_scheduled_date(
    weekdays: list[int], starts_on: date, ends_on: date | None, today: date
) -> date | None:
    """First reading day on or after ``today`` inside the plan's date range."""
    cursor = max(today, starts_on)
    for _ in range(7):
        if ends_on is not None and cursor > ends_on:
            return None
        if cursor.weekday() in weekdays:
            return cursor
        cursor += timedelta(days=1)
    return None


class Cycle(NamedTuple):
    starts_at: datetime  # UTC, inclusive
    ends_at: datetime  # UTC, exclusive
    first_day: date  # local, inclusive
    last_day: date  # local, inclusive


def goal_cycles(goal, now: datetime, count: int = MAX_STREAK_LOOKBACK) -> list[Cycle]:
    """The current (or final) cycle and up to ``count - 1`` before it, oldest first."""
    zone_name = goal.Timezone
    reference = reference_now(goal.EndsOn, zone_name, now)
    today = local_date(reference, zone_name)
    if today < goal.StartsOn:
        return []
    step = 1 if goal.Period == "DAILY" else 7
    cursor = today if goal.Period == "DAILY" else today - timedelta(days=today.weekday())
    cycles: list[Cycle] = []
    for _ in range(count):
        first = max(cursor, goal.StartsOn)
        end = cursor + timedelta(days=step)
        if goal.EndsOn is not None:
            end = min(end, goal.EndsOn + timedelta(days=1))
        if first >= end:
            break
        cycles.append(
            Cycle(
                day_start_utc(first, zone_name),
                day_start_utc(end, zone_name),
                first,
                end - timedelta(days=1),
            )
        )
        cursor -= timedelta(days=step)
        if cursor + timedelta(days=step) <= goal.StartsOn:
            break
    cycles.reverse()
    return cycles


def goal_streak(
    cycles: list[Cycle],
    target: int,
    value_of: Callable[[Cycle], int],
    *,
    last_in_progress: bool,
) -> int:
    """Consecutive cycles that reached the target, ending at the latest cycle.

    A cycle that is still running and has not reached the target yet does not break
    the streak (the child may still reach it); any finished cycle below target does.
    """
    streak = 0
    for index in range(len(cycles) - 1, -1, -1):
        met = value_of(cycles[index]) >= target
        if met:
            streak += 1
        elif index == len(cycles) - 1 and last_in_progress:
            continue
        else:
            break
    return streak


def weekdays_overlap(a: list[int], b: list[int]) -> bool:
    return bool(set(a) & set(b))


def same_minute(a: time, b: time) -> bool:
    return (a.hour, a.minute) == (b.hour, b.minute)
