from datetime import datetime, time, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

from app.models import ChildProfile
from app.models.reading_management import ChildBookCollection, ReadingGoal, ReadingReminder
from app.repositories.reading_management_repository import ReadingManagementRepository
from app.database.config import (
    RESEND_API_KEY, READING_REMINDER_FROM_EMAIL, READING_REMINDER_APP_URL,
    SUPABASE_ADMIN_KEY,
)
from app.providers.supabase_auth_contact_provider import SupabaseAuthContactProvider
from app.schemas.reading_management import ReadingGoalCreate, ReadingGoalUpdate, ReadingGoalTransition, ChildBookCollectionCreate, ReadingReminderCreate, ReadingReminderUpdate


class ManagementNotFound(Exception):
    pass


class ManagementForbidden(Exception):
    pass


class ManagementConflict(Exception):
    pass


def completed_metric(sessions, metric: str, now: datetime | None = None, starts_at: datetime | None = None, ends_at: datetime | None = None) -> int:
    """Count completed sessions and clip valid duration to the requested cycle."""
    now = now or datetime.now(timezone.utc)
    valid = []
    for session in sessions:
        started, ended = session.StartedAt, session.EndedAt
        if session.State not in ("COMPLETED", "FINISHED") or started is None or ended is None or ended < started or ended > now:
            continue
        clipped_start = max(started, starts_at) if starts_at is not None else started
        clipped_end = min(ended, ends_at) if ends_at is not None else ended
        if clipped_end < clipped_start:
            continue
        valid.append((clipped_start, clipped_end))
    if metric == "SESSIONS":
        return len(valid)
    seconds = sum((ended - started).total_seconds() for started, ended in valid)
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
        response = []
        for goal in await self.repository.goals(child_id):
            window = goal_cycle_window(goal, now)
            value = goal.CompletedValue if goal.Status in ("COMPLETED", "ENDED") and goal.CompletedValue is not None else 0
            if goal.Status not in ("COMPLETED", "ENDED") and window:
                sessions = await self.repository.completed_sessions(child_id, window[0], min(window[1], now + timedelta(microseconds=1)))
                value = completed_metric(sessions, goal.Metric, now, window[0], min(window[1], now + timedelta(microseconds=1)))
            response.append({
                "id": goal.Id, "child_id": goal.ChildId, "metric": goal.Metric,
                "target_value": goal.TargetValue, "period": goal.Period,
                "starts_on": goal.StartsOn, "ends_on": goal.EndsOn, "timezone": goal.Timezone,
                "status": goal.Status, "current_value": value,
                "progress_percent": min(100.0, round(value * 100 / goal.TargetValue, 1)),
                "completed_value": goal.CompletedValue, "completed_at": goal.CompletedAt,
                "created_at": goal.CreatedAt, "updated_at": goal.UpdatedAt,
            })
        return response

    async def create_goal(self, actor_id: UUID, payload: ReadingGoalCreate):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, payload.child_id)
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
                    raise ManagementConflict()
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
            window = goal_cycle_window(goal, now)
            sessions = await self.repository.completed_sessions(goal.ChildId, window[0], min(window[1], now + timedelta(microseconds=1))) if window else []
            goal.CompletedValue = completed_metric(sessions, goal.Metric, now, window[0], min(window[1], now + timedelta(microseconds=1)))
            goal.CompletedAt = now
        goal.Status = payload.status
        return await self.repository.save(goal)

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
                "latest_email_status": None, "deleted_at": row.DeletedAt,
                "created_at": row.CreatedAt, "updated_at": row.UpdatedAt}

    async def list_reminders(self, actor_id: UUID, child_id: UUID):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, child_id)
        result = []
        for row in await self.repository.reminders(child_id):
            item = self.reminder_dict(row)
            item["latest_email_status"] = await self.repository.latest_email_status(row.Id)
            result.append(item)
        return result

    async def create_reminder(self, actor_id: UUID, payload: ReadingReminderCreate):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, payload.child_id)
        return self.reminder_dict(await self.repository.save(ReadingReminder(
            ChildId=payload.child_id, RemindAt=payload.remind_at, Weekdays=payload.weekdays,
            Timezone=payload.timezone, IsActive=payload.is_active,
            EmailEnabled=payload.email_enabled,
            EmailEnabledAt=datetime.now(timezone.utc) if payload.email_enabled else None,
            DeletedAt=None,
        )))

    async def update_reminder(self, actor_id: UUID, reminder_id: UUID, payload: ReadingReminderUpdate):
        await self.require_parent(actor_id)
        reminder = await self.repository.reminder_for_actor(reminder_id, actor_id)
        if reminder is None:
            raise ManagementNotFound()
        was_active = reminder.IsActive
        was_email_enabled = reminder.EmailEnabled
        for key, value in payload.model_dump(exclude_unset=True).items():
            if key == "remind_at":
                reminder.RemindAt = value
            elif key == "weekdays":
                reminder.Weekdays = value
            elif key == "timezone":
                reminder.Timezone = value
            elif key == "is_active":
                reminder.IsActive = value
            elif key == "email_enabled":
                reminder.EmailEnabled = value
        # Re-enabling a schedule is an explicit new opt-in moment. Do not catch up
        # any occurrence that passed while the reminder/email option was disabled.
        if not reminder.IsActive or not reminder.EmailEnabled:
            reminder.EmailEnabledAt = None
        elif not was_active or not was_email_enabled:
            reminder.EmailEnabledAt = datetime.now(timezone.utc)
        return self.reminder_dict(await self.repository.save(reminder))

    async def delete_reminder(self, actor_id: UUID, reminder_id: UUID):
        await self.require_parent(actor_id)
        reminder = await self.repository.reminder_for_actor(reminder_id, actor_id)
        if reminder is None:
            raise ManagementNotFound()
        reminder.IsActive = False
        reminder.DeletedAt = datetime.now(timezone.utc)
        await self.repository.save(reminder)

    async def due_reminders(self, actor_id: UUID, child_id: UUID, now: datetime | None = None):
        await self.require_parent(actor_id)
        await self.owned_child(actor_id, child_id)
        result = []
        for occurrence, reminder in await self.repository.due_occurrences(child_id, now or datetime.now(timezone.utc)):
            result.append({"id": occurrence.Id, "reminder_id": occurrence.ReminderId,
                "scheduled_local_date": occurrence.ScheduledLocalDate, "scheduled_for": occurrence.ScheduledFor,
                "status": occurrence.Status, "acknowledged_at": occurrence.AcknowledgedAt,
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
            await self.repository.save(occurrence)
        return {"id": occurrence.Id, "reminder_id": occurrence.ReminderId,
                "scheduled_local_date": occurrence.ScheduledLocalDate, "scheduled_for": occurrence.ScheduledFor,
                "status": occurrence.Status, "acknowledged_at": occurrence.AcknowledgedAt, "reminder": None}


    async def reminder_email_status(self, actor_id: UUID):
        """Return readiness metadata only; never return the recipient's email address."""
        await self.require_parent(actor_id)
        contact = await SupabaseAuthContactProvider().get_contact_info(actor_id)
        provider_configured = bool(RESEND_API_KEY)
        sender_configured = bool(READING_REMINDER_FROM_EMAIL)
        app_url_configured = bool(READING_REMINDER_APP_URL)
        auth_admin_configured = bool(SUPABASE_ADMIN_KEY)
        email_available = bool(contact.get("email"))
        email_verified = contact.get("email_verified")
        ready = (
            provider_configured and sender_configured and app_url_configured
            and auth_admin_configured and email_available and email_verified is True
        )
        return {
            "provider_configured": provider_configured,
            "sender_configured": sender_configured,
            "app_url_configured": app_url_configured,
            "auth_admin_configured": auth_admin_configured,
            "email_available": email_available,
            "email_verified": email_verified,
            "ready": ready,
        }
