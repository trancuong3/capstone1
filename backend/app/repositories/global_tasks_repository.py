"""PostgreSQL repository for durable SmartStudioJob records and actor-scoped task aggregation.

Follows ADR-01: wraps `smart_studio_jobs` operations in nested savepoints so deployments before SQL
migration degrade gracefully without aborting transactions or returning HTTP 500.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from datetime import datetime, timedelta, timezone
import logging
from typing import Any, TypeVar
from uuid import UUID, uuid4

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AdminAiWorkflow,
    Book,
    BookPage,
    OcrInferenceJob,
    OcrWorkerHeartbeat,
    PageRevision,
    ParentBookPageSubmission,
    Profile,
    SmartStudioJob,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")

ADMIN_OCR_JOB_KINDS = (
    "ADMIN_PAGE_UPLOAD",
    "ADMIN_PAGE_REUPLOAD",
    "ADMIN_PAGE_REPROCESS",
)
PARENT_OCR_JOB_KINDS = (
    "PARENT_BOOK_SUBMISSION",
    "LOCAL_PAGE_SCAN",
)
CLAIMABLE_STUDIO_STATUSES = ("QUEUED", "RETRY_SCHEDULED")
INFLIGHT_STUDIO_STATUSES = ("RUNNING", "CANCEL_REQUESTED")


def _is_missing_table_error(exc: BaseException) -> bool:
    message = str(exc).lower()
    return any(
        marker in message
        for marker in (
            "does not exist",
            "undefinedtable",
            "undefined_table",
            "no such table",
        )
    )


class GlobalTasksRepository:
    """Data-access layer for SmartStudioJob durability and unified task feed queries."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def _with_savepoint_fallback(
        self,
        operation: Callable[[], Awaitable[T]],
        *,
        fallback: T,
        label: str,
    ) -> T:
        begin_nested = getattr(self.db, "begin_nested", None)
        if callable(begin_nested):
            try:
                async with begin_nested():
                    return await operation()
            except SQLAlchemyError as exc:
                if _is_missing_table_error(exc):
                    logger.warning("Optional studio table unavailable during %s; degrading gracefully.", label)
                    return fallback
                raise
        try:
            return await operation()
        except SQLAlchemyError as exc:
            if _is_missing_table_error(exc):
                logger.warning("Optional studio table unavailable during %s; degrading gracefully.", label)
                return fallback
            raise

    async def get_actor_role(self, actor_id: UUID) -> str | None:
        return await self.db.scalar(
            select(Profile.Role).where(Profile.Id == actor_id, Profile.Active == 1)
        )

    async def get_book(self, book_id: UUID) -> Book | None:
        return await self.db.scalar(select(Book).where(Book.Id == book_id))

    async def get_page(self, page_id: UUID) -> BookPage | None:
        return await self.db.scalar(select(BookPage).where(BookPage.Id == page_id))

    async def get_revision(self, revision_id: UUID) -> PageRevision | None:
        return await self.db.scalar(select(PageRevision).where(PageRevision.Id == revision_id))

    async def get_book_titles(self, book_ids: set[UUID]) -> dict[UUID, str]:
        if not book_ids:
            return {}
        rows = list((await self.db.scalars(select(Book).where(Book.Id.in_(list(book_ids))))).all())
        return {
            row.Id: str(row.Title or row.Name or "")
            for row in rows
            if getattr(row, "Id", None) is not None
        }

    async def get_page_numbers(self, page_ids: set[UUID]) -> dict[UUID, int]:
        if not page_ids:
            return {}
        rows = list((await self.db.scalars(select(BookPage).where(BookPage.Id.in_(list(page_ids))))).all())
        return {
            row.Id: int(row.PageNumber)
            for row in rows
            if getattr(row, "Id", None) is not None and getattr(row, "PageNumber", None) is not None
        }

    async def get_active_page_revision_id(self, page_id: UUID) -> UUID | None:
        """Return latest PageRevision.Id for a page (falling back to CurrentVerifiedRevisionId)."""
        latest_rev = await self.db.scalar(
            select(PageRevision.Id)
            .where(PageRevision.PageId == page_id)
            .order_by(PageRevision.CreatedAt.desc(), PageRevision.Id.desc())
            .limit(1)
        )
        if latest_rev is not None:
            return latest_rev
        page = await self.get_page(page_id)
        if page is not None:
            return page.CurrentVerifiedRevisionId
        return None

    async def get_job(self, job_id: UUID, *, lock: bool = False) -> SmartStudioJob | None:
        async def _op() -> SmartStudioJob | None:
            query = select(SmartStudioJob).where(SmartStudioJob.Id == job_id)
            if lock:
                query = query.with_for_update()
            return await self.db.scalar(query)

        return await self._with_savepoint_fallback(_op, fallback=None, label="get_job")

    async def get_job_for_actor(
        self,
        job_id: UUID,
        *,
        actor_id: UUID,
        actor_role: str,
        lock: bool = False,
    ) -> SmartStudioJob | None:
        """Strictly actor + portal scoped lookup: every actor sees ONLY their own portal jobs."""

        async def _op() -> SmartStudioJob | None:
            if actor_role not in ("parent", "admin"):
                return None
            pred = and_(
                SmartStudioJob.Id == job_id,
                SmartStudioJob.ActorId == actor_id,
                SmartStudioJob.ActorRole == actor_role,
            )
            query = select(SmartStudioJob).where(pred)
            if lock:
                query = query.with_for_update()
            return await self.db.scalar(query)

        return await self._with_savepoint_fallback(_op, fallback=None, label="get_job_for_actor")

    async def get_by_idempotency(
        self,
        actor_id: UUID,
        idempotency_key: str,
        *,
        lock: bool = False,
    ) -> SmartStudioJob | None:
        async def _op() -> SmartStudioJob | None:
            query = (
                select(SmartStudioJob)
                .where(
                    SmartStudioJob.ActorId == actor_id,
                    SmartStudioJob.IdempotencyKey == idempotency_key,
                )
                .limit(1)
            )
            if lock:
                query = query.with_for_update()
            return await self.db.scalar(query)

        return await self._with_savepoint_fallback(_op, fallback=None, label="get_by_idempotency")

    async def create_or_get_idempotent(
        self,
        *,
        job_type: str,
        actor_id: UUID,
        actor_role: str,
        input_hash: str,
        idempotency_key: str,
        book_id: UUID | None = None,
        book_page_id: UUID | None = None,
        source_revision_id: UUID | None = None,
        priority: int = 50,
        max_attempts: int = 3,
        progress_completed: int | None = None,
        progress_total: int | None = None,
        progress_unit: str | None = None,
        initial_checkpoints: dict[str, Any] | None = None,
    ) -> tuple[SmartStudioJob, bool]:
        existing = await self.get_by_idempotency(actor_id, idempotency_key, lock=True)
        if existing is not None:
            return existing, False

        now = datetime.now(timezone.utc)
        job = SmartStudioJob(
            Id=uuid4(),
            JobType=job_type,
            ActorId=actor_id,
            ActorRole=actor_role,
            BookId=book_id,
            BookPageId=book_page_id,
            SourceRevisionId=source_revision_id,
            InputHash=input_hash,
            IdempotencyKey=idempotency_key,
            Stage="QUEUED",
            Status="QUEUED",
            Priority=int(priority),
            AttemptCount=0,
            MaxAttempts=int(max_attempts),
            ProgressCompleted=progress_completed,
            ProgressTotal=progress_total,
            ProgressUnit=progress_unit,
            CheckpointsJson=dict(initial_checkpoints or {}),
            ResultRefJson={},
            CreatedAt=now,
            UpdatedAt=now,
        )

        begin_nested = getattr(self.db, "begin_nested", None)
        try:
            if callable(begin_nested):
                async with begin_nested():
                    self.db.add(job)
                    await self.db.flush()
            else:
                self.db.add(job)
                await self.db.flush()
            return job, True
        except IntegrityError:
            winner = await self.get_by_idempotency(actor_id, idempotency_key, lock=False)
            if winner is not None:
                return winner, False
            raise

    async def claim_next_job(
        self,
        *,
        worker_id: str,
        lease_seconds: int = 120,
        job_types: Sequence[str] | None = None,
        now: datetime | None = None,
    ) -> SmartStudioJob | None:
        current = now or datetime.now(timezone.utc)
        bounded_lease = max(5, min(3600, int(lease_seconds)))

        async def _op() -> SmartStudioJob | None:
            criteria = [
                SmartStudioJob.Status.in_(CLAIMABLE_STUDIO_STATUSES),
                or_(
                    SmartStudioJob.RetryAfterAt.is_(None),
                    SmartStudioJob.RetryAfterAt <= current,
                ),
            ]
            if job_types:
                criteria.append(SmartStudioJob.JobType.in_(tuple(job_types)))

            query = (
                select(SmartStudioJob)
                .where(*criteria)
                .order_by(
                    SmartStudioJob.Priority.desc(),
                    SmartStudioJob.CreatedAt.asc(),
                    SmartStudioJob.Id.asc(),
                )
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            job = await self.db.scalar(query)
            if job is None:
                return None

            job.Status = "RUNNING"
            if job.Stage == "QUEUED":
                job.Stage = "PROCESSING"
            job.WorkerId = worker_id[:96]
            job.LeaseToken = uuid4()
            job.LeaseExpiresAt = current + timedelta(seconds=bounded_lease)
            job.HeartbeatAt = current
            job.AttemptCount = int(job.AttemptCount or 0) + 1
            job.RetryAfterAt = None
            job.ErrorCode = None
            job.ErrorMessageVi = None
            if job.StartedAt is None:
                job.StartedAt = current
            job.UpdatedAt = current
            await self.db.flush()
            return job

        return await self._with_savepoint_fallback(_op, fallback=None, label="claim_next_job")

    async def heartbeat(
        self,
        *,
        job_id: UUID,
        lease_token: UUID,
        lease_seconds: int = 120,
        now: datetime | None = None,
    ) -> SmartStudioJob | None:
        current = now or datetime.now(timezone.utc)
        bounded_lease = max(5, min(3600, int(lease_seconds)))

        async def _op() -> SmartStudioJob | None:
            job = await self.db.scalar(
                select(SmartStudioJob)
                .where(SmartStudioJob.Id == job_id)
                .with_for_update()
            )
            if job is None:
                return None
            if job.Status not in INFLIGHT_STUDIO_STATUSES:
                return None
            if job.LeaseToken != lease_token:
                return None
            job.LeaseExpiresAt = current + timedelta(seconds=bounded_lease)
            job.HeartbeatAt = current
            job.UpdatedAt = current
            await self.db.flush()
            return job

        return await self._with_savepoint_fallback(_op, fallback=None, label="heartbeat")

    async def list_expired_inflight_jobs(
        self,
        *,
        now: datetime | None = None,
        limit: int = 100,
    ) -> list[SmartStudioJob]:
        current = now or datetime.now(timezone.utc)

        async def _op() -> list[SmartStudioJob]:
            query = (
                select(SmartStudioJob)
                .where(
                    SmartStudioJob.Status.in_(INFLIGHT_STUDIO_STATUSES),
                    or_(
                        SmartStudioJob.LeaseExpiresAt.is_(None),
                        SmartStudioJob.LeaseExpiresAt <= current,
                    ),
                )
                .order_by(SmartStudioJob.LeaseExpiresAt.asc(), SmartStudioJob.UpdatedAt.asc())
                .limit(max(1, min(limit, 500)))
                .with_for_update(skip_locked=True)
            )
            return list((await self.db.scalars(query)).all())

        return await self._with_savepoint_fallback(_op, fallback=[], label="list_expired_inflight_jobs")

    async def list_active_revision_bound_jobs(self, *, limit: int = 200) -> list[SmartStudioJob]:
        async def _op() -> list[SmartStudioJob]:
            query = (
                select(SmartStudioJob)
                .where(
                    SmartStudioJob.SourceRevisionId.is_not(None),
                    SmartStudioJob.BookPageId.is_not(None),
                    SmartStudioJob.Status.in_(
                        ("QUEUED", "RETRY_SCHEDULED", "WAITING_FOR_WORKER", "WAITING_FOR_QUOTA")
                    ),
                )
                .limit(max(1, min(limit, 500)))
                .with_for_update(skip_locked=True)
            )
            return list((await self.db.scalars(query)).all())

        return await self._with_savepoint_fallback(_op, fallback=[], label="list_active_revision_bound_jobs")

    async def list_studio_jobs_for_actor(
        self,
        *,
        actor_id: UUID,
        actor_role: str,
        limit: int = 40,
    ) -> list[SmartStudioJob]:
        async def _op() -> list[SmartStudioJob]:
            if actor_role not in ("parent", "admin"):
                return []
            pred = and_(
                SmartStudioJob.ActorId == actor_id,
                SmartStudioJob.ActorRole == actor_role,
            )
            query = (
                select(SmartStudioJob)
                .where(pred)
                .order_by(SmartStudioJob.UpdatedAt.desc(), SmartStudioJob.CreatedAt.desc())
                .limit(max(1, min(limit, 100)))
            )
            return list((await self.db.scalars(query)).all())

        return await self._with_savepoint_fallback(_op, fallback=[], label="list_studio_jobs_for_actor")

    async def list_ocr_inference_jobs_for_actor(
        self,
        *,
        actor_id: UUID,
        actor_role: str,
        limit: int = 30,
    ) -> list[OcrInferenceJob]:
        async def _op() -> list[OcrInferenceJob]:
            if actor_role == "parent":
                pred = and_(
                    OcrInferenceJob.OwnerUserId == actor_id,
                    OcrInferenceJob.JobKind.in_(PARENT_OCR_JOB_KINDS),
                )
            elif actor_role == "admin":
                pred = and_(
                    OcrInferenceJob.OwnerUserId == actor_id,
                    OcrInferenceJob.JobKind.in_(ADMIN_OCR_JOB_KINDS),
                )
            else:
                return []
            query = (
                select(OcrInferenceJob)
                .where(pred)
                .order_by(OcrInferenceJob.UpdatedAt.desc(), OcrInferenceJob.CreatedAt.desc())
                .limit(max(1, min(limit, 100)))
            )
            return list((await self.db.scalars(query)).all())

        return await self._with_savepoint_fallback(_op, fallback=[], label="list_ocr_inference_jobs_for_actor")

    async def get_ocr_inference_job_for_actor(
        self,
        job_id: UUID,
        *,
        actor_id: UUID,
        actor_role: str,
    ) -> OcrInferenceJob | None:
        async def _op() -> OcrInferenceJob | None:
            if actor_role == "parent":
                allowed_kinds = PARENT_OCR_JOB_KINDS
            elif actor_role == "admin":
                allowed_kinds = ADMIN_OCR_JOB_KINDS
            else:
                return None
            query = select(OcrInferenceJob).where(
                OcrInferenceJob.Id == job_id,
                OcrInferenceJob.OwnerUserId == actor_id,
                OcrInferenceJob.JobKind.in_(allowed_kinds),
            )
            return await self.db.scalar(query)

        return await self._with_savepoint_fallback(
            _op, fallback=None, label="get_ocr_inference_job_for_actor"
        )

    async def list_ocr_inference_jobs_by_ids(
        self,
        job_ids: Sequence[UUID],
        *,
        actor_id: UUID | None = None,
    ) -> list[OcrInferenceJob]:
        if not job_ids:
            return []

        async def _op() -> list[OcrInferenceJob]:
            criteria = [OcrInferenceJob.Id.in_(list(job_ids))]
            if actor_id is not None:
                criteria.append(OcrInferenceJob.OwnerUserId == actor_id)
            query = select(OcrInferenceJob).where(*criteria)
            return list((await self.db.scalars(query)).all())

        return await self._with_savepoint_fallback(
            _op, fallback=[], label="list_ocr_inference_jobs_by_ids"
        )

    async def get_latest_ocr_job_for_submission(
        self,
        submission_id: UUID,
        *,
        actor_id: UUID,
    ) -> OcrInferenceJob | None:
        async def _op() -> OcrInferenceJob | None:
            query = (
                select(OcrInferenceJob)
                .where(
                    OcrInferenceJob.SubmissionId == submission_id,
                    OcrInferenceJob.OwnerUserId == actor_id,
                    OcrInferenceJob.JobKind == "PARENT_BOOK_SUBMISSION",
                )
                .order_by(OcrInferenceJob.UpdatedAt.desc(), OcrInferenceJob.CreatedAt.desc())
                .limit(1)
            )
            return await self.db.scalar(query)

        return await self._with_savepoint_fallback(
            _op, fallback=None, label="get_latest_ocr_job_for_submission"
        )

    async def list_admin_workflows(
        self,
        *,
        actor_id: UUID,
        limit: int = 30,
    ) -> list[AdminAiWorkflow]:
        async def _op() -> list[AdminAiWorkflow]:
            query = (
                select(AdminAiWorkflow)
                .where(AdminAiWorkflow.ActorId == actor_id)
                .order_by(AdminAiWorkflow.UpdatedAt.desc(), AdminAiWorkflow.CreatedAt.desc())
                .limit(max(1, min(limit, 100)))
            )
            return list((await self.db.scalars(query)).all())

        return await self._with_savepoint_fallback(_op, fallback=[], label="list_admin_workflows")

    async def get_admin_workflow_for_actor(
        self,
        workflow_id: UUID,
        *,
        actor_id: UUID,
    ) -> AdminAiWorkflow | None:
        async def _op() -> AdminAiWorkflow | None:
            query = select(AdminAiWorkflow).where(
                AdminAiWorkflow.Id == workflow_id,
                AdminAiWorkflow.ActorId == actor_id,
            )
            return await self.db.scalar(query)

        return await self._with_savepoint_fallback(
            _op, fallback=None, label="get_admin_workflow_for_actor"
        )

    async def list_parent_submissions(
        self,
        *,
        actor_id: UUID,
        limit: int = 30,
    ) -> list[ParentBookPageSubmission]:
        async def _op() -> list[ParentBookPageSubmission]:
            query = (
                select(ParentBookPageSubmission)
                .where(ParentBookPageSubmission.OwnerParentId == actor_id)
                .order_by(
                    ParentBookPageSubmission.UpdatedAt.desc(),
                    ParentBookPageSubmission.CreatedAt.desc(),
                )
                .limit(max(1, min(limit, 100)))
            )
            return list((await self.db.scalars(query)).all())

        return await self._with_savepoint_fallback(_op, fallback=[], label="list_parent_submissions")

    async def get_parent_submission_for_actor(
        self,
        submission_id: UUID,
        *,
        actor_id: UUID,
    ) -> ParentBookPageSubmission | None:
        async def _op() -> ParentBookPageSubmission | None:
            query = select(ParentBookPageSubmission).where(
                ParentBookPageSubmission.Id == submission_id,
                ParentBookPageSubmission.OwnerParentId == actor_id,
            )
            return await self.db.scalar(query)

        return await self._with_savepoint_fallback(
            _op, fallback=None, label="get_parent_submission_for_actor"
        )

    async def is_remote_ocr_worker_online(self, *, ttl_seconds: int = 45) -> bool | None:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=max(10, ttl_seconds))

        async def _op() -> bool:
            row = await self.db.scalar(
                select(OcrWorkerHeartbeat)
                .where(OcrWorkerHeartbeat.LastHeartbeatAt >= cutoff)
                .order_by(OcrWorkerHeartbeat.LastHeartbeatAt.desc())
                .limit(1)
            )
            return row is not None

        return await self._with_savepoint_fallback(_op, fallback=None, label="is_remote_ocr_worker_online")
