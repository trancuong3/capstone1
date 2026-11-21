from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChildProfile, ReadingSession
from app.models.reading_presence import ReadingPresenceAlert, ReadingPresenceSetting


@dataclass(frozen=True)
class DeliveryContext:
    session_state: str | None
    child_alias: str | None
    email_enabled: bool


class ReadingPresenceRepository:
    """SQLAlchemy persistence only. Authorization decisions live in the service."""

    def __init__(self, db: AsyncSession):
        self.db = db

    # -- ownership -----------------------------------------------------
    async def owned_session(
        self, session_id: UUID, parent_id: UUID
    ) -> tuple[ReadingSession, ChildProfile] | None:
        row = (
            await self.db.execute(
                select(ReadingSession, ChildProfile)
                .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
                .where(
                    ReadingSession.Id == session_id,
                    ChildProfile.ParentId == parent_id,
                )
            )
        ).first()
        return (row[0], row[1]) if row else None

    # -- settings ------------------------------------------------------
    async def get_settings(self, parent_id: UUID) -> ReadingPresenceSetting | None:
        return await self.db.scalar(
            select(ReadingPresenceSetting).where(
                ReadingPresenceSetting.ParentId == parent_id
            )
        )

    async def upsert_settings(
        self, parent_id: UUID, enabled: bool, now: datetime
    ) -> ReadingPresenceSetting:
        statement = (
            insert(ReadingPresenceSetting)
            .values(ParentId=parent_id, EmailEnabled=enabled, UpdatedAt=now)
            .on_conflict_do_update(
                index_elements=["parentid"],
                set_={"emailenabled": enabled, "updatedat": now},
            )
        )
        await self.db.execute(statement)
        await self.db.commit()
        row = await self.get_settings(parent_id)
        if row is None:  # pragma: no cover - defensive
            raise RuntimeError("Presence setting was not persisted")
        return row

    # -- alerts: reads -------------------------------------------------
    async def by_episode(
        self, session_id: UUID, episode_id: UUID
    ) -> ReadingPresenceAlert | None:
        return await self.db.scalar(
            select(ReadingPresenceAlert).where(
                ReadingPresenceAlert.SessionId == session_id,
                ReadingPresenceAlert.EpisodeId == episode_id,
            )
        )

    async def alert_for_parent(
        self, alert_id: UUID, parent_id: UUID
    ) -> ReadingPresenceAlert | None:
        return await self.db.scalar(
            select(ReadingPresenceAlert).where(
                ReadingPresenceAlert.Id == alert_id,
                ReadingPresenceAlert.ParentId == parent_id,
            )
        )

    async def count_parent_alerts_since(self, parent_id: UUID, since: datetime) -> int:
        return int(
            await self.db.scalar(
                select(func.count())
                .select_from(ReadingPresenceAlert)
                .where(
                    ReadingPresenceAlert.ParentId == parent_id,
                    ReadingPresenceAlert.CreatedAt >= since,
                    ReadingPresenceAlert.Status.in_(("PENDING", "SENDING", "SENT")),
                )
            )
            or 0
        )

    async def session_alert_since(
        self, session_id: UUID, since: datetime
    ) -> ReadingPresenceAlert | None:
        return await self.db.scalar(
            select(ReadingPresenceAlert)
            .where(
                ReadingPresenceAlert.SessionId == session_id,
                ReadingPresenceAlert.CreatedAt >= since,
                ReadingPresenceAlert.Status.in_(("PENDING", "SENDING", "SENT")),
            )
            .limit(1)
        )

    # -- alerts: writes (all conditional so concurrent requests cannot double up)
    async def insert_idempotent(self, **values) -> tuple[ReadingPresenceAlert, bool]:
        statement = (
            insert(ReadingPresenceAlert)
            .values(**values)
            .on_conflict_do_nothing(index_elements=["sessionid", "episodeid"])
            .returning(ReadingPresenceAlert.Id)
        )
        created_id = (await self.db.execute(statement)).scalar_one_or_none()
        await self.db.commit()
        row = await self.by_episode(values["SessionId"], values["EpisodeId"])
        if row is None:  # pragma: no cover - defensive
            raise RuntimeError("Presence alert was not persisted")
        return row, created_id is not None

    async def confirm(
        self, alert_id: UUID, parent_id: UUID, now: datetime
    ) -> ReadingPresenceAlert | None:
        await self.db.execute(
            update(ReadingPresenceAlert)
            .where(
                ReadingPresenceAlert.Id == alert_id,
                ReadingPresenceAlert.ParentId == parent_id,
                ReadingPresenceAlert.Status == "PENDING",
                ReadingPresenceAlert.ExpiresAt > now,
            )
            .values(LastConfirmedAt=now)
        )
        await self.db.commit()
        return await self.alert_for_parent(alert_id, parent_id)

    async def cancel(
        self, alert_id: UUID, parent_id: UUID, reason: str
    ) -> ReadingPresenceAlert | None:
        await self.db.execute(
            update(ReadingPresenceAlert)
            .where(
                ReadingPresenceAlert.Id == alert_id,
                ReadingPresenceAlert.ParentId == parent_id,
                ReadingPresenceAlert.Status == "PENDING",
            )
            .values(Status="CANCELLED", CancelReason=reason)
        )
        await self.db.commit()
        return await self.alert_for_parent(alert_id, parent_id)

    async def cancel_pending_for_parent(self, parent_id: UUID, reason: str) -> int:
        result = await self.db.execute(
            update(ReadingPresenceAlert)
            .where(
                ReadingPresenceAlert.ParentId == parent_id,
                ReadingPresenceAlert.Status == "PENDING",
            )
            .values(Status="CANCELLED", CancelReason=reason)
        )
        await self.db.commit()
        return int(result.rowcount or 0)

    async def cancel_pending_for_session(self, session_id: UUID, reason: str) -> int:
        result = await self.db.execute(
            update(ReadingPresenceAlert)
            .where(
                ReadingPresenceAlert.SessionId == session_id,
                ReadingPresenceAlert.Status == "PENDING",
            )
            .values(Status="CANCELLED", CancelReason=reason)
        )
        await self.db.commit()
        return int(result.rowcount or 0)

    # -- worker --------------------------------------------------------
    async def expire_and_recover(
        self, now: datetime, *, sending_stale_after: timedelta
    ) -> None:
        """Housekeeping before every claim.

        * PENDING past its TTL becomes EXPIRED (never sent late).
        * SENDING abandoned by a crashed worker becomes FAILED/UNKNOWN_DELIVERY.
          It is NOT re-sent: we cannot know whether the mail left, and the
          requirement is at most one email.
        """
        await self.db.execute(
            update(ReadingPresenceAlert)
            .where(
                ReadingPresenceAlert.Status == "PENDING",
                ReadingPresenceAlert.ExpiresAt <= now,
            )
            .values(Status="EXPIRED")
        )
        await self.db.execute(
            update(ReadingPresenceAlert)
            .where(
                ReadingPresenceAlert.Status == "SENDING",
                ReadingPresenceAlert.ClaimedAt <= now - sending_stale_after,
            )
            .values(Status="FAILED", ErrorCode="UNKNOWN_DELIVERY")
        )
        await self.db.commit()

    async def claim_due(
        self, now: datetime, *, heartbeat: timedelta, limit: int = 20
    ) -> list[ReadingPresenceAlert]:
        """Atomically move due, still-confirmed alerts PENDING -> SENDING.

        FOR UPDATE SKIP LOCKED + the status condition guarantee that two
        workers (or a restarted worker) can never claim the same alert.
        """
        result = await self.db.execute(
            select(ReadingPresenceAlert)
            .where(
                ReadingPresenceAlert.Status == "PENDING",
                ReadingPresenceAlert.DueAt <= now,
                ReadingPresenceAlert.ExpiresAt > now,
                ReadingPresenceAlert.LastConfirmedAt >= now - heartbeat,
            )
            .order_by(ReadingPresenceAlert.DueAt, ReadingPresenceAlert.Id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        rows = list(result.scalars().all())
        for row in rows:
            row.Status = "SENDING"
            row.Attempts = (row.Attempts or 0) + 1
            row.ClaimedAt = now
        if rows:
            await self.db.commit()
        return rows

    async def delivery_context(self, alert: ReadingPresenceAlert) -> DeliveryContext:
        session = await self.db.get(ReadingSession, alert.SessionId)
        child = await self.db.get(ChildProfile, alert.ChildId)
        setting = await self.get_settings(alert.ParentId)
        return DeliveryContext(
            session_state=session.State if session else None,
            child_alias=child.Alias if child else None,
            email_enabled=bool(setting and setting.EmailEnabled),
        )

    async def finish_alert(
        self,
        alert_id: UUID,
        *,
        status: str,
        now: datetime,
        error_code: str | None = None,
        cancel_reason: str | None = None,
    ) -> None:
        values: dict = {"Status": status, "ErrorCode": error_code}
        if cancel_reason is not None:
            values["CancelReason"] = cancel_reason
        if status == "SENT":
            values["SentAt"] = now
        await self.db.execute(
            update(ReadingPresenceAlert)
            .where(
                ReadingPresenceAlert.Id == alert_id,
                ReadingPresenceAlert.Status == "SENDING",
            )
            .values(**values)
        )
        await self.db.commit()

    async def release_for_retry(self, alert_id: UUID) -> None:
        await self.db.execute(
            update(ReadingPresenceAlert)
            .where(
                ReadingPresenceAlert.Id == alert_id,
                ReadingPresenceAlert.Status == "SENDING",
            )
            .values(Status="PENDING", ClaimedAt=None)
        )
        await self.db.commit()

