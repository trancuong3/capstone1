"""SQLAlchemy persistence for recurring occurrence creation and email outbox claims."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import case, exists, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChildProfile
from app.models.reading_management import ReadingReminder, ReadingReminderEmailDelivery, ReadingReminderOccurrence


def scheduled_occurrences(reminder: ReadingReminder, now: datetime, catch_up_minutes: int) -> list[tuple[date, datetime]]:
    """Return only local recurring times in the bounded catch-up window and after opt-in."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now_utc = now.astimezone(timezone.utc)
    earliest = now_utc - timedelta(minutes=max(0, catch_up_minutes))
    zone = ZoneInfo(reminder.Timezone)
    enabled_at = getattr(reminder, "EmailEnabledAt", None)
    first_day, last_day = earliest.astimezone(zone).date(), now_utc.astimezone(zone).date()
    day, output = first_day, []
    while day <= last_day:
        if day.weekday() in (reminder.Weekdays or []):
            local_time = datetime.combine(day, reminder.RemindAt, tzinfo=zone)
            scheduled_utc = local_time.astimezone(timezone.utc)
            if enabled_at is not None and earliest <= scheduled_utc <= now_utc and scheduled_utc >= enabled_at:
                output.append((day, scheduled_utc))
        day += timedelta(days=1)
    return output


