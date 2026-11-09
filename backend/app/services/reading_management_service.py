from datetime import date, datetime, time, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

from app.models import ChildProfile
from app.models.reading_management import ChildBookCollection, ReadingGoal, ReadingPlan, ReadingReminder
from app.repositories.reading_management_repository import ReadingManagementRepository
from app.schemas.reading_management import (
    ReadingGoalCreate,
    ReadingGoalUpdate,
    ReadingGoalTransition,
    ReadingPlanCreate,
    ReadingPlanUpdate,
    ReadingPlanTransition,
    ChildBookCollectionCreate,
    ReadingReminderCreate,
    ReadingReminderUpdate,
)
from app.services.reading_management_rules import (
    goal_cycles,
    goal_streak,
    has_scheduled_day,
    item_phase,
    local_date,
    local_day_bounds,
    next_scheduled_date,
    ranges_overlap,
    reference_now,
    same_minute,
    weekdays_overlap,
)


class ManagementNotFound(Exception):
    pass


class ManagementForbidden(Exception):
    pass


class ManagementConflict(Exception):
    """A request that is valid in shape but not allowed by the business rules.

    ``reason`` is a stable code (see ``reading_management_rules.CONFLICT_MESSAGES``);
    ``None`` means a plain invalid state transition.
    """

    def __init__(self, reason: str | None = None) -> None:
        super().__init__(reason or "INVALID_TRANSITION")
        self.reason = reason


