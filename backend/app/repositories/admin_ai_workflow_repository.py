from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AdminAiWorkflow


class AdminAiWorkflowRepository:
    """Database access for durable Admin AI workflow state."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get(
        self, workflow_id: UUID, *, page_id: UUID | None = None, lock: bool = False
    ) -> AdminAiWorkflow | None:
        query = select(AdminAiWorkflow).where(AdminAiWorkflow.Id == workflow_id)
        if page_id is not None:
            query = query.where(AdminAiWorkflow.PageId == page_id)
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def by_idempotency(
        self, actor_id: UUID, page_id: UUID, key: UUID
    ) -> AdminAiWorkflow | None:
        return await self.db.scalar(
            select(AdminAiWorkflow).where(
                AdminAiWorkflow.ActorId == actor_id,
                AdminAiWorkflow.PageId == page_id,
                AdminAiWorkflow.IdempotencyKey == key,
            )
        )

    async def latest_for_revision(
        self, actor_id: UUID, page_id: UUID, revision_id: UUID
    ) -> AdminAiWorkflow | None:
        return await self.db.scalar(
            select(AdminAiWorkflow)
            .where(
                AdminAiWorkflow.PageId == page_id,
                AdminAiWorkflow.PageRevisionId == revision_id,
            )
            .order_by(AdminAiWorkflow.CreatedAt.desc(), AdminAiWorkflow.Id.desc())
            .limit(1)
        )

    async def by_input_snapshot(
        self, page_id: UUID, revision_id: UUID, input_hash: str
    ) -> AdminAiWorkflow | None:
        return await self.db.scalar(
            select(AdminAiWorkflow)
            .where(
                AdminAiWorkflow.PageId == page_id,
                AdminAiWorkflow.PageRevisionId == revision_id,
                AdminAiWorkflow.AdminInputHash == input_hash,
            )
            .order_by(AdminAiWorkflow.CreatedAt.desc(), AdminAiWorkflow.Id.desc())
            .limit(1)
            .with_for_update()
        )

    async def claim_next(self, worker_id: str, *, lease_seconds: int) -> UUID | None:
        now = datetime.now(timezone.utc)
        queued = and_(
            AdminAiWorkflow.Status == "QUEUED",
            or_(AdminAiWorkflow.RetryAfter.is_(None), AdminAiWorkflow.RetryAfter <= now),
        )
        expired = and_(
            AdminAiWorkflow.Status.in_(["PROOFREADING", "CHILD_SAFETY_SCANNING"]),
            AdminAiWorkflow.LeaseExpiresAt.is_not(None),
            AdminAiWorkflow.LeaseExpiresAt <= now,
        )
        query = (
            select(AdminAiWorkflow)
            .where(or_(queued, expired))
            .order_by(AdminAiWorkflow.CreatedAt, AdminAiWorkflow.Id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        row = await self.db.scalar(query)
        if row is None:
            return None
        if row.Stage not in {"PROOFREADING", "CHILD_SAFETY_SCANNING"}:
            row.Status = "FAILED"
            row.ErrorCode = "INVALID_WORKFLOW_STAGE"
            row.LeaseExpiresAt = None
            row.WorkerId = None
            await self.db.commit()
            return None
        row.Status = row.Stage
        row.WorkerId = worker_id
        row.LeaseExpiresAt = now + timedelta(seconds=lease_seconds)
        row.RetryAfter = None
        row.ErrorCode = None
        row.Attempts = int(row.Attempts or 0) + 1
        row.UpdatedAt = now
        await self.db.commit()
        return row.Id

    async def update_progress(
        self, workflow_id: UUID, worker_id: str, completed: int, total: int,
        *, lease_seconds: int,
    ) -> bool:
        row = await self.get(workflow_id, lock=True)
        if row is None or row.WorkerId != worker_id:
            await self.db.rollback()
            return False
        now = datetime.now(timezone.utc)
        row.CompletedChunks = min(max(0, completed), max(1, total))
        row.TotalChunks = max(1, total)
        row.LeaseExpiresAt = now + timedelta(seconds=lease_seconds)
        row.UpdatedAt = now
        await self.db.commit()
        return True