class ReadingReminderEmailRepository:
    """Database operations only; policy and email delivery remain in services."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def enqueue_due_deliveries(self, now: datetime, catch_up_minutes: int) -> dict[str, int]:
        checked = occurrences_created = deliveries_created = 0
        try:
            result = await self.db.execute(
                select(ReadingReminder, ChildProfile.ParentId)
                .join(ChildProfile, ChildProfile.Id == ReadingReminder.ChildId)
                .where(ReadingReminder.IsActive.is_(True), ReadingReminder.DeletedAt.is_(None),
                       ReadingReminder.EmailEnabled.is_(True))
                .with_for_update(skip_locked=True, of=ReadingReminder)
            )
            reminders = result.all()
            checked = len(reminders)
            for reminder, parent_id in reminders:
                for local_date, scheduled_for in scheduled_occurrences(reminder, now, catch_up_minutes):
                    occurrence_insert = (
                        insert(ReadingReminderOccurrence)
                        .values(ReminderId=reminder.Id, ScheduledLocalDate=local_date,
                                ScheduledFor=scheduled_for, Status="PENDING")
                        .on_conflict_do_nothing(index_elements=["reminderid", "scheduledlocaldate"])
                        .returning(ReadingReminderOccurrence.Id)
                    )
                    inserted_occurrence = await self.db.execute(occurrence_insert)
                    if inserted_occurrence.scalar_one_or_none() is not None:
                        occurrences_created += 1
                    occurrence = await self.db.scalar(select(ReadingReminderOccurrence).where(
                        ReadingReminderOccurrence.ReminderId == reminder.Id,
                        ReadingReminderOccurrence.ScheduledLocalDate == local_date,
                    ))
                    if occurrence is None or occurrence.ScheduledFor != scheduled_for:
                        continue
                    delivery_insert = (
                        insert(ReadingReminderEmailDelivery)
                        .values(OccurrenceKey=occurrence.Id, OccurrenceId=occurrence.Id,
                                ReminderId=reminder.Id, ParentId=parent_id, Status="PENDING",
                                AttemptCount=0, NextAttemptAt=now)
                        .on_conflict_do_nothing(index_elements=["occurrencekey"])
                        .returning(ReadingReminderEmailDelivery.Id)
                    )
                    inserted_delivery = await self.db.execute(delivery_insert)
                    if inserted_delivery.scalar_one_or_none() is not None:
                        deliveries_created += 1
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise
        return {"reminders_checked": checked, "occurrences_created": occurrences_created,
                "deliveries_created": deliveries_created}

    async def recover_stale_processing(self, now: datetime, stale_minutes: int = 15) -> int:
        result = await self.db.execute(update(ReadingReminderEmailDelivery).where(
            ReadingReminderEmailDelivery.Status == "PROCESSING",
            ReadingReminderEmailDelivery.LastAttemptAt < now - timedelta(minutes=stale_minutes),
        ).values(Status="FAILED", NextAttemptAt=now,
                 LastErrorCode="worker_recovered_processing", UpdatedAt=now))
        await self.db.commit()
        return int(result.rowcount or 0)

    async def skip_ineligible_deliveries(self, now: datetime) -> int:
        delivery = ReadingReminderEmailDelivery
        eligible = exists(select(ReadingReminder.Id)
            .join(ReadingReminderOccurrence, ReadingReminderOccurrence.ReminderId == ReadingReminder.Id)
            .join(ChildProfile, ChildProfile.Id == ReadingReminder.ChildId)
            .where(ReadingReminder.Id == delivery.ReminderId,
                   ReadingReminderOccurrence.Id == delivery.OccurrenceId,
                   ReadingReminder.IsActive.is_(True), ReadingReminder.EmailEnabled.is_(True),
                   ReadingReminder.EmailEnabledAt.is_not(None),
                   ReadingReminder.EmailEnabledAt <= ReadingReminderOccurrence.ScheduledFor,
                   ReadingReminder.DeletedAt.is_(None), ChildProfile.ParentId == delivery.ParentId))
        result = await self.db.execute(update(delivery).where(
            delivery.Status.in_(("PENDING", "FAILED")), ~eligible
        ).values(Status="SKIPPED", NextAttemptAt=None,
                 LastErrorCode="reminder_disabled_deleted_or_owner_changed", UpdatedAt=now))
        await self.db.commit()
        return int(result.rowcount or 0)

    async def release_delivery_for_configuration_error(
        self, delivery_id: UUID, reason: str, now: datetime
    ) -> None:
        """Return a claimed delivery to PENDING without charging a delivery attempt."""
        delivery = ReadingReminderEmailDelivery
        await self.db.execute(update(delivery).where(
            delivery.Id == delivery_id,
            delivery.Status == "PROCESSING",
        ).values(
            Status="PENDING",
            AttemptCount=case((delivery.AttemptCount > 0, delivery.AttemptCount - 1), else_=0),
            NextAttemptAt=now,
            LastErrorCode=reason[:80],
            UpdatedAt=now,
        ))
        await self.db.commit()

    async def claim_next_delivery(self, now: datetime) -> dict | None:
        delivery = ReadingReminderEmailDelivery
        try:
            result = await self.db.execute(
                select(delivery, ReadingReminderOccurrence, ReadingReminder)
                .join(ReadingReminderOccurrence, ReadingReminderOccurrence.Id == delivery.OccurrenceId)
                .join(ReadingReminder, ReadingReminder.Id == ReadingReminderOccurrence.ReminderId)
                .join(ChildProfile, ChildProfile.Id == ReadingReminder.ChildId)
                .where(delivery.Status.in_(("PENDING", "FAILED")), delivery.NextAttemptAt <= now,
                       ReadingReminder.IsActive.is_(True), ReadingReminder.EmailEnabled.is_(True),
                       ReadingReminder.EmailEnabledAt.is_not(None),
                       ReadingReminder.EmailEnabledAt <= ReadingReminderOccurrence.ScheduledFor,
                       ReadingReminder.DeletedAt.is_(None), ChildProfile.ParentId == delivery.ParentId)
                .order_by(delivery.NextAttemptAt, delivery.CreatedAt, delivery.Id)
                .limit(1).with_for_update(skip_locked=True, of=delivery)
            )
            row = result.first()
            if row is None:
                await self.db.commit()
                return None
            item, occurrence, reminder = row
            item.Status, item.AttemptCount = "PROCESSING", item.AttemptCount + 1
            item.LastAttemptAt, item.NextAttemptAt, item.LastErrorCode = now, None, None
            await self.db.commit()
            return {"delivery_id": item.Id, "occurrence_key": item.OccurrenceKey,
                    "parent_id": item.ParentId, "scheduled_for": occurrence.ScheduledFor,
                    "timezone": reminder.Timezone}
        except Exception:
            await self.db.rollback()
            raise

    async def delivery_is_current(self, delivery_id: UUID) -> bool:
        eligible = exists(select(ReadingReminderEmailDelivery.Id)
            .join(ReadingReminderOccurrence, ReadingReminderOccurrence.Id == ReadingReminderEmailDelivery.OccurrenceId)
            .join(ReadingReminder, ReadingReminder.Id == ReadingReminderOccurrence.ReminderId)
            .join(ChildProfile, ChildProfile.Id == ReadingReminder.ChildId)
            .where(ReadingReminderEmailDelivery.Id == delivery_id,
                   ReadingReminderEmailDelivery.Status == "PROCESSING",
                   ReadingReminderEmailDelivery.ParentId == ChildProfile.ParentId,
                   ReadingReminder.IsActive.is_(True), ReadingReminder.EmailEnabled.is_(True),
                   ReadingReminder.EmailEnabledAt.is_not(None),
                   ReadingReminder.EmailEnabledAt <= ReadingReminderOccurrence.ScheduledFor,
                   ReadingReminder.DeletedAt.is_(None)))
        return bool(await self.db.scalar(select(eligible)))

    async def mark_sent(self, delivery_id: UUID, provider_message_id: str | None, accepted_at: datetime) -> None:
        await self.db.execute(update(ReadingReminderEmailDelivery).where(
            ReadingReminderEmailDelivery.Id == delivery_id
        ).values(Status="SENT", ProviderAcceptedAt=accepted_at,
                 ProviderMessageId=provider_message_id, LastErrorCode=None,
                 NextAttemptAt=None, UpdatedAt=accepted_at))
        await self.db.commit()

    async def mark_skipped(self, delivery_id: UUID, reason: str, now: datetime) -> None:
        await self.db.execute(update(ReadingReminderEmailDelivery).where(
            ReadingReminderEmailDelivery.Id == delivery_id
        ).values(Status="SKIPPED", NextAttemptAt=None, LastErrorCode=reason[:80], UpdatedAt=now))
        await self.db.commit()

    async def mark_failed(self, delivery_id: UUID, reason: str, *, retryable: bool,
                          now: datetime, max_attempts: int) -> bool:
        row = await self.db.scalar(select(ReadingReminderEmailDelivery).where(
            ReadingReminderEmailDelivery.Id == delivery_id))
        if row is None:
            await self.db.rollback()
            return False
        should_retry = retryable and row.AttemptCount < max_attempts
        next_attempt = now + timedelta(minutes=min(60, 2 ** max(0, row.AttemptCount - 1))) if should_retry else None
        await self.db.execute(update(ReadingReminderEmailDelivery).where(
            ReadingReminderEmailDelivery.Id == delivery_id
        ).values(Status="FAILED", NextAttemptAt=next_attempt,
                 LastErrorCode=reason[:80], UpdatedAt=now))
        await self.db.commit()
        return should_retry

    async def latest_delivery_status(self, reminder_id: UUID) -> str | None:
        return await self.db.scalar(select(ReadingReminderEmailDelivery.Status).where(
            ReadingReminderEmailDelivery.ReminderId == reminder_id
        ).order_by(ReadingReminderEmailDelivery.CreatedAt.desc(),
                   ReadingReminderEmailDelivery.Id.desc()).limit(1))