def completed_metric(sessions, metric: str, now: datetime | None = None, starts_at: datetime | None = None, ends_at: datetime | None = None) -> int:
    """Count valid sessions or unique reading time within the requested cycle."""
    now = now or datetime.now(timezone.utc)
    valid = []
    for session in sessions:
        started, ended = session.StartedAt, session.EndedAt
        if session.State not in ("COMPLETED", "FINISHED") or started is None or ended is None or ended < started or ended > now:
            continue
        clipped_start = max(started, starts_at) if starts_at is not None else started
        clipped_end = min(ended, ends_at) if ends_at is not None else ended
        if clipped_end <= clipped_start:
            continue
        valid.append((clipped_start, clipped_end))
    if metric == "SESSIONS":
        return len(valid)
    seconds = union_duration_seconds(valid)
    return max(0, int(seconds // 60))


def goal_cycle_window(goal: ReadingGoal, now: datetime):
    zone = ZoneInfo(goal.Timezone)
    today = now.astimezone(zone).date()
    start = today if goal.Period == "DAILY" else today - timedelta(days=today.weekday())
    end = start + timedelta(days=1 if goal.Period == "DAILY" else 7)
    if today < goal.StartsOn or (goal.EndsOn is not None and today > goal.EndsOn):
        return None
    start = max(start, goal.StartsOn)
    if goal.EndsOn is not None:
        end = min(end, goal.EndsOn + timedelta(days=1))
    if start >= end:
        return None
    return (datetime.combine(start, time.min, tzinfo=zone).astimezone(timezone.utc),
            datetime.combine(end, time.min, tzinfo=zone).astimezone(timezone.utc))


def plan_week_window(plan: ReadingPlan, now: datetime):
    zone = ZoneInfo(plan.Timezone)
    today = now.astimezone(zone).date()
    week_start = today - timedelta(days=today.weekday())
    week_end = week_start + timedelta(days=7)
    first_day = max(week_start, plan.StartsOn)
    final_day = min(week_end - timedelta(days=1), plan.EndsOn or week_end - timedelta(days=1))
    scheduled_dates = []
    if first_day <= final_day:
        cursor = first_day
        while cursor <= final_day:
            if cursor.weekday() in (plan.Weekdays or []):
                scheduled_dates.append(cursor)
            cursor += timedelta(days=1)
    starts_at = datetime.combine(week_start, time.min, tzinfo=zone).astimezone(timezone.utc)
    ends_at = datetime.combine(week_end, time.min, tzinfo=zone).astimezone(timezone.utc)
    return starts_at, ends_at, scheduled_dates


def union_duration_seconds(intervals: list[tuple[datetime, datetime]]) -> float:
    total = 0.0
    current_start: datetime | None = None
    current_end: datetime | None = None
    for start, end in sorted(intervals):
        if current_start is None or current_end is None:
            current_start, current_end = start, end
        elif start > current_end:
            total += (current_end - current_start).total_seconds()
            current_start, current_end = start, end
        elif end > current_end:
            current_end = end
    if current_start is not None and current_end is not None:
        total += (current_end - current_start).total_seconds()
    return total


class ReadingManagementService:
    def __init__(self, repository: ReadingManagementRepository):
        self.repository = repository

    async def require_parent(self, actor_id: UUID):
        if await self.repository.role(actor_id) != "parent":
            raise ManagementForbidden()

    async def owned_child(self, actor_id: UUID, child_id: UUID) -> ChildProfile:
        child = await self.repository.owned_child(child_id, actor_id)
        if child is None:
            raise ManagementNotFound()
        return child

    async def list_goals(self, actor_id: UUID, child_id: UUID, now: datetime | None = None):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, child_id)
        now = now or datetime.now(timezone.utc)
        return [await self.goal_dict(goal, now) for goal in await self.repository.goals(child_id)]

    async def goal_dict(self, goal: ReadingGoal, now: datetime):
        """Goal plus derived progress.

        An expired goal keeps showing its final cycle's result (never a bogus 0%), and
        ``streak_cycles`` counts consecutive cycles that reached the target.
        """
        phase = item_phase(goal.Status, goal.StartsOn, goal.EndsOn, goal.Timezone, now)
        value = 0
        streak = 0
        cycle_first = cycle_last = None
        if goal.Status in ("COMPLETED", "ENDED"):
            value = goal.CompletedValue or 0
        else:
            cycles = goal_cycles(goal, now)
            if cycles:
                reference = reference_now(goal.EndsOn, goal.Timezone, now)
                upper = min(cycles[-1].ends_at, reference + timedelta(microseconds=1))
                sessions = await self.repository.completed_sessions(goal.ChildId, cycles[0].starts_at, upper)

                def value_of(cycle) -> int:
                    return completed_metric(
                        sessions, goal.Metric, now, cycle.starts_at, min(cycle.ends_at, upper)
                    )

                value = value_of(cycles[-1])
                streak = goal_streak(cycles, goal.TargetValue, value_of, last_in_progress=phase == "RUNNING")
                cycle_first, cycle_last = cycles[-1].first_day, cycles[-1].last_day
        return {
            "id": goal.Id, "child_id": goal.ChildId, "metric": goal.Metric,
            "target_value": goal.TargetValue, "period": goal.Period,
            "starts_on": goal.StartsOn, "ends_on": goal.EndsOn, "timezone": goal.Timezone,
            "status": goal.Status, "current_value": value,
            "progress_percent": min(100.0, round(value * 100 / goal.TargetValue, 1)),
            "completed_value": goal.CompletedValue, "completed_at": goal.CompletedAt,
            "created_at": goal.CreatedAt, "updated_at": goal.UpdatedAt,
            "phase": phase, "streak_cycles": streak,
            "cycle_starts_on": cycle_first, "cycle_ends_on": cycle_last,
        }

    async def create_goal(self, actor_id: UUID, payload: ReadingGoalCreate, now: datetime | None = None):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, payload.child_id)
        now = now or datetime.now(timezone.utc)
        if payload.ends_on is not None and payload.ends_on < local_date(now, payload.timezone):
            raise ManagementConflict("GOAL_ALREADY_EXPIRED")
        # Two live goals measuring the same thing per period would contradict each other.
        for existing in await self.repository.goals(payload.child_id):
            if (
                existing.Status in ("ACTIVE", "PAUSED")
                and existing.Metric == payload.metric
                and existing.Period == payload.period
                and ranges_overlap(existing.StartsOn, existing.EndsOn, payload.starts_on, payload.ends_on)
            ):
                raise ManagementConflict("GOAL_DUPLICATE")
        return await self.repository.save(ReadingGoal(
            ChildId=payload.child_id, Metric=payload.metric, TargetValue=payload.target_value,
            Period=payload.period, StartsOn=payload.starts_on, EndsOn=payload.ends_on,
            Timezone=payload.timezone, Status="ACTIVE",
        ))

    async def find_owned_goal(self, actor_id: UUID, goal_id: UUID):
        for child in await self.repository.children(actor_id):
            goal = await self.repository.goal(goal_id, child.Id)
            if goal is not None:
                return goal
        raise ManagementNotFound()

    async def update_goal(self, actor_id: UUID, goal_id: UUID, payload: ReadingGoalUpdate):
        await self.require_parent(actor_id)
        goal = await self.find_owned_goal(actor_id, goal_id)
        if goal.Status not in ("ACTIVE", "PAUSED"):
            raise ManagementConflict()
        for key, value in payload.model_dump(exclude_unset=True).items():
            if key == "target_value" and value is not None:
                goal.TargetValue = value
            elif key == "ends_on":
                if value is not None and value < goal.StartsOn:
                    raise ManagementConflict("GOAL_END_BEFORE_START")
                if value is not None and value < local_date(datetime.now(timezone.utc), goal.Timezone):
                    raise ManagementConflict("GOAL_ALREADY_EXPIRED")
                goal.EndsOn = value
        return await self.repository.save(goal)

    async def transition_goal(self, actor_id: UUID, goal_id: UUID, payload: ReadingGoalTransition):
        await self.require_parent(actor_id)
        goal = await self.find_owned_goal(actor_id, goal_id)
        allowed = {"ACTIVE": {"PAUSED", "COMPLETED", "ENDED"}, "PAUSED": {"ACTIVE", "COMPLETED", "ENDED"}, "COMPLETED": set(), "ENDED": set()}
        if payload.status not in allowed.get(goal.Status, set()):
            raise ManagementConflict()
        if payload.status in ("COMPLETED", "ENDED"):
            now = datetime.now(timezone.utc)
            # An already-expired goal records its final cycle, not a bogus 0.
            cycles = goal_cycles(goal, now, count=1)
            if cycles:
                upper = min(cycles[-1].ends_at, now + timedelta(microseconds=1))
                sessions = await self.repository.completed_sessions(goal.ChildId, cycles[-1].starts_at, upper)
                goal.CompletedValue = completed_metric(sessions, goal.Metric, now, cycles[-1].starts_at, upper)
            else:
                goal.CompletedValue = 0
            goal.CompletedAt = now
        goal.Status = payload.status
        return await self.repository.save(goal)

    async def plan_dict(self, plan: ReadingPlan, now: datetime):
        zone = ZoneInfo(plan.Timezone)
        phase = item_phase(plan.Status, plan.StartsOn, plan.EndsOn, plan.Timezone, now)
        # Once the plan has ended, keep showing its final week instead of an empty one.
        reference = reference_now(plan.EndsOn, plan.Timezone, now)
        starts_at, ends_at, scheduled_dates = plan_week_window(plan, reference)
        today = local_date(now, plan.Timezone)
        intervals_by_date: dict[date, list[tuple[datetime, datetime]]] = {}
        if scheduled_dates or phase == "RUNNING":
            sessions = await self.repository.completed_plan_sessions(
                plan.ChildId, starts_at, ends_at, now, plan.BookId
            )
            for session in sessions:
                if session.StartedAt is not None and session.EndedAt is not None:
                    session_day = session.StartedAt.astimezone(zone).date()
                    day_start, day_end = local_day_bounds(session_day, plan.Timezone)
                    interval_start = max(session.StartedAt, day_start)
                    interval_end = min(session.EndedAt, day_end)
                    if interval_end > interval_start:
                        intervals_by_date.setdefault(session_day, []).append((interval_start, interval_end))
        completed_dates = {
            scheduled_date for scheduled_date in scheduled_dates
            if union_duration_seconds(intervals_by_date.get(scheduled_date, [])) >= plan.TargetMinutes * 60
        }
        running = phase == "RUNNING"
        minutes_today = int(union_duration_seconds(intervals_by_date.get(today, [])) // 60) if running else 0
        next_day = (
            next_scheduled_date(list(plan.Weekdays or []), plan.StartsOn, plan.EndsOn, today)
            if plan.Status == "ACTIVE" and phase != "EXPIRED"
            else None
        )
        scheduled_count = len(scheduled_dates)
        completed_count = len(completed_dates)
        book = await self.repository.book(plan.BookId) if plan.BookId else None
        return {
            "id": plan.Id,
            "child_id": plan.ChildId,
            "book_id": plan.BookId,
            "book_title": book.Title if book else None,
            "title": plan.Title,
            "target_minutes": plan.TargetMinutes,
            "weekdays": list(plan.Weekdays or []),
            "starts_on": plan.StartsOn,
            "ends_on": plan.EndsOn,
            "timezone": plan.Timezone,
            "status": plan.Status,
            "scheduled_days_this_week": scheduled_count,
            "completed_days_this_week": completed_count,
            "progress_percent": round(completed_count * 100 / scheduled_count, 1) if scheduled_count else 0,
            "completed_at": plan.CompletedAt,
            "created_at": plan.CreatedAt,
            "updated_at": plan.UpdatedAt,
            "phase": phase,
            "next_scheduled_date": next_day,
            "is_scheduled_today": plan.Status == "ACTIVE" and running and today in scheduled_dates,
            "minutes_today": minutes_today,
        }

    async def list_plans(self, actor_id: UUID, child_id: UUID, now: datetime | None = None):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, child_id)
        now = now or datetime.now(timezone.utc)
        return [await self.plan_dict(plan, now) for plan in await self.repository.plans(child_id)]

    @staticmethod
    def check_plan_schedule(
        weekdays: list[int], starts_on: date, ends_on: date | None, timezone_name: str, now: datetime,
        *, check_expiry: bool = True,
    ) -> None:
        if check_expiry and ends_on is not None and ends_on < local_date(now, timezone_name):
            raise ManagementConflict("PLAN_ALREADY_EXPIRED")
        if not has_scheduled_day(weekdays, starts_on, ends_on):
            raise ManagementConflict("PLAN_NO_SCHEDULED_DAY")

    async def create_plan(self, actor_id: UUID, payload: ReadingPlanCreate, now: datetime | None = None):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, payload.child_id)
        self.check_plan_schedule(
            payload.weekdays, payload.starts_on, payload.ends_on, payload.timezone,
            now or datetime.now(timezone.utc),
        )
        if payload.book_id is not None and await self.repository.eligible_book(payload.book_id) is None:
            raise ManagementConflict("BOOK_UNAVAILABLE")
        return await self.repository.save(ReadingPlan(
            ChildId=payload.child_id,
            BookId=payload.book_id,
            Title=payload.title,
            TargetMinutes=payload.target_minutes,
            Weekdays=payload.weekdays,
            StartsOn=payload.starts_on,
            EndsOn=payload.ends_on,
            Timezone=payload.timezone,
            Status="ACTIVE",
        ))

    async def find_owned_plan(self, actor_id: UUID, plan_id: UUID):
        plan = await self.repository.plan_for_actor(plan_id, actor_id)
        if plan is None:
            raise ManagementNotFound()
        return plan

    async def update_plan(self, actor_id: UUID, plan_id: UUID, payload: ReadingPlanUpdate):
        await self.require_parent(actor_id)
        plan = await self.find_owned_plan(actor_id, plan_id)
        if plan.Status not in ("ACTIVE", "PAUSED"):
            raise ManagementConflict()
        changes = payload.model_dump(exclude_unset=True)
        if "ends_on" in changes and changes["ends_on"] is not None and changes["ends_on"] < plan.StartsOn:
            raise ManagementConflict("GOAL_END_BEFORE_START")
        self.check_plan_schedule(
            changes.get("weekdays", list(plan.Weekdays or [])),
            plan.StartsOn,
            changes["ends_on"] if "ends_on" in changes else plan.EndsOn,
            changes.get("timezone", plan.Timezone),
            datetime.now(timezone.utc),
            check_expiry="ends_on" in changes,
        )
        if changes.get("book_id") is not None and await self.repository.eligible_book(changes["book_id"]) is None:
            raise ManagementConflict("BOOK_UNAVAILABLE")
        for key, value in changes.items():
            if key == "title": plan.Title = value
            elif key == "book_id": plan.BookId = value
            elif key == "target_minutes": plan.TargetMinutes = value
            elif key == "weekdays": plan.Weekdays = value
            elif key == "ends_on": plan.EndsOn = value
            elif key == "timezone": plan.Timezone = value
        return await self.repository.save(plan)

    async def transition_plan(self, actor_id: UUID, plan_id: UUID, payload: ReadingPlanTransition):
        await self.require_parent(actor_id)
        plan = await self.find_owned_plan(actor_id, plan_id)
        allowed = {
            "ACTIVE": {"PAUSED", "COMPLETED", "ENDED"},
            "PAUSED": {"ACTIVE", "COMPLETED", "ENDED"},
            "COMPLETED": set(),
            "ENDED": set(),
        }
        if payload.status not in allowed.get(plan.Status, set()):
            raise ManagementConflict()
        if payload.status in ("COMPLETED", "ENDED"):
            plan.CompletedAt = datetime.now(timezone.utc)
        plan.Status = payload.status
        return await self.repository.save(plan)

    async def list_collections(self, actor_id: UUID, child_id: UUID):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, child_id)
        result = []
        for row, book in await self.repository.collections(child_id):
            result.append({
                "id": row.Id, "child_id": row.ChildId, "book_id": row.BookId,
                "collection_type": row.CollectionType, "created_at": row.CreatedAt,
                "book": {"id": book.Id, "title": book.Title, "author": book.Author,
                         "min_grade": book.MinGrade, "max_grade": book.MaxGrade,
                         "lifecycle_status": book.LifecycleStatus,
                         "available_to_read": await self.repository.eligible_book(book.Id) is not None},
            })
        return result

    async def add_collection(self, actor_id: UUID, book_id: UUID, payload: ChildBookCollectionCreate):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, payload.child_id)
        if await self.repository.book(book_id) is None:
            raise ManagementNotFound()
        if await self.repository.eligible_book(book_id) is None:
            raise ManagementConflict()
        return await self.repository.add_collection_idempotent(payload.child_id, book_id, payload.collection_type)

    async def remove_collection(self, actor_id: UUID, child_id: UUID, book_id: UUID, collection_type: str):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, child_id)
        row = await self.repository.collection(child_id, book_id, collection_type)
        if row is None:
            raise ManagementNotFound()
        await self.repository.remove_collection(row)

    @staticmethod
    def reminder_dict(row: ReadingReminder):
        return {"id": row.Id, "child_id": row.ChildId, "remind_at": row.RemindAt,
                "weekdays": list(row.Weekdays or []), "timezone": row.Timezone,
                "is_active": row.IsActive, "email_enabled": row.EmailEnabled,
                "deleted_at": row.DeletedAt,
                "created_at": row.CreatedAt, "updated_at": row.UpdatedAt}

    async def list_reminders(self, actor_id: UUID, child_id: UUID):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, child_id)
        return [self.reminder_dict(row) for row in await self.repository.reminders(child_id)]

    async def ensure_reminder_unique(
        self, child_id: UUID, remind_at: time, timezone_name: str, weekdays: list[int], ignore_id: UUID | None = None
    ) -> None:
        """No two live reminders for one child may fire at the same time on the same day."""
        for other in await self.repository.reminders(child_id):
            if (
                other.Id != ignore_id
                and other.IsActive
                and other.Timezone == timezone_name
                and same_minute(other.RemindAt, remind_at)
                and weekdays_overlap(list(other.Weekdays or []), weekdays)
            ):
                raise ManagementConflict("REMINDER_DUPLICATE")

    async def create_reminder(self, actor_id: UUID, payload: ReadingReminderCreate):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, payload.child_id)
        if payload.is_active:
            await self.ensure_reminder_unique(
                payload.child_id, payload.remind_at, payload.timezone, payload.weekdays
            )
        return self.reminder_dict(await self.repository.save(ReadingReminder(
            ChildId=payload.child_id, RemindAt=payload.remind_at, Weekdays=payload.weekdays,
            Timezone=payload.timezone, IsActive=payload.is_active,
            EmailEnabled=payload.email_enabled, DeletedAt=None,
        )))

    async def update_reminder(self, actor_id: UUID, reminder_id: UUID, payload: ReadingReminderUpdate):
        await self.require_parent(actor_id)
        reminder = await self.repository.reminder_for_actor(reminder_id, actor_id)
        if reminder is None:
            raise ManagementNotFound()
        changes = payload.model_dump(exclude_unset=True)
        schedule_changed = any(key in changes for key in ("remind_at", "weekdays", "timezone", "is_active"))
        if schedule_changed and changes.get("is_active", reminder.IsActive):
            await self.ensure_reminder_unique(
                reminder.ChildId,
                changes.get("remind_at", reminder.RemindAt),
                changes.get("timezone", reminder.Timezone),
                changes.get("weekdays", list(reminder.Weekdays or [])),
                ignore_id=reminder.Id,
            )
        for key, value in changes.items():
            if key == "remind_at": reminder.RemindAt = value
            elif key == "weekdays": reminder.Weekdays = value
            elif key == "timezone": reminder.Timezone = value
            elif key == "is_active": reminder.IsActive = value
            elif key == "email_enabled": reminder.EmailEnabled = value
        saved = await self.repository.save(reminder)
        await self.repository.refresh_unsent_email_occurrences(saved)
        return self.reminder_dict(saved)

    async def delete_reminder(self, actor_id: UUID, reminder_id: UUID):
        await self.require_parent(actor_id)
        reminder = await self.repository.reminder_for_actor(reminder_id, actor_id)
        if reminder is None:
            raise ManagementNotFound()
        reminder.IsActive = False
        reminder.DeletedAt = datetime.now(timezone.utc)
        await self.repository.save(reminder)
        await self.repository.refresh_unsent_email_occurrences(reminder)

    async def due_reminders(self, actor_id: UUID, child_id: UUID, now: datetime | None = None):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, child_id)
        result = []
        for occurrence, reminder in await self.repository.due_occurrences(child_id, now or datetime.now(timezone.utc)):
            result.append({"id": occurrence.Id, "reminder_id": occurrence.ReminderId,
                "scheduled_local_date": occurrence.ScheduledLocalDate, "scheduled_for": occurrence.ScheduledFor,
                "status": occurrence.Status, "acknowledged_at": occurrence.AcknowledgedAt,
                "email_status": occurrence.EmailStatus,
                "email_attempts": occurrence.EmailAttempts,
                "email_sent_at": occurrence.EmailSentAt,
                "email_error_code": occurrence.EmailErrorCode,
                "reminder": self.reminder_dict(reminder)})
        return result

    async def acknowledge_occurrence(self, actor_id: UUID, occurrence_id: UUID):
        await self.require_parent(actor_id)
        occurrence = await self.repository.occurrence_for_parent(occurrence_id, actor_id)
        if occurrence is None:
            raise ManagementNotFound()
        if occurrence.Status != "ACKNOWLEDGED":
            occurrence.Status = "ACKNOWLEDGED"
            occurrence.AcknowledgedAt = datetime.now(timezone.utc)
            if occurrence.EmailStatus in ("PENDING", "RETRY"):
                occurrence.EmailStatus = "NOT_REQUESTED"
                occurrence.EmailNextAttemptAt = None
                occurrence.EmailErrorCode = None
            await self.repository.save(occurrence)
        return {"id": occurrence.Id, "reminder_id": occurrence.ReminderId,
                "scheduled_local_date": occurrence.ScheduledLocalDate, "scheduled_for": occurrence.ScheduledFor,
                "status": occurrence.Status, "acknowledged_at": occurrence.AcknowledgedAt,
                "email_status": occurrence.EmailStatus,
                "email_attempts": occurrence.EmailAttempts,
                "email_sent_at": occurrence.EmailSentAt,
                "email_error_code": occurrence.EmailErrorCode,
                "reminder": None}
