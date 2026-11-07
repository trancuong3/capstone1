from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable
from uuid import UUID, uuid4

from fastapi import HTTPException

logger = logging.getLogger(__name__)

CorrectionOperation = Callable[[Callable[[int, int], None]], Awaitable[str]]
TERMINAL_STATUSES = frozenset({"SUCCEEDED", "FAILED", "CANCELLED"})
MAX_PENDING_JOBS = 4
MAX_RETAINED_JOBS = 64
JOB_RETENTION = timedelta(hours=1)


class OcrCorrectionQueueFull(RuntimeError):
    pass


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


class AdminOcrCorrectionJobManager:
    """Single-process, bounded job queue; payloads are kept only in memory."""

    def __init__(self) -> None:
        self._jobs: dict[UUID, AdminOcrCorrectionJob] = {}
        self._idempotency: dict[tuple[UUID, UUID, UUID], UUID] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._worker_slots = asyncio.Semaphore(1)

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

        if len(self._jobs) >= MAX_RETAINED_JOBS:
            terminal = sorted(
                (job for job in self._jobs.values() if job.status in TERMINAL_STATUSES),
                key=lambda job: job.updated_at,
            )
            for job in terminal[: len(self._jobs) - MAX_RETAINED_JOBS + 1]:
                self._jobs.pop(job.job_id, None)
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
            total_chunks=total_chunks,
            created_at=now,
            updated_at=now,
        )
        self._jobs[job.job_id] = job
        if idempotency_tuple is not None:
            self._idempotency[idempotency_tuple] = job.job_id
        task = asyncio.create_task(
            self._run(job, operation), name=f"admin-ocr-{job.job_id}"
        )
        job.task = task
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return job

    async def _run(
        self, job: AdminOcrCorrectionJob, operation: CorrectionOperation
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
                    return
                job.status = "RUNNING"
                job.updated_at = datetime.now(timezone.utc)
                result = await operation(update_progress)
            if job.status not in TERMINAL_STATUSES:
                job.result = result
                job.completed_chunks = job.total_chunks
                job.status = "SUCCEEDED"
                job.updated_at = datetime.now(timezone.utc)
        except asyncio.CancelledError:
            self._set_cancelled(job)
        except HTTPException as exc:
            job.error = exc.detail if isinstance(exc.detail, str) else "AI OCR thất bại."
            job.status = "FAILED"
            job.updated_at = datetime.now(timezone.utc)
        except Exception:
            logger.error("Admin OCR correction job failed")
            job.error = "Không thể hoàn tất AI OCR. Nội dung hiện tại vẫn được giữ nguyên."
            job.status = "FAILED"
            job.updated_at = datetime.now(timezone.utc)

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
