"""Admin OCR AI-correction job manager with durable SmartStudioJob mirroring (G-04).

Preserves 100% backward compatibility with existing in-memory unit tests and
`/admin/pages/{page_id}/ai-correct/jobs` response schemas while mirroring job
state into `smart_studio_jobs` via savepoint fallback so status/results survive
server restarts and appear in the Unified Global AI Task Center (`/studio/tasks`).
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import BookPage, SmartStudioJob

logger = logging.getLogger(__name__)

CorrectionOperation = Callable[[Callable[[int, int], None]], Awaitable[str]]
DurableSyncCallback = Callable[["AdminOcrCorrectionJob"], Awaitable[None]]

TERMINAL_STATUSES = frozenset({"SUCCEEDED", "FAILED", "CANCELLED"})
MAX_PENDING_JOBS = 4
MAX_RETAINED_JOBS = 64
JOB_RETENTION = timedelta(hours=1)
_MIRROR_SOURCE = "admin_ocr_ai_correct"
_MIRROR_WORKER_ID = "admin-ocr-correction-mirror"


class OcrCorrectionQueueFull(RuntimeError):
    pass


def _is_ignorable_db_error(exc: BaseException) -> bool:
    if isinstance(exc, (TypeError, AttributeError)):
        return True
    msg = str(exc).lower()
    return any(
        marker in msg
        for marker in (
            "does not exist",
            "undefinedtable",
            "undefined_table",
            "no such table",
            "smart_studio_jobs",
        )
    )


def _normalize_legacy_status(raw_status: str | None) -> str:
    upper = str(raw_status or "QUEUED").upper()
    if upper in ("QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"):
        return upper
    if upper in ("CANCEL_REQUESTED", "STALE"):
        return "CANCELLED"
    if upper in ("RETRY_SCHEDULED", "WAITING_FOR_WORKER", "WAITING_FOR_QUOTA"):
        return "QUEUED"
    if upper in ("WAITING_FOR_REVIEW", "PARTIAL_SUCCESS"):
        return "SUCCEEDED"
    return "FAILED"


@dataclass
class AdminOcrCorrectionJob:
    job_id: UUID
    page_id: UUID
    actor_id: UUID
    status: str
    completed_chunks: int
    total_chunks: int
    created_at: datetime
    updated_at: datetime
    result: str | None = None
    error: str | None = None
    task: asyncio.Task[None] | None = None
    book_id: UUID | None = None
    input_hash: str | None = None
    idempotency_key: UUID | None = None


class AdminOcrCorrectionJobManager:
    """Bounded async job queue with optional durable SmartStudioJob mirroring."""

    def __init__(self) -> None:
        self._jobs: dict[UUID, AdminOcrCorrectionJob] = {}
        self._idempotency: dict[tuple[UUID, UUID, UUID], UUID] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._worker_slots = asyncio.Semaphore(1)
        self._durable_sync_callbacks: dict[UUID, DurableSyncCallback] = {}

    def _prune(self) -> None:
        cutoff = datetime.now(timezone.utc) - JOB_RETENTION
        expired = [
            job_id
            for job_id, job in self._jobs.items()
            if job.status in TERMINAL_STATUSES and job.updated_at < cutoff
        ]
        removed_ids = set(expired)
        for job_id in expired:
            self._jobs.pop(job_id, None)
            self._durable_sync_callbacks.pop(job_id, None)

        if len(self._jobs) >= MAX_RETAINED_JOBS:
            terminal = sorted(
                (job for job in self._jobs.values() if job.status in TERMINAL_STATUSES),
                key=lambda job: job.updated_at,
            )
            for job in terminal[: len(self._jobs) - MAX_RETAINED_JOBS + 1]:
                self._jobs.pop(job.job_id, None)
                self._durable_sync_callbacks.pop(job.job_id, None)
                removed_ids.add(job.job_id)

        if removed_ids:
            self._idempotency = {
                key: job_id
                for key, job_id in self._idempotency.items()
                if job_id not in removed_ids
            }

    def submit(
        self,
        *,
        page_id: UUID,
        actor_id: UUID,
        total_chunks: int,
        operation: CorrectionOperation,
        idempotency_key: UUID | None = None,
        book_id: UUID | None = None,
        input_hash: str | None = None,
        durable_sync: DurableSyncCallback | None = None,
    ) -> AdminOcrCorrectionJob:
        self._prune()
        idempotency_tuple = (
            (actor_id, page_id, idempotency_key)
            if idempotency_key is not None
            else None
        )
        if idempotency_tuple is not None:
            existing_id = self._idempotency.get(idempotency_tuple)
            existing = self._jobs.get(existing_id) if existing_id else None
            if existing is not None:
                return existing
        pending_count = sum(
            job.status not in TERMINAL_STATUSES for job in self._jobs.values()
        )
        if pending_count >= MAX_PENDING_JOBS:
            raise OcrCorrectionQueueFull

        now = datetime.now(timezone.utc)
        job = AdminOcrCorrectionJob(
            job_id=uuid4(),
            page_id=page_id,
            actor_id=actor_id,
            status="QUEUED",
            completed_chunks=0,
            total_chunks=max(1, int(total_chunks)),
            created_at=now,
            updated_at=now,
            book_id=book_id,
            input_hash=input_hash,
            idempotency_key=idempotency_key,
        )
        self._jobs[job.job_id] = job
        if durable_sync is not None:
            self._durable_sync_callbacks[job.job_id] = durable_sync
        if idempotency_tuple is not None:
            self._idempotency[idempotency_tuple] = job.job_id
        task = asyncio.create_task(
            self._run(job, operation, durable_sync), name=f"admin-ocr-{job.job_id}"
        )
        job.task = task
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return job

    async def _sync_state(
        self,
        job: AdminOcrCorrectionJob,
        durable_sync: DurableSyncCallback | None,
    ) -> None:
        if durable_sync is None:
            return
        try:
            await asyncio.wait_for(durable_sync(job), timeout=2.0)
        except Exception as exc:
            logger.debug(
                "admin_ocr_job_durable_sync_skipped job_id=%s err=%s",
                job.job_id,
                type(exc).__name__,
            )

    async def _run(
        self,
        job: AdminOcrCorrectionJob,
        operation: CorrectionOperation,
        durable_sync: DurableSyncCallback | None = None,
    ) -> None:
        def update_progress(completed: int, total: int) -> None:
            if job.status in TERMINAL_STATUSES:
                return
            job.completed_chunks = max(0, min(completed, total))
            job.total_chunks = max(1, total)
            job.updated_at = datetime.now(timezone.utc)

        try:
            async with self._worker_slots:
                if job.status == "CANCELLED":
                    await self._sync_state(job, durable_sync)
                    return
                job.status = "RUNNING"
                job.updated_at = datetime.now(timezone.utc)
                await self._sync_state(job, durable_sync)
                result = await operation(update_progress)
            if job.status not in TERMINAL_STATUSES:
                job.result = result
                job.completed_chunks = job.total_chunks
                job.status = "SUCCEEDED"
                job.updated_at = datetime.now(timezone.utc)
                await self._sync_state(job, durable_sync)
        except asyncio.CancelledError:
            self._set_cancelled(job)
            await self._sync_state(job, durable_sync)
        except HTTPException as exc:
            job.error = exc.detail if isinstance(exc.detail, str) else "AI OCR thất bại."
            job.status = "FAILED"
            job.updated_at = datetime.now(timezone.utc)
            await self._sync_state(job, durable_sync)
        except Exception:
            logger.error("Admin OCR correction job failed")
            job.error = "Không thể hoàn tất AI OCR. Nội dung hiện tại vẫn được giữ nguyên."
            job.status = "FAILED"
            job.updated_at = datetime.now(timezone.utc)
            await self._sync_state(job, durable_sync)

    @staticmethod
    def _set_cancelled(job: AdminOcrCorrectionJob) -> None:
        job.result = None
        job.error = "Đã hủy tác vụ AI OCR. Bản nháp hiện tại được giữ nguyên."
        job.status = "CANCELLED"
        job.updated_at = datetime.now(timezone.utc)

    def get(self, job_id: UUID, actor_id: UUID, page_id: UUID) -> AdminOcrCorrectionJob | None:
        self._prune()
        job = self._jobs.get(job_id)
        if job is None or job.actor_id != actor_id or job.page_id != page_id:
            return None
        return job

    def cancel(
        self, job_id: UUID, actor_id: UUID, page_id: UUID
    ) -> AdminOcrCorrectionJob | None:
        job = self.get(job_id, actor_id, page_id)
        if job is None:
            return None
        if job.status not in TERMINAL_STATUSES:
            task = job.task
            self._set_cancelled(job)
            if task is not None:
                task.cancel()
        return job

    async def persist_job_mirror(
        self,
        db: AsyncSession,
        job: AdminOcrCorrectionJob,
    ) -> bool:
        """Mirror job state into durable `smart_studio_jobs` via savepoint fallback.

        Never raises on unmigrated tables or MagicMock test sessions.
        """
        begin_nested = getattr(db, "begin_nested", None)
        if not callable(begin_nested):
            return False

        now = job.updated_at or datetime.now(timezone.utc)
        total_chunks = max(1, int(job.total_chunks or 1))
        completed_chunks = max(0, min(int(job.completed_chunks or 0), total_chunks))
        effective_hash = (
            job.input_hash
            or hashlib.sha256(f"{_MIRROR_SOURCE}:{job.page_id}:{job.job_id}".encode("utf-8")).hexdigest()
        )[:64]
        idem_key = f"admin-ai-correct:{job.page_id}:{job.idempotency_key or job.job_id}"[:128]
        checkpoints_payload: dict[str, Any] = {
            "mirror_source": _MIRROR_SOURCE,
            "completed_chunks": completed_chunks,
            "total_chunks": total_chunks,
        }
        result_ref: dict[str, Any] = {}
        if job.status == "SUCCEEDED" and job.result is not None:
            result_ref["corrected_text"] = job.result

        try:
            async with begin_nested():
                existing = await db.scalar(
                    select(SmartStudioJob).where(SmartStudioJob.Id == job.job_id)
                )
                if existing is None and job.idempotency_key is not None:
                    existing = await db.scalar(
                        select(SmartStudioJob).where(
                            SmartStudioJob.ActorId == job.actor_id,
                            SmartStudioJob.IdempotencyKey == idem_key,
                        )
                    )
                if existing is None:
                    row = SmartStudioJob(
                        Id=job.job_id,
                        JobType="OCR_EXTRACT",
                        ActorId=job.actor_id,
                        ActorRole="admin",
                        BookId=job.book_id,
                        BookPageId=job.page_id,
                        SourceRevisionId=None,
                        InputHash=effective_hash,
                        IdempotencyKey=idem_key,
                        Stage="PROOFREADING",
                        Status=job.status,
                        Priority=65,
                        AttemptCount=1 if job.status != "QUEUED" else 0,
                        MaxAttempts=1,
                        WorkerId=_MIRROR_WORKER_ID if job.status == "RUNNING" else None,
                        LeaseExpiresAt=(
                            now + timedelta(minutes=10) if job.status == "RUNNING" else None
                        ),
                        RetryAfterAt=(
                            now + timedelta(hours=1) if job.status == "QUEUED" else None
                        ),
                        ProgressCompleted=completed_chunks,
                        ProgressTotal=total_chunks,
                        ProgressUnit="đoạn",
                        CheckpointsJson=checkpoints_payload,
                        ResultRefJson=result_ref,
                        ErrorCode="ADMIN_AI_CORRECT_FAILED" if job.status == "FAILED" else None,
                        ErrorMessageVi=job.error,
                        CreatedAt=job.created_at,
                        UpdatedAt=now,
                        StartedAt=now if job.status != "QUEUED" else None,
                        CompletedAt=now if job.status in TERMINAL_STATUSES else None,
                    )
                    db.add(row)
                else:
                    existing.Status = job.status
                    existing.Stage = "COMPLETED" if job.status == "SUCCEEDED" else "PROOFREADING"
                    existing.ProgressCompleted = completed_chunks
                    existing.ProgressTotal = total_chunks
                    existing.ProgressUnit = "đoạn"
                    existing.CheckpointsJson = checkpoints_payload
                    if result_ref:
                        existing.ResultRefJson = result_ref
                    elif job.status == "CANCELLED":
                        existing.ResultRefJson = {}
                    existing.ErrorCode = (
                        "ADMIN_AI_CORRECT_FAILED"
                        if job.status == "FAILED"
                        else "ADMIN_AI_CORRECT_CANCELLED"
                        if job.status == "CANCELLED"
                        else None
                    )
                    existing.ErrorMessageVi = job.error
                    existing.WorkerId = _MIRROR_WORKER_ID if job.status == "RUNNING" else None
                    existing.LeaseExpiresAt = (
                        now + timedelta(minutes=10) if job.status == "RUNNING" else None
                    )
                    existing.RetryAfterAt = (
                        now + timedelta(hours=1) if job.status == "QUEUED" else None
                    )
                    if job.status == "RUNNING" and existing.StartedAt is None:
                        existing.StartedAt = now
                        existing.AttemptCount = max(1, int(existing.AttemptCount or 0))
                    if job.status in TERMINAL_STATUSES:
                        existing.CompletedAt = now
                    existing.UpdatedAt = now
                await db.flush()
            commit_fn = getattr(db, "commit", None)
            if callable(commit_fn):
                await commit_fn()
            return True
        except (IntegrityError, SQLAlchemyError, TypeError, AttributeError) as exc:
            if not _is_ignorable_db_error(exc):
                logger.debug("admin_ocr_job_mirror_skipped err=%s", type(exc).__name__)
            return False

    @staticmethod
    def _row_to_job(row: SmartStudioJob) -> AdminOcrCorrectionJob:
        total = max(1, int(row.ProgressTotal or 1))
        completed = max(0, min(int(row.ProgressCompleted or 0), total))
        result_ref = row.ResultRefJson if isinstance(row.ResultRefJson, dict) else {}
        raw_result = result_ref.get("corrected_text")
        status_str = _normalize_legacy_status(row.Status)
        created_at = row.CreatedAt or datetime.now(timezone.utc)
        updated_at = row.UpdatedAt or created_at
        return AdminOcrCorrectionJob(
            job_id=row.Id,
            page_id=row.BookPageId,  # type: ignore[arg-type]
            actor_id=row.ActorId,
            status=status_str,
            completed_chunks=completed,
            total_chunks=total,
            created_at=created_at,
            updated_at=updated_at,
            result=str(raw_result) if isinstance(raw_result, str) and status_str == "SUCCEEDED" else None,
            error=row.ErrorMessageVi,
            book_id=row.BookId,
        )

    async def get_durable(
        self,
        db: AsyncSession,
        job_id: UUID,
        actor_id: UUID,
        page_id: UUID,
    ) -> AdminOcrCorrectionJob | None:
        """Read job from RAM first, falling back to durable `smart_studio_jobs` after restart."""
        in_memory = self.get(job_id, actor_id, page_id)
        if in_memory is not None:
            return in_memory

        begin_nested = getattr(db, "begin_nested", None)
        if not callable(begin_nested):
            return None
        try:
            async with begin_nested():
                row = await db.scalar(
                    select(SmartStudioJob).where(
                        SmartStudioJob.Id == job_id,
                        SmartStudioJob.ActorId == actor_id,
                        SmartStudioJob.BookPageId == page_id,
                        SmartStudioJob.ActorRole == "admin",
                    )
                )
        except (SQLAlchemyError, TypeError, AttributeError):
            return None
        if row is None or not isinstance(row, SmartStudioJob):
            return None
        return self._row_to_job(row)

    async def cancel_durable(
        self,
        db: AsyncSession,
        job_id: UUID,
        actor_id: UUID,
        page_id: UUID,
    ) -> AdminOcrCorrectionJob | None:
        """Cancel job in RAM and persist CANCELLED state into durable `smart_studio_jobs`."""
        in_memory = self.cancel(job_id, actor_id, page_id)
        if in_memory is not None:
            await self.persist_job_mirror(db, in_memory)
            return in_memory

        begin_nested = getattr(db, "begin_nested", None)
        if not callable(begin_nested):
            return None
        try:
            async with begin_nested():
                row = await db.scalar(
                    select(SmartStudioJob).where(
                        SmartStudioJob.Id == job_id,
                        SmartStudioJob.ActorId == actor_id,
                        SmartStudioJob.BookPageId == page_id,
                        SmartStudioJob.ActorRole == "admin",
                    )
                )
                if row is None or not isinstance(row, SmartStudioJob):
                    return None
                if _normalize_legacy_status(row.Status) not in TERMINAL_STATUSES:
                    now = datetime.now(timezone.utc)
                    row.Status = "CANCELLED"
                    row.Stage = "CANCELLED"
                    row.ResultRefJson = {}
                    row.ErrorCode = "ADMIN_AI_CORRECT_CANCELLED"
                    row.ErrorMessageVi = (
                        "Đã hủy tác vụ AI OCR. Bản nháp hiện tại được giữ nguyên."
                    )
                    row.WorkerId = None
                    row.LeaseToken = None
                    row.LeaseExpiresAt = None
                    row.RetryAfterAt = None
                    row.CompletedAt = now
                    row.UpdatedAt = now
                    await db.flush()
            commit_fn = getattr(db, "commit", None)
            if callable(commit_fn):
                await commit_fn()
            return self._row_to_job(row)
        except (SQLAlchemyError, TypeError, AttributeError):
            return None

    async def resolve_page_book_id_with_support(
        self, db: AsyncSession, page_id: UUID
    ) -> tuple[UUID | None, bool]:
        """Resolve page's book_id and report whether `db` supports real async savepoint transactions."""
        begin_nested = getattr(db, "begin_nested", None)
        if not callable(begin_nested):
            return None, False
        try:
            async with begin_nested():
                book_id = await db.scalar(
                    select(BookPage.BookId).where(BookPage.Id == page_id)
                )
            return (book_id if isinstance(book_id, UUID) else None), True
        except (SQLAlchemyError, TypeError, AttributeError):
            return None, False

    async def resolve_page_book_id(
        self, db: AsyncSession, page_id: UUID
    ) -> UUID | None:
        book_id, _ = await self.resolve_page_book_id_with_support(db, page_id)
        return book_id

    async def shutdown(self) -> None:
        tasks = list(self._tasks)
        for job in self._jobs.values():
            if job.status not in TERMINAL_STATUSES:
                self._set_cancelled(job)
                if job.task is not None:
                    job.task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


admin_ocr_correction_jobs = AdminOcrCorrectionJobManager()
