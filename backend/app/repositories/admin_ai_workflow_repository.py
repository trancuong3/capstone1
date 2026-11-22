from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AdminAiWorkflow


MAX_WORKFLOW_ATTEMPTS = 3


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
        self,
        page_id: UUID,
        revision_id: UUID,
        input_hash: str,
        *,
        image_hash: str | None = None,
    ) -> AdminAiWorkflow | None:
        query = (
            select(AdminAiWorkflow)
            .where(
                AdminAiWorkflow.PageId == page_id,
                AdminAiWorkflow.PageRevisionId == revision_id,
                AdminAiWorkflow.AdminInputHash == input_hash,
                AdminAiWorkflow.Status != "FAILED",
            )
            .order_by(AdminAiWorkflow.CreatedAt.desc(), AdminAiWorkflow.Id.desc())
            .limit(1)
            .with_for_update()
        )
        if image_hash is not None:
            query = query.where(
                or_(
                    AdminAiWorkflow.SourceImageSha256 == image_hash,
                    AdminAiWorkflow.SourceImageSha256.is_(None),
                )
            )
        return await self.db.scalar(query)

    async def active_for_revision(
        self, page_id: UUID, revision_id: UUID
    ) -> AdminAiWorkflow | None:
        return await self.db.scalar(
            select(AdminAiWorkflow)
            .where(
                AdminAiWorkflow.PageId == page_id,
                AdminAiWorkflow.PageRevisionId == revision_id,
                AdminAiWorkflow.Status.in_(
                    ("QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING")
                ),
            )
            .order_by(AdminAiWorkflow.CreatedAt.desc(), AdminAiWorkflow.Id.desc())
            .limit(1)
            .with_for_update()
        )

    async def mark_stale_for_revision(
        self,
        page_id: UUID,
        revision_id: UUID,
        *,
        new_text_hash: str,
        actor_id: UUID,
        reason: str,
    ) -> int:
        rows = list(
            (
                await self.db.scalars(
                    select(AdminAiWorkflow)
                    .where(
                        AdminAiWorkflow.PageId == page_id,
                        AdminAiWorkflow.PageRevisionId == revision_id,
                        AdminAiWorkflow.OcrApprovedAt.is_(None),
                    )
                    .with_for_update()
                )
            ).all()
        )
        now = datetime.now(timezone.utc)
        changed = 0
        for row in rows:
            if row.CandidateHash == new_text_hash and row.AdminInputHash == new_text_hash:
                continue
            row.SafetyStatus = "STALE"
            row.SafetyConfirmedAt = None
            row.SafetyConfirmedBy = None
            row.ReviewEvents = list(row.ReviewEvents or []) + [{
                "event": "DRAFT_EDITED_INVALIDATED",
                "actor_id": str(actor_id),
                "reason": reason,
                "new_text_hash": new_text_hash,
                "created_at": now.isoformat(),
            }]
            row.UpdatedAt = now
            changed += 1
        return changed

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
        if int(row.Attempts or 0) >= MAX_WORKFLOW_ATTEMPTS:
            row.Status = "FAILED"
            row.ErrorCode = "WORKER_ATTEMPTS_EXHAUSTED"
            row.WorkerId = None
            row.LeaseExpiresAt = None
            row.RetryAfter = None
            if row.Stage == "CHILD_SAFETY_SCANNING":
                row.SafetyStatus = "FAILED"
            row.ReviewEvents = list(row.ReviewEvents or []) + [{
                "event": "WORKFLOW_STAGE_FAILED",
                "actor_id": "SYSTEM",
                "stage": row.Stage,
                "error_code": row.ErrorCode,
                "attempt": int(row.Attempts or 0),
                "created_at": now.isoformat(),
            }]
            row.UpdatedAt = now
            await self.db.commit()
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
        now = datetime.now(timezone.utc)
        if (
            row is None
            or row.WorkerId != worker_id
            or row.LeaseExpiresAt is None
            or row.LeaseExpiresAt <= now
        ):
            await self.db.rollback()
            return False
        row.CompletedChunks = min(max(0, completed), max(1, total))
        row.TotalChunks = max(1, total)
        row.LeaseExpiresAt = now + timedelta(seconds=lease_seconds)
        row.UpdatedAt = now
        await self.db.commit()
        return True

    async def release_claim(self, workflow_id: UUID, worker_id: str) -> bool:
        row = await self.get(workflow_id, lock=True)
        if row is None or row.WorkerId != worker_id:
            await self.db.rollback()
            return False
        row.Status = "QUEUED"
        row.WorkerId = None
        row.LeaseExpiresAt = None
        row.RetryAfter = None
        row.UpdatedAt = datetime.now(timezone.utc)
        await self.db.commit()
        return True
