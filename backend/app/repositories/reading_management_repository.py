from datetime import datetime, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import exists, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, BookPage, ChildProfile, PageRevision, Profile, ReadingSession
from app.models.reading_management import ChildBookCollection, ReadingGoal, ReadingReminder, ReadingReminderOccurrence


class ReadingManagementRepository:
    """SQLAlchemy persistence only; no authorization or HTTP response handling."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == actor_id))

    async def owned_child(self, child_id: UUID, actor_id: UUID) -> ChildProfile | None:
        return await self.db.scalar(select(ChildProfile).where(ChildProfile.Id == child_id, ChildProfile.ParentId == actor_id))

    async def children(self, actor_id: UUID) -> list[ChildProfile]:
        result = await self.db.execute(select(ChildProfile).where(ChildProfile.ParentId == actor_id))
        return list(result.scalars().all())

    async def eligible_book(self, book_id: UUID) -> Book | None:
        verified_active_page = exists(
            select(BookPage.Id)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(BookPage.BookId == Book.Id, BookPage.LifecycleStatus == "ACTIVE",
                   PageRevision.PageId == BookPage.Id, PageRevision.VerificationStatus == "VERIFIED")
        )
        return await self.db.scalar(select(Book).where(Book.Id == book_id, Book.LifecycleStatus == "ACTIVE", verified_active_page))

    async def book(self, book_id: UUID) -> Book | None:
        return await self.db.scalar(select(Book).where(Book.Id == book_id))

    async def goals(self, child_id: UUID) -> list[ReadingGoal]:
        result = await self.db.execute(select(ReadingGoal).where(ReadingGoal.ChildId == child_id).order_by(ReadingGoal.CreatedAt.desc(), ReadingGoal.Id))
        return list(result.scalars().all())

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

    async def reminder(self, reminder_id: UUID, child_id: UUID) -> ReadingReminder | None:
        return await self.db.scalar(select(ReadingReminder).where(
            ReadingReminder.Id == reminder_id, ReadingReminder.ChildId == child_id, ReadingReminder.DeletedAt.is_(None)))

    async def reminder_for_actor(self, reminder_id: UUID, actor_id: UUID) -> ReadingReminder | None:
        return await self.db.scalar(select(ReadingReminder).join(ChildProfile, ChildProfile.Id == ReadingReminder.ChildId)
            .where(ReadingReminder.Id == reminder_id, ChildProfile.ParentId == actor_id, ReadingReminder.DeletedAt.is_(None)))

    async def due_occurrences(self, child_id: UUID, now: datetime) -> list[tuple[ReadingReminderOccurrence, ReadingReminder]]:
        for reminder in await self.reminders(child_id):
            local_now = now.astimezone(ZoneInfo(reminder.Timezone))
            if not reminder.IsActive or local_now.weekday() not in reminder.Weekdays or local_now.time().replace(tzinfo=None) < reminder.RemindAt:
                continue
            scheduled_local = datetime.combine(local_now.date(), reminder.RemindAt, tzinfo=ZoneInfo(reminder.Timezone))
            statement = insert(ReadingReminderOccurrence).values(
                ReminderId=reminder.Id, ScheduledLocalDate=local_now.date(),
                ScheduledFor=scheduled_local.astimezone(timezone.utc), Status="PENDING",
            ).on_conflict_do_nothing(index_elements=["reminderid", "scheduledlocaldate"])
            await self.db.execute(statement)
        await self.db.commit()
        result = await self.db.execute(select(ReadingReminderOccurrence, ReadingReminder)
            .join(ReadingReminder, ReadingReminder.Id == ReadingReminderOccurrence.ReminderId)
            .where(ReadingReminder.ChildId == child_id, ReadingReminder.DeletedAt.is_(None),
                   ReadingReminderOccurrence.Status == "PENDING", ReadingReminderOccurrence.ScheduledFor <= now)
            .order_by(ReadingReminderOccurrence.ScheduledFor, ReadingReminderOccurrence.Id))
        return [(row[0], row[1]) for row in result.all()]

    async def occurrence_for_parent(self, occurrence_id: UUID, actor_id: UUID) -> ReadingReminderOccurrence | None:
        return await self.db.scalar(select(ReadingReminderOccurrence)
            .join(ReadingReminder, ReadingReminder.Id == ReadingReminderOccurrence.ReminderId)
            .join(ChildProfile, ChildProfile.Id == ReadingReminder.ChildId)
            .where(ReadingReminderOccurrence.Id == occurrence_id, ChildProfile.ParentId == actor_id))
