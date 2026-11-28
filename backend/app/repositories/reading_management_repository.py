from datetime import datetime, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import and_, case, exists, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, BookPage, ChildProfile, PageRevision, Profile, ReadingSession
from app.models.reading_management import (
    ChildBookCollection,
    ReadingGoal,
    ReadingPlan,
    ReadingReminder,
    ReadingReminderOccurrence,
)
from app.repositories.book_repository import CatalogRepository
from app.services.reading_management_rules import STALE_REMINDER_HOURS, local_day_bounds
from app.services.reading_reminder_schedule import local_schedule_to_utc


class ReadingManagementRepository:
    """SQLAlchemy persistence only; no authorization or HTTP response handling."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        from app.database.role_cache import get_cached_profile_role
        return await get_cached_profile_role(self.db, actor_id)

    async def owned_child(self, child_id: UUID, actor_id: UUID) -> ChildProfile | None:
        return await self.db.scalar(select(ChildProfile).where(ChildProfile.Id == child_id, ChildProfile.ParentId == actor_id))

    async def children(self, actor_id: UUID) -> list[ChildProfile]:
        result = await self.db.execute(select(ChildProfile).where(ChildProfile.ParentId == actor_id))
        return list(result.scalars().all())

    async def eligible_book(
        self, book_id: UUID, *, actor_id: UUID | None = None
    ) -> Book | None:
        return await self.db.scalar(
            select(Book).where(
                Book.Id == book_id,
                CatalogRepository.readable_book(actor_id),
            )
        )

    async def book(
        self, book_id: UUID, *, actor_id: UUID | None = None
    ) -> Book | None:
        from app.policies.book_access import is_catalog_book, is_private_book_owned_by

        visibility = (
            or_(is_catalog_book(), is_private_book_owned_by(actor_id))
            if actor_id is not None
            else is_catalog_book()
        )
        return await self.db.scalar(
            select(Book).where(Book.Id == book_id, visibility)
        )

    async def goals(self, child_id: UUID) -> list[ReadingGoal]:
        result = await self.db.execute(select(ReadingGoal).where(ReadingGoal.ChildId == child_id).order_by(ReadingGoal.CreatedAt.desc(), ReadingGoal.Id))
        return list(result.scalars().all())

    async def plans(self, child_id: UUID) -> list[ReadingPlan]:
        result = await self.db.execute(
            select(ReadingPlan)
            .where(ReadingPlan.ChildId == child_id)
            .order_by(ReadingPlan.Status, ReadingPlan.CreatedAt.desc(), ReadingPlan.Id)
        )
        return list(result.scalars().all())

    async def plan_for_actor(self, plan_id: UUID, actor_id: UUID) -> ReadingPlan | None:
        return await self.db.scalar(
            select(ReadingPlan)
            .join(ChildProfile, ChildProfile.Id == ReadingPlan.ChildId)
            .where(ReadingPlan.Id == plan_id, ChildProfile.ParentId == actor_id)
        )

    async def goal(self, goal_id: UUID, child_id: UUID) -> ReadingGoal | None:
        return await self.db.scalar(select(ReadingGoal).where(ReadingGoal.Id == goal_id, ReadingGoal.ChildId == child_id))

    async def completed_sessions(self, child_id: UUID, starts_at: datetime, ends_at: datetime) -> list[ReadingSession]:
        result = await self.db.execute(select(ReadingSession).where(
            ReadingSession.ChildId == child_id, ReadingSession.State.in_(("COMPLETED", "FINISHED")),
            ReadingSession.EndedAt.is_not(None), ReadingSession.EndedAt >= starts_at,
            ReadingSession.EndedAt < ends_at, ReadingSession.StartedAt < ends_at,
            ReadingSession.EndedAt >= ReadingSession.StartedAt,
        ).order_by(ReadingSession.EndedAt, ReadingSession.Id))
        return list(result.scalars().all())

    async def child_read_between(self, child_id: UUID, starts_at: datetime, ends_at: datetime) -> bool:
        """True when the child finished a valid reading session inside [starts_at, ends_at)."""
        return bool(await self.db.scalar(select(exists().where(
            ReadingSession.ChildId == child_id,
            ReadingSession.State.in_(("COMPLETED", "FINISHED")),
            ReadingSession.StartedAt.is_not(None),
            ReadingSession.EndedAt.is_not(None),
            ReadingSession.EndedAt >= ReadingSession.StartedAt,
            ReadingSession.EndedAt >= starts_at,
            ReadingSession.EndedAt < ends_at,
        ))))

    async def children_read_in_windows(
        self,
        windows: list[tuple[UUID, datetime, datetime]],
    ) -> set[tuple[UUID, datetime, datetime]]:
        """Batch-check which (child_id, starts_at, ends_at) windows have a completed session in 1 query."""
        unique_windows = list(dict.fromkeys(windows))
        if not unique_windows:
            return set()
        if len(unique_windows) == 1:
            child_id, starts_at, ends_at = unique_windows[0]
            if await self.child_read_between(child_id, starts_at, ends_at):
                return {(child_id, starts_at, ends_at)}
            return set()

        child_ids = list({w[0] for w in unique_windows})
        min_start = min(w[1] for w in unique_windows)
        max_end = max(w[2] for w in unique_windows)
        result = await self.db.execute(
            select(ReadingSession.ChildId, ReadingSession.EndedAt).where(
                ReadingSession.ChildId.in_(child_ids),
                ReadingSession.State.in_(("COMPLETED", "FINISHED")),
                ReadingSession.StartedAt.is_not(None),
                ReadingSession.EndedAt.is_not(None),
                ReadingSession.EndedAt >= ReadingSession.StartedAt,
                ReadingSession.EndedAt >= min_start,
                ReadingSession.EndedAt < max_end,
            )
        )
        ended_by_child: dict[UUID, list[datetime]] = {}
        for cid, ended_at in result.all():
            if ended_at is None:
                continue
            ended_by_child.setdefault(cid, []).append(ended_at)

        matched: set[tuple[UUID, datetime, datetime]] = set()
        for child_id, starts_at, ends_at in unique_windows:
            for ended_at in ended_by_child.get(child_id, ()):
                comparable_end = (
                    ended_at.replace(tzinfo=timezone.utc)
                    if ended_at.tzinfo is None and starts_at.tzinfo is not None
                    else ended_at
                )
                if starts_at <= comparable_end < ends_at:
                    matched.add((child_id, starts_at, ends_at))
                    break
        return matched

    @staticmethod
    def mark_read_acknowledged(occurrence: ReadingReminderOccurrence, now: datetime) -> None:
        """The child already read that day, so the reminder (and its email) is moot."""
        occurrence.Status = "ACKNOWLEDGED"
        occurrence.AcknowledgedAt = now
        if occurrence.EmailStatus in ("NOT_REQUESTED", "PENDING", "RETRY"):
            occurrence.EmailStatus = "NOT_REQUESTED"
        occurrence.EmailNextAttemptAt = None
        occurrence.EmailErrorCode = None

    async def completed_plan_sessions(
        self,
        child_id: UUID,
        starts_at: datetime,
        ends_at: datetime,
        now: datetime,
        book_id: UUID | None = None,
    ) -> list[ReadingSession]:
        query = select(ReadingSession).where(
            ReadingSession.ChildId == child_id,
            ReadingSession.State.in_(("COMPLETED", "FINISHED")),
            ReadingSession.StartedAt.is_not(None),
            ReadingSession.EndedAt.is_not(None),
            ReadingSession.StartedAt >= starts_at,
            ReadingSession.StartedAt < ends_at,
            ReadingSession.EndedAt >= ReadingSession.StartedAt,
            ReadingSession.EndedAt <= now,
        )
        if book_id is not None:
            query = query.where(ReadingSession.BookId == book_id)
        result = await self.db.execute(query.order_by(ReadingSession.StartedAt, ReadingSession.Id))
        return list(result.scalars().all())

    async def save(self, obj):
        self.db.add(obj)
        try:
            await self.db.commit()
            await self.db.refresh(obj)
        except Exception:
            await self.db.rollback()
            raise
        return obj

    async def collection(self, child_id: UUID, book_id: UUID, collection_type: str) -> ChildBookCollection | None:
        return await self.db.scalar(select(ChildBookCollection).where(
            ChildBookCollection.ChildId == child_id, ChildBookCollection.BookId == book_id,
            ChildBookCollection.CollectionType == collection_type,
        ))

    async def add_collection_idempotent(self, child_id: UUID, book_id: UUID, collection_type: str) -> ChildBookCollection:
        statement = insert(ChildBookCollection).values(
            ChildId=child_id, BookId=book_id, CollectionType=collection_type,
        ).on_conflict_do_nothing(index_elements=["childid", "bookid", "collectiontype"])
        await self.db.execute(statement)
        await self.db.commit()
        row = await self.collection(child_id, book_id, collection_type)
        if row is None:
            raise RuntimeError("Saved book row was not persisted")
        return row

    async def collections(self, child_id: UUID) -> list[tuple[ChildBookCollection, Book]]:
        result = await self.db.execute(select(ChildBookCollection, Book).join(Book, Book.Id == ChildBookCollection.BookId)
            .where(ChildBookCollection.ChildId == child_id)
            .order_by(ChildBookCollection.CollectionType, ChildBookCollection.CreatedAt.desc(), Book.Title))
        return [(row[0], row[1]) for row in result.all()]

    async def remove_collection(self, row: ChildBookCollection) -> None:
        await self.db.delete(row)
        await self.db.commit()

    async def reminders(self, child_id: UUID, include_deleted: bool = False) -> list[ReadingReminder]:
        query = select(ReadingReminder).where(ReadingReminder.ChildId == child_id)
        if not include_deleted:
            query = query.where(ReadingReminder.DeletedAt.is_(None))
        result = await self.db.execute(query.order_by(ReadingReminder.CreatedAt.desc(), ReadingReminder.Id))
        return list(result.scalars().all())

    async def active_reminders_for_worker(self) -> list[ReadingReminder]:
        result = await self.db.execute(
            select(ReadingReminder).where(
                ReadingReminder.IsActive.is_(True),
                ReadingReminder.DeletedAt.is_(None),
            )
        )
        return list(result.scalars().all())

    async def refresh_unsent_email_occurrences(self, reminder: ReadingReminder) -> None:
        result = await self.db.execute(
            select(ReadingReminderOccurrence).where(
                ReadingReminderOccurrence.ReminderId == reminder.Id,
                ReadingReminderOccurrence.Status == "PENDING",
                ReadingReminderOccurrence.EmailStatus.in_(("NOT_REQUESTED", "PENDING", "RETRY")),
            )
        )
        for occurrence in result.scalars().all():
            scheduled_for = None
            if (
                reminder.IsActive
                and reminder.DeletedAt is None
                and reminder.EmailEnabled
                and occurrence.ScheduledLocalDate.weekday() in reminder.Weekdays
            ):
                scheduled_for = local_schedule_to_utc(
                    occurrence.ScheduledLocalDate,
                    reminder.RemindAt,
                    reminder.Timezone,
                )
            occurrence.ScheduledFor = scheduled_for or occurrence.ScheduledFor
            occurrence.EmailStatus = "PENDING" if scheduled_for is not None else "NOT_REQUESTED"
            occurrence.EmailAttempts = 0
            occurrence.EmailLastAttemptAt = None
            occurrence.EmailNextAttemptAt = None
            occurrence.EmailSentAt = None
            occurrence.EmailErrorCode = None
        await self.db.commit()

    async def create_due_occurrences_for_worker(self, now: datetime) -> int:
        rows_to_insert: list[dict[str, object]] = []
        seen_keys: set[tuple[UUID, object]] = set()
        for reminder in await self.active_reminders_for_worker():
            try:
                local_now = now.astimezone(ZoneInfo(reminder.Timezone))
            except (ZoneInfoNotFoundError, ValueError):
                continue
            if local_now.weekday() not in reminder.Weekdays:
                continue
            local_date = local_now.date()
            scheduled_for = local_schedule_to_utc(
                local_date, reminder.RemindAt, reminder.Timezone
            )
            if scheduled_for is None or scheduled_for > now:
                continue
            dedupe = (reminder.Id, local_date)
            if dedupe in seen_keys:
                continue
            seen_keys.add(dedupe)
            rows_to_insert.append(
                {
                    "ReminderId": reminder.Id,
                    "ScheduledLocalDate": local_date,
                    "ScheduledFor": scheduled_for,
                    "Status": "PENDING",
                    "EmailStatus": "PENDING" if reminder.EmailEnabled else "NOT_REQUESTED",
                }
            )
        if not rows_to_insert:
            return 0
        statement = (
            insert(ReadingReminderOccurrence)
            .values(rows_to_insert)
            .on_conflict_do_nothing(
                index_elements=["reminderid", "scheduledlocaldate"]
            )
        )
        result = await self.db.execute(statement)
        await self.db.commit()
        return max(0, int(result.rowcount or 0))

    async def claim_due_email_occurrences(
        self,
        now: datetime,
        *,
        limit: int = 5,
        max_attempts: int = 5,
        stale_after: timedelta = timedelta(minutes=5),
    ) -> list[tuple[ReadingReminderOccurrence, ReadingReminder, ChildProfile]]:
        stale_before = now - stale_after
        stale_cutoff = now - timedelta(hours=STALE_REMINDER_HOURS)
        retry_limit_cond = and_(
            ReadingReminderOccurrence.EmailStatus == "SENDING",
            ReadingReminderOccurrence.EmailAttempts >= max_attempts,
            ReadingReminderOccurrence.EmailLastAttemptAt <= stale_before,
        )
        expired_cond = and_(
            ReadingReminderOccurrence.EmailStatus.in_(("PENDING", "RETRY", "SENDING")),
            ReadingReminderOccurrence.ScheduledFor < stale_cutoff,
        )
        cleanup_res = await self.db.execute(
            update(ReadingReminderOccurrence)
            .where(or_(retry_limit_cond, expired_cond))
            .values(
                EmailStatus="FAILED",
                EmailErrorCode=case(
                    (retry_limit_cond, "DELIVERY_RETRY_LIMIT"),
                    else_="REMINDER_EXPIRED",
                ),
                EmailNextAttemptAt=None,
            )
        )
        if (cleanup_res.rowcount or 0) > 0:
            await self.db.commit()
        retryable = or_(
            ReadingReminderOccurrence.EmailStatus == "PENDING",
            and_(
                ReadingReminderOccurrence.EmailStatus == "RETRY",
                ReadingReminderOccurrence.EmailNextAttemptAt <= now,
            ),
            and_(
                ReadingReminderOccurrence.EmailStatus == "SENDING",
                ReadingReminderOccurrence.EmailLastAttemptAt <= stale_before,
            ),
        )
        statement = (
            select(ReadingReminderOccurrence, ReadingReminder, ChildProfile)
            .join(
                ReadingReminder,
                ReadingReminder.Id == ReadingReminderOccurrence.ReminderId,
            )
            .join(ChildProfile, ChildProfile.Id == ReadingReminder.ChildId)
            .join(Profile, Profile.Id == ChildProfile.ParentId)
            .where(
                Profile.Active == 1,
                ReadingReminderOccurrence.Status == "PENDING",
                ReadingReminderOccurrence.ScheduledFor <= now,
                ReadingReminderOccurrence.ScheduledFor >= stale_cutoff,
                ReadingReminderOccurrence.EmailAttempts < max_attempts,
                ReadingReminder.EmailEnabled.is_(True),
                ReadingReminder.IsActive.is_(True),
                ReadingReminder.DeletedAt.is_(None),
                retryable,
            )
            .order_by(
                ReadingReminderOccurrence.ScheduledFor,
                ReadingReminderOccurrence.Id,
            )
            .limit(limit)
            .with_for_update(skip_locked=True, of=ReadingReminderOccurrence)
        )
        result = await self.db.execute(statement)
        rows = list(result.all())
        if not rows:
            await self.db.rollback()
            return []
        windows = [
            (child.Id, *local_day_bounds(occurrence.ScheduledLocalDate, reminder.Timezone))
            for occurrence, reminder, child in rows
        ]
        read_windows = await self.children_read_in_windows(windows)
        to_send = []
        for (occurrence, reminder, child), window in zip(rows, windows):
            if window in read_windows:
                # No "time to read" email when the child already read that day.
                self.mark_read_acknowledged(occurrence, now)
                continue
            occurrence.EmailStatus = "SENDING"
            occurrence.EmailAttempts += 1
            occurrence.EmailLastAttemptAt = now
            occurrence.EmailNextAttemptAt = None
            occurrence.EmailErrorCode = None
            to_send.append((occurrence, reminder, child))
        await self.db.commit()
        return to_send

    async def update_email_delivery(
        self,
        occurrence_id: UUID,
        *,
        status: str,
        now: datetime,
        error_code: str | None = None,
        next_attempt_at: datetime | None = None,
    ) -> None:
        values: dict[str, object] = {
            "EmailStatus": status,
            "EmailErrorCode": error_code,
            "EmailNextAttemptAt": next_attempt_at,
        }
        if status == "SENT":
            values["EmailSentAt"] = now
        try:
            await self.db.execute(
                update(ReadingReminderOccurrence)
                .where(ReadingReminderOccurrence.Id == occurrence_id)
                .values(**values)
            )
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise

    async def reminder(self, reminder_id: UUID, child_id: UUID) -> ReadingReminder | None:
        return await self.db.scalar(select(ReadingReminder).where(
            ReadingReminder.Id == reminder_id, ReadingReminder.ChildId == child_id, ReadingReminder.DeletedAt.is_(None)))

    async def reminder_for_actor(self, reminder_id: UUID, actor_id: UUID) -> ReadingReminder | None:
        return await self.db.scalar(select(ReadingReminder).join(ChildProfile, ChildProfile.Id == ReadingReminder.ChildId)
            .where(ReadingReminder.Id == reminder_id, ChildProfile.ParentId == actor_id, ReadingReminder.DeletedAt.is_(None)))

    async def due_occurrences(self, child_id: UUID, now: datetime) -> list[tuple[ReadingReminderOccurrence, ReadingReminder]]:
        rows_to_insert: list[dict[str, object]] = []
        seen_keys: set[tuple[UUID, object]] = set()
        for reminder in await self.reminders(child_id):
            try:
                local_now = now.astimezone(ZoneInfo(reminder.Timezone))
            except (ZoneInfoNotFoundError, ValueError):
                continue
            if not reminder.IsActive or local_now.weekday() not in reminder.Weekdays or local_now.time().replace(tzinfo=None) < reminder.RemindAt:
                continue
            local_date = local_now.date()
            scheduled_for = local_schedule_to_utc(local_date, reminder.RemindAt, reminder.Timezone)
            if scheduled_for is None:
                continue
            dedupe = (reminder.Id, local_date)
            if dedupe in seen_keys:
                continue
            seen_keys.add(dedupe)
            rows_to_insert.append(
                {
                    "ReminderId": reminder.Id,
                    "ScheduledLocalDate": local_date,
                    "ScheduledFor": scheduled_for,
                    "Status": "PENDING",
                    "EmailStatus": "PENDING" if reminder.EmailEnabled else "NOT_REQUESTED",
                }
            )
        if rows_to_insert:
            statement = insert(ReadingReminderOccurrence).values(rows_to_insert).on_conflict_do_nothing(
                index_elements=["reminderid", "scheduledlocaldate"]
            )
            await self.db.execute(statement)
            await self.db.commit()
        result = await self.db.execute(select(ReadingReminderOccurrence, ReadingReminder)
            .join(ReadingReminder, ReadingReminder.Id == ReadingReminderOccurrence.ReminderId)
            .where(ReadingReminder.ChildId == child_id, ReadingReminder.DeletedAt.is_(None),
                   ReadingReminder.IsActive.is_(True), ReadingReminderOccurrence.Status == "PENDING",
                   ReadingReminderOccurrence.ScheduledFor <= now,
                   # Older unacknowledged reminders are missed ones; don't pile them up.
                   ReadingReminderOccurrence.ScheduledFor >= now - timedelta(hours=STALE_REMINDER_HOURS))
            .order_by(ReadingReminderOccurrence.ScheduledFor, ReadingReminderOccurrence.Id))
        raw_rows = [(row[0], row[1]) for row in result.all()]
        if not raw_rows:
            return []
        windows = [
            (child_id, *local_day_bounds(occurrence.ScheduledLocalDate, reminder.Timezone))
            for occurrence, reminder in raw_rows
        ]
        read_windows = await self.children_read_in_windows(windows)
        due: list[tuple[ReadingReminderOccurrence, ReadingReminder]] = []
        changed = False
        for (occurrence, reminder), window in zip(raw_rows, windows):
            if window in read_windows:
                self.mark_read_acknowledged(occurrence, now)
                changed = True
            else:
                due.append((occurrence, reminder))
        if changed:
            await self.db.commit()
        return due

    async def occurrence_for_parent(self, occurrence_id: UUID, actor_id: UUID) -> ReadingReminderOccurrence | None:
        return await self.db.scalar(select(ReadingReminderOccurrence)
            .join(ReadingReminder, ReadingReminder.Id == ReadingReminderOccurrence.ReminderId)
            .join(ChildProfile, ChildProfile.Id == ReadingReminder.ChildId)
            .where(ReadingReminderOccurrence.Id == occurrence_id, ChildProfile.ParentId == actor_id))
