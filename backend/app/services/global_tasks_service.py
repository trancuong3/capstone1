"""Durable workflow engine & unified Global AI Task Center service (/studio/tasks).

Implements:
- Idempotent job creation deduplicated by `(actor_id, idempotency_key)`
- Atomic claim + lease token + heartbeat + strict stale-lease rejection
- Revision fencing (marks job `STALE` instead of overwriting newer book/page revisions)
- Checkpoint resume (retried jobs skip already-completed stages in `checkpoints_json`)
- Startup / manual reconciliation (reclaims expired leases + orphaned R-01 parent submissions)
- Safe cooperative cancellation (`QUEUED` -> `CANCELLED`, `RUNNING` -> `CANCEL_REQUESTED`)
- Strictly actor-isolated unified feed aggregating `smart_studio_jobs`, `ocr_inference_jobs`,
  `admin_ai_workflows`, and `parent_book_page_submissions` with honest progress & Vietnamese labels.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
import logging
import time
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AdminAiWorkflow,
    OcrInferenceJob,
    ParentBookPageSubmission,
    SmartStudioJob,
)
from app.policies.book_access import is_book_private
from app.repositories.global_tasks_repository import (
    GlobalTasksRepository,
    _is_missing_table_error,
)
from app.schemas.global_tasks import (
    ActorRole,
    CapabilitiesHealthResponse,
    GlobalTaskActionResponse,
    GlobalTaskCreateRequest,
    GlobalTaskItem,
    GlobalTaskListResponse,
    GlobalTaskStatus,
    ProviderCapabilitySummary,
    ReconcileTasksResponse,
)
from app.services.ai_capability_router import AiCapabilityRouter, get_default_ai_router
from app.services.gpu_workload_scheduler import GpuWorkloadScheduler, get_default_gpu_scheduler
from app.services.ocr_inference_job_service import (
    reconcile_orphaned_parent_submissions,
    worker_heartbeat_ttl_seconds,
)

logger = logging.getLogger(__name__)

ACTIVE_TASK_STATUSES: frozenset[str] = frozenset(
    {
        "QUEUED",
        "RUNNING",
        "WAITING_FOR_WORKER",
        "WAITING_FOR_QUOTA",
        "RETRY_SCHEDULED",
        "CANCEL_REQUESTED",
    }
)
TERMINAL_TASK_STATUSES: frozenset[str] = frozenset(
    {
        "SUCCEEDED",
        "PARTIAL_SUCCESS",
        "FAILED",
        "CANCELLED",
        "STALE",
    }
)
RETRYABLE_STUDIO_STATUSES: frozenset[str] = frozenset(
    {
        "FAILED",
        "PARTIAL_SUCCESS",
        "CANCELLED",
        "WAITING_FOR_QUOTA",
        "RETRY_SCHEDULED",
    }
)
CANCELLABLE_STUDIO_STATUSES: frozenset[str] = frozenset(
    {
        "QUEUED",
        "RUNNING",
        "WAITING_FOR_WORKER",
        "WAITING_FOR_QUOTA",
        "RETRY_SCHEDULED",
        "CANCEL_REQUESTED",
    }
)

STATUS_LABELS_VI: dict[str, str] = {
    "QUEUED": "Chờ xử lý",
    "RUNNING": "Đang xử lý",
    "WAITING_FOR_WORKER": "Chờ máy xử lý AI kết nối lại",
    "WAITING_FOR_QUOTA": "Tạm chờ hạn mức AI",
    "WAITING_FOR_REVIEW": "Cần xác minh",
    "RETRY_SCHEDULED": "Đang lên lịch thử lại",
    "PARTIAL_SUCCESS": "Hoàn tất một phần",
    "SUCCEEDED": "Bản đọc đã sẵn sàng",
    "FAILED": "Xử lý thất bại",
    "CANCEL_REQUESTED": "Đang yêu cầu hủy",
    "CANCELLED": "Đã hủy",
    "STALE": "Đã có phiên bản mới hơn",
}

JOB_TYPE_TITLES_VI: dict[str, str] = {
    "OCR_EXTRACT": "Tách nội dung OCR thông minh",
    "COVER_GENERATE": "Tạo bìa sách AI",
    "ILLUSTRATION_EXTRACT": "Tách tranh minh họa sạch chữ",
    "ILLUSTRATION_GENERATE": "Tạo tranh minh họa AI",
    "STYLE_BIBLE": "Xây dựng hồ sơ phong cách sách",
    "BATCH_BOOK_IMPORT": "Nhập nhiều trang sách",
    "ADMIN_PAGE_UPLOAD": "Nhận diện chữ trang sách",
    "ADMIN_PAGE_REUPLOAD": "Cập nhật ảnh và nhận diện lại",
    "ADMIN_PAGE_REPROCESS": "Chạy lại nhận diện chữ",
    "PARENT_BOOK_SUBMISSION": "Nhận diện chữ trang sách của tôi",
    "LOCAL_PAGE_SCAN": "Quét nhanh trang sách",
    "ADMIN_AI_WORKFLOW": "Soát lỗi AI & Kiểm tra an toàn",
    "PARENT_PAGE_PIPELINE": "Kiểm tra trang sách của tôi",
}

STAGE_LABELS_VI: dict[str, str] = {
    "QUEUED": "Đang xếp hàng",
    "PROCESSING": "Đang xử lý",
    "BOUNDARY_DETECT": "Nhận diện khung trang",
    "OCR": "Nhận diện chữ (OCR)",
    "PROOFREADING": "Soát lỗi chính tả AI",
    "CHILD_SAFETY": "Kiểm tra an toàn trẻ em",
    "TOOL_CHECK": "Kiểm tra an toàn & chất lượng",
    "STYLE_BIBLE": "Phân tích phong cách sách",
    "ILLUSTRATION": "Xử lý tranh minh họa",
    "COVER": "Xử lý bìa sách",
    "TEXT_FREE_VERIFY": "Kiểm chứng tranh không chứa chữ",
    "WAITING_FOR_REVIEW": "Chờ người dùng xác minh",
    "COMPLETED": "Hoàn tất",
    "FAILED": "Gặp lỗi",
    "CANCELLED": "Đã hủy",
    "STALE": "Đã lỗi thời",
}


class StaleLeaseError(RuntimeError):
    """Raised when a worker tries to commit with an expired or mismatched lease_token."""


class JobCancelledError(RuntimeError):
    """Raised when a worker attempts to commit onto an already cancelled job."""


def compute_honest_progress(
    completed: int | None,
    total: int | None,
    unit: str | None = None,
) -> tuple[int | None, int | None, str | None, float | None, bool]:
    """Return honest progress fields: progress_pct is ALWAYS None when indeterminate."""
    if completed is None or total is None or total <= 0:
        return None, None, unit, None, True
    safe_completed = max(0, min(int(completed), int(total)))
    safe_total = int(total)
    pct = round((safe_completed / safe_total) * 100.0, 1)
    return safe_completed, safe_total, unit, pct, False


def get_remaining_stages(job: SmartStudioJob, ordered_stages: Sequence[str]) -> list[str]:
    """Return only stages not yet recorded in `job.CheckpointsJson['completed_stages']`."""
    checkpoints = job.CheckpointsJson if isinstance(job.CheckpointsJson, dict) else {}
    raw_done = checkpoints.get("completed_stages")
    done_set = {str(item) for item in raw_done} if isinstance(raw_done, list) else set()
    return [stage for stage in ordered_stages if stage not in done_set]


def _status_label(status_value: str, job_type: str = "") -> str:
    if status_value == "SUCCEEDED":
        if job_type in ("OCR_EXTRACT", "BATCH_BOOK_IMPORT", "PARENT_PAGE_PIPELINE", "PARENT_BOOK_SUBMISSION"):
            return "Bản đọc đã sẵn sàng để xem"
        return "Đã hoàn tất"
    return STATUS_LABELS_VI.get(status_value, "Đang xử lý")


def _stage_label(stage_value: str) -> str:
    return STAGE_LABELS_VI.get(stage_value.upper(), stage_value)


WAITING_FOR_OCR_WORKER_SUBSTATUS_VI = (
    "Đã lưu trong hàng chờ — Chờ máy chủ OCR bật lại"
)


def _build_result_href(
    *,
    actor_role: ActorRole,
    book_id: UUID | None,
    book_page_id: UUID | None,
    job_type: str = "",
) -> str | None:
    if actor_role == "admin":
        if book_id and book_page_id:
            return f"/admin/books/{book_id}/pages/{book_page_id}"
        if book_id:
            return f"/admin/books/{book_id}"
        return "/admin/books"
    if job_type == "LOCAL_PAGE_SCAN":
        if book_id:
            return f"/book-scanner?bookId={book_id}"
        return "/book-scanner"
    if book_id:
        return f"/my-books?bookId={book_id}"
    return "/my-books"


class GlobalTasksService:
    """Orchestrates durable SmartStudioJob lifecycle and unified actor-scoped Global Task Center."""

    def __init__(
        self,
        db: AsyncSession,
        *,
        ai_router: AiCapabilityRouter | None = None,
        gpu_scheduler: GpuWorkloadScheduler | None = None,
    ) -> None:
        self.db = db
        self.repo = GlobalTasksRepository(db)
        self._ai_router = ai_router
        self._gpu_scheduler = gpu_scheduler

    async def require_actor_role(self, actor_id: UUID) -> ActorRole:
        role = await self.repo.get_actor_role(actor_id)
        if role not in ("admin", "parent"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied",
            )
        return role  # type: ignore[return-value]

    async def create_task(
        self,
        *,
        actor_id: UUID,
        payload: GlobalTaskCreateRequest,
    ) -> GlobalTaskActionResponse:
        actor_role = await self.require_actor_role(actor_id)

        # Enforce strict tenant ownership when parent references a book, page, or revision.
        authorized_book_id: UUID | None = None
        if payload.book_id is not None:
            book = await self.repo.get_book(payload.book_id)
            if book is None or bool(getattr(book, "IsDeleted", False)):
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BOOK_NOT_FOUND")
            if actor_role == "parent" and (
                not is_book_private(book)
                or book.OwnerParentId != actor_id
                or str(getattr(book, "LifecycleStatus", "ACTIVE")).upper() != "ACTIVE"
                or str(getattr(book, "ModerationStatus", "ACTIVE") or "ACTIVE").upper()
                == "SUSPENDED"
            ):
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BOOK_NOT_FOUND")
            authorized_book_id = book.Id

        if payload.book_page_id is not None:
            page = await self.repo.get_page(payload.book_page_id)
            if page is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PAGE_NOT_FOUND")
            if payload.book_id is not None and page.BookId != payload.book_id:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="PAGE_BOOK_MISMATCH")
            if actor_role == "parent":
                book = await self.repo.get_book(page.BookId)
                if (
                    book is None
                    or bool(getattr(book, "IsDeleted", False))
                    or not is_book_private(book)
                    or book.OwnerParentId != actor_id
                    or str(getattr(book, "LifecycleStatus", "ACTIVE")).upper() != "ACTIVE"
                    or str(getattr(book, "ModerationStatus", "ACTIVE") or "ACTIVE").upper()
                    == "SUSPENDED"
                ):
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PAGE_NOT_FOUND")
            authorized_book_id = page.BookId

        if payload.source_revision_id is not None:
            if payload.book_page_id is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="REVISION_REQUIRES_PAGE_ID",
                )
            get_revision = getattr(self.repo, "get_revision", None)
            if callable(get_revision):
                rev = await get_revision(payload.source_revision_id)
                if rev is None or rev.PageId != payload.book_page_id:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="REVISION_NOT_FOUND",
                    )

        # Server-assigned priority cap prevents untrusted parents from starving interactive reading.
        effective_priority = payload.priority if actor_role == "admin" else min(int(payload.priority), 50)

        try:
            job, created = await self.repo.create_or_get_idempotent(
                job_type=payload.job_type,
                actor_id=actor_id,
                actor_role=actor_role,
                book_id=authorized_book_id,
                book_page_id=payload.book_page_id,
                source_revision_id=payload.source_revision_id,
                input_hash=payload.input_hash,
                idempotency_key=payload.idempotency_key.strip(),
                priority=effective_priority,
                max_attempts=payload.max_attempts,
                progress_completed=payload.progress_completed,
                progress_total=payload.progress_total,
                progress_unit=payload.progress_unit,
                initial_checkpoints=payload.initial_checkpoints,
            )
            await self.db.commit()
            if created:
                notify_smart_studio_worker()
        except SQLAlchemyError as exc:
            await self.db.rollback()
            if _is_missing_table_error(exc):
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="SMART_STUDIO_MIGRATION_PENDING",
                ) from None
            raise

        book_titles = await self.repo.get_book_titles({job.BookId} if job.BookId else set())
        page_numbers = await self.repo.get_page_numbers({job.BookPageId} if job.BookPageId else set())
        item = self._map_studio_job(job, book_titles=book_titles, page_numbers=page_numbers)
        return GlobalTaskActionResponse(
            task=item,
            action="created" if created else "deduplicated",
            deduplicated=not created,
            message_vi=(
                "Đã thêm tác vụ vào hàng đợi xử lý nền."
                if created
                else "Tác vụ này đã được tạo trước đó và đang được theo dõi."
            ),
        )

    async def claim_next_job(
        self,
        *,
        worker_id: str,
        lease_seconds: int = 120,
        job_types: Sequence[str] | None = None,
        now: datetime | None = None,
    ) -> SmartStudioJob | None:
        job = await self.repo.claim_next_job(
            worker_id=worker_id,
            lease_seconds=lease_seconds,
            job_types=job_types,
            now=now,
        )
        if job is not None:
            await self.db.commit()
        return job

    async def heartbeat(
        self,
        *,
        job_id: UUID,
        lease_token: UUID,
        lease_seconds: int = 120,
        now: datetime | None = None,
    ) -> SmartStudioJob | None:
        job = await self.repo.heartbeat(
            job_id=job_id,
            lease_token=lease_token,
            lease_seconds=lease_seconds,
            now=now,
        )
        if job is not None:
            await self.db.commit()
        return job

    async def commit_stage_result(
        self,
        *,
        job_id: UUID,
        lease_token: UUID,
        stage: str,
        checkpoint_data: dict[str, Any] | None = None,
        mark_stage_completed: bool = True,
        result_ref: dict[str, Any] | None = None,
        progress_completed: int | None = None,
        progress_total: int | None = None,
        progress_unit: str | None = None,
        next_status: GlobalTaskStatus | None = None,
        current_revision_id: UUID | None = None,
        error_code: str | None = None,
        error_message_vi: str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Durably commit stage checkpoint or final result with strict lease & revision fencing."""
        current = now or datetime.now(timezone.utc)
        job = await self.repo.get_job(job_id, lock=True)
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="TASK_NOT_FOUND")

        if job.Status == "CANCELLED":
            await self.db.rollback()
            raise JobCancelledError(f"Job {job_id} is already CANCELLED")

        # 1. Strict stale-lease rejection!
        if job.LeaseToken is None or job.LeaseToken != lease_token:
            await self.db.rollback()
            raise StaleLeaseError(
                f"Stale lease token for job {job_id}; refusing write from superseded worker"
            )

        # 2. Safe cooperative cancel-vs-complete resolution:
        #    If cancel was requested before final commit, honor cancellation cleanly without
        #    writing superseded outputs into active book assets.
        if job.Status == "CANCEL_REQUESTED":
            job.Status = "CANCELLED"
            job.Stage = "CANCELLED"
            job.LeaseToken = None
            job.LeaseExpiresAt = None
            job.WorkerId = None
            job.CompletedAt = current
            job.UpdatedAt = current
            await self.db.commit()
            return {
                "accepted": False,
                "status": "CANCELLED",
                "reason": "CANCEL_ACKNOWLEDGED",
                "job_id": str(job.Id),
            }

        # 3. Strict revision fencing: never overwrite newer book/page revisions!
        if job.SourceRevisionId is not None:
            active_revision_id = current_revision_id
            if active_revision_id is None and job.BookPageId is not None:
                active_revision_id = await self.repo.get_active_page_revision_id(job.BookPageId)
            if active_revision_id is not None and active_revision_id != job.SourceRevisionId:
                job.Status = "STALE"
                job.Stage = "STALE"
                job.LeaseToken = None
                job.LeaseExpiresAt = None
                job.WorkerId = None
                job.ErrorCode = "SOURCE_REVISION_SUPERSEDED"
                job.ErrorMessageVi = (
                    "Trang sách đã có phiên bản mới hơn; kết quả cũ đã bị bỏ qua để tránh ghi đè."
                )
                job.CompletedAt = current
                job.UpdatedAt = current
                await self.db.commit()
                return {
                    "accepted": False,
                    "status": "STALE",
                    "reason": "REVISION_FENCED",
                    "job_id": str(job.Id),
                    "expected_revision_id": str(job.SourceRevisionId),
                    "current_revision_id": str(active_revision_id),
                }

        # 4. Merge durable checkpoints (never wiping previously completed stages).
        merged_checkpoints: dict[str, Any] = (
            dict(job.CheckpointsJson) if isinstance(job.CheckpointsJson, dict) else {}
        )
        completed_stages_raw = merged_checkpoints.get("completed_stages")
        completed_stages: list[str] = (
            [str(item) for item in completed_stages_raw]
            if isinstance(completed_stages_raw, list)
            else []
        )
        if mark_stage_completed and stage not in completed_stages:
            completed_stages.append(stage)
        merged_checkpoints["completed_stages"] = completed_stages
        if checkpoint_data:
            stage_outputs = dict(merged_checkpoints.get("stage_outputs") or {})
            stage_outputs[stage] = checkpoint_data
            merged_checkpoints["stage_outputs"] = stage_outputs
        job.CheckpointsJson = merged_checkpoints

        # 5. Honest progress update (enforcing DB check constraint invariants).
        if progress_completed is not None and progress_total is not None:
            safe_total = max(0, int(progress_total))
            safe_completed = max(0, min(int(progress_completed), safe_total))
            job.ProgressCompleted = safe_completed
            job.ProgressTotal = safe_total
            if progress_unit is not None:
                job.ProgressUnit = progress_unit[:24]
        elif progress_completed is None and progress_total is None and progress_unit is not None:
            job.ProgressUnit = progress_unit[:24]

        if result_ref is not None:
            merged_result = dict(job.ResultRefJson or {}) if isinstance(job.ResultRefJson, dict) else {}
            merged_result.update(result_ref)
            job.ResultRefJson = merged_result

        job.Stage = stage[:40]
        job.HeartbeatAt = current
        job.UpdatedAt = current

        if error_code is not None:
            job.ErrorCode = error_code[:64]
        if error_message_vi is not None:
            job.ErrorMessageVi = error_message_vi

        if next_status is not None:
            job.Status = next_status
            if next_status in TERMINAL_TASK_STATUSES or next_status in (
                "WAITING_FOR_REVIEW",
                "WAITING_FOR_QUOTA",
                "WAITING_FOR_WORKER",
                "RETRY_SCHEDULED",
            ):
                job.LeaseToken = None
                job.LeaseExpiresAt = None
                job.WorkerId = None
            if next_status in TERMINAL_TASK_STATUSES:
                job.CompletedAt = current

        await self.db.commit()
        return {
            "accepted": True,
            "status": job.Status,
            "stage": job.Stage,
            "job_id": str(job.Id),
            "completed_stages": completed_stages,
        }

    async def retry_task(
        self,
        *,
        actor_id: UUID,
        job_id: UUID,
    ) -> GlobalTaskActionResponse:
        actor_role = await self.require_actor_role(actor_id)
        job = await self.repo.get_job_for_actor(
            job_id,
            actor_id=actor_id,
            actor_role=actor_role,
            lock=True,
        )
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="TASK_NOT_FOUND")

        if job.Status not in RETRYABLE_STUDIO_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="TASK_NOT_RETRYABLE",
            )

        now = datetime.now(timezone.utc)
        # Preserve checkpoints_json strictly so retry resumes from last completed stage!
        checkpoints = dict(job.CheckpointsJson or {}) if isinstance(job.CheckpointsJson, dict) else {}
        retry_count = int(checkpoints.get("manual_retry_count") or 0) + 1
        checkpoints["manual_retry_count"] = retry_count
        checkpoints["last_retried_at"] = now.isoformat()
        job.CheckpointsJson = checkpoints

        job.Status = "QUEUED"
        if job.Stage in ("FAILED", "CANCELLED"):
            completed = checkpoints.get("completed_stages") or []
            job.Stage = str(completed[-1]) if isinstance(completed, list) and completed else "QUEUED"
        job.AttemptCount = 0
        job.WorkerId = None
        job.LeaseToken = None
        job.LeaseExpiresAt = None
        job.RetryAfterAt = None
        job.ErrorCode = None
        job.ErrorMessageVi = None
        job.CompletedAt = None
        job.UpdatedAt = now
        await self.db.commit()
        notify_smart_studio_worker()

        book_titles = await self.repo.get_book_titles({job.BookId} if job.BookId else set())
        page_numbers = await self.repo.get_page_numbers({job.BookPageId} if job.BookPageId else set())
        return GlobalTaskActionResponse(
            task=self._map_studio_job(job, book_titles=book_titles, page_numbers=page_numbers),
            action="retried",
            message_vi="Đã xếp lịch chạy lại từ bước chưa hoàn tất.",
        )

    async def cancel_task(
        self,
        *,
        actor_id: UUID,
        job_id: UUID,
    ) -> GlobalTaskActionResponse:
        actor_role = await self.require_actor_role(actor_id)
        job = await self.repo.get_job_for_actor(
            job_id,
            actor_id=actor_id,
            actor_role=actor_role,
            lock=True,
        )
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="TASK_NOT_FOUND")

        now = datetime.now(timezone.utc)
        if job.Status == "CANCELLED":
            book_titles = await self.repo.get_book_titles({job.BookId} if job.BookId else set())
            page_numbers = await self.repo.get_page_numbers({job.BookPageId} if job.BookPageId else set())
            return GlobalTaskActionResponse(
                task=self._map_studio_job(job, book_titles=book_titles, page_numbers=page_numbers),
                action="already_cancelled",
                message_vi="Tác vụ đã được hủy trước đó.",
            )

        if job.Status in TERMINAL_TASK_STATUSES or job.Status == "WAITING_FOR_REVIEW":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="TASK_ALREADY_TERMINAL",
            )

        if job.Status == "RUNNING":
            job.Status = "CANCEL_REQUESTED"
            job.UpdatedAt = now
            action_name = "cancel_requested"
            message_vi = "Đã gửi yêu cầu dừng an toàn tác vụ đang chạy."
        elif job.Status == "CANCEL_REQUESTED":
            action_name = "cancel_requested"
            message_vi = "Tác vụ đang chờ dừng an toàn ở bước kế tiếp."
        else:
            job.Status = "CANCELLED"
            job.Stage = "CANCELLED"
            job.WorkerId = None
            job.LeaseToken = None
            job.LeaseExpiresAt = None
            job.RetryAfterAt = None
            job.CompletedAt = now
            job.UpdatedAt = now
            action_name = "cancelled"
            message_vi = "Đã hủy tác vụ trong hàng đợi."

        await self.db.commit()
        book_titles = await self.repo.get_book_titles({job.BookId} if job.BookId else set())
        page_numbers = await self.repo.get_page_numbers({job.BookPageId} if job.BookPageId else set())
        return GlobalTaskActionResponse(
            task=self._map_studio_job(job, book_titles=book_titles, page_numbers=page_numbers),
            action=action_name,
            message_vi=message_vi,
        )

    async def reconcile_stale_jobs(
        self,
        *,
        now: datetime | None = None,
        retry_backoff_seconds: int = 10,
        parent_stale_after_seconds: int = 90,
        reschedule_parent_post_ocr: bool = True,
    ) -> ReconcileTasksResponse:
        """Startup & periodic reconciliation: reclaim expired leases, fence stale jobs, heal R-01."""
        current = now or datetime.now(timezone.utc)
        reclaimed_studio = 0
        failed_studio = 0
        cancelled_expired = 0
        stale_fenced = 0

        expired_jobs = await self.repo.list_expired_inflight_jobs(now=current)
        for job in expired_jobs:
            if job.Status == "CANCEL_REQUESTED":
                job.Status = "CANCELLED"
                job.Stage = "CANCELLED"
                job.WorkerId = None
                job.LeaseToken = None
                job.LeaseExpiresAt = None
                job.CompletedAt = current
                job.UpdatedAt = current
                cancelled_expired += 1
            elif int(job.AttemptCount or 0) >= int(job.MaxAttempts or 3):
                job.Status = "FAILED"
                job.Stage = "FAILED"
                job.WorkerId = None
                job.LeaseToken = None
                job.LeaseExpiresAt = None
                job.ErrorCode = "WORKER_LEASE_EXPIRED"
                job.ErrorMessageVi = (
                    "Tiến trình xử lý bị gián đoạn quá số lần thử cho phép. Bạn có thể bấm Thử lại."
                )
                job.CompletedAt = current
                job.UpdatedAt = current
                failed_studio += 1
            else:
                backoff = max(0, int(retry_backoff_seconds)) * max(1, int(job.AttemptCount or 1))
                job.Status = "RETRY_SCHEDULED"
                job.WorkerId = None
                job.LeaseToken = None
                job.LeaseExpiresAt = None
                job.RetryAfterAt = current + timedelta(seconds=backoff) if backoff > 0 else current
                job.ErrorCode = "LEASE_EXPIRED_RECLAIMED"
                job.ErrorMessageVi = "Máy xử lý vừa khởi động lại; hệ thống tự động xếp lịch tiếp tục."
                job.UpdatedAt = current
                reclaimed_studio += 1

        # Fence queued/waiting jobs whose target page already moved to a newer revision.
        rev_bound = await self.repo.list_active_revision_bound_jobs()
        for job in rev_bound:
            if job.BookPageId is None or job.SourceRevisionId is None:
                continue
            active_rev = await self.repo.get_active_page_revision_id(job.BookPageId)
            if active_rev is not None and active_rev != job.SourceRevisionId:
                job.Status = "STALE"
                job.Stage = "STALE"
                job.WorkerId = None
                job.LeaseToken = None
                job.LeaseExpiresAt = None
                job.ErrorCode = "SOURCE_REVISION_SUPERSEDED"
                job.ErrorMessageVi = "Trang sách đã có phiên bản mới hơn; tác vụ cũ đã tự động đóng."
                job.CompletedAt = current
                job.UpdatedAt = current
                stale_fenced += 1

        if reclaimed_studio or failed_studio or cancelled_expired or stale_fenced:
            await self.db.commit()

        # Also reap expired remote OCR worker leases so crashed workers never strand jobs.
        try:
            from app.services.ocr_inference_job_service import OcrInferenceJobService

            await OcrInferenceJobService(self.db).reap_expired_leases(now=current)
        except SQLAlchemyError as exc:
            if not _is_missing_table_error(exc):
                raise

        # Also reclaim any orphaned R-01 ParentBookPageSubmission rows stuck in CHECKING!
        parent_reconcile = {"reclaimed_count": 0, "failed_count": 0}
        try:
            parent_reconcile = await reconcile_orphaned_parent_submissions(
                self.db,
                stale_after_seconds=parent_stale_after_seconds,
                reschedule=reschedule_parent_post_ocr,
                now=current,
            )
        except SQLAlchemyError as exc:
            if not _is_missing_table_error(exc):
                raise

        return ReconcileTasksResponse(
            reclaimed_studio_jobs=reclaimed_studio,
            failed_studio_jobs=failed_studio,
            cancelled_expired_studio_jobs=cancelled_expired,
            stale_fenced_jobs=stale_fenced,
            reclaimed_parent_submissions=int(parent_reconcile.get("reclaimed_count", 0)),
            failed_parent_submissions=int(parent_reconcile.get("failed_count", 0)),
        )

    async def list_tasks(
        self,
        *,
        actor_id: UUID,
        limit: int = 40,
        active_only: bool = False,
    ) -> GlobalTaskListResponse:
        """Aggregate all durable workflows strictly isolated to `(actor_id, actor_role)`."""
        in_tx_fn = getattr(self.db, "in_transaction", None)
        was_in_tx = bool(in_tx_fn()) if callable(in_tx_fn) else False
        actor_role = await self.require_actor_role(actor_id)
        worker_online = await self.repo.is_remote_ocr_worker_online(
            ttl_seconds=worker_heartbeat_ttl_seconds()
        )
        if worker_online is False:
            from app.services.remote_ocr_wakeup import (
                is_remote_worker_wakeup_configured,
                peek_cached_remote_ocr_worker_health,
                probe_configured_remote_ocr_worker_health,
            )

            if is_remote_worker_wakeup_configured():
                valid_cache, cached_probe = peek_cached_remote_ocr_worker_health()
                if valid_cache:
                    worker_online = bool(cached_probe and cached_probe.get("online"))
                else:
                    if not was_in_tx and not (
                        getattr(self.db, "new", None)
                        or getattr(self.db, "dirty", None)
                        or getattr(self.db, "deleted", None)
                    ):
                        try:
                            await self.db.rollback()
                        except Exception:
                            pass
                    probe = await probe_configured_remote_ocr_worker_health()
                    worker_online = bool(probe and probe.get("online"))

        studio_jobs = await self.repo.list_studio_jobs_for_actor(
            actor_id=actor_id,
            actor_role=actor_role,
            limit=limit,
        )
        ocr_jobs = await self.repo.list_ocr_inference_jobs_for_actor(
            actor_id=actor_id,
            actor_role=actor_role,
            limit=limit,
        )
        admin_workflows: list[AdminAiWorkflow] = (
            await self.repo.list_admin_workflows(limit=limit) if actor_role == "admin" else []
        )
        parent_submissions: list[ParentBookPageSubmission] = (
            await self.repo.list_parent_submissions(actor_id=actor_id, limit=limit)
            if actor_role == "parent"
            else []
        )
        parent_submission_ids: set[str] = {str(sub.Id) for sub in parent_submissions}
        deduped_ocr_jobs: list[OcrInferenceJob] = []
        for ocr_job in ocr_jobs:
            if str(ocr_job.JobKind or "") == "PARENT_BOOK_SUBMISSION":
                sub_id_val = getattr(ocr_job, "SubmissionId", None)
                if sub_id_val is None and isinstance(getattr(ocr_job, "ProcessingMeta", None), dict):
                    sub_id_val = ocr_job.ProcessingMeta.get("submission_id")
                if sub_id_val is not None and str(sub_id_val) in parent_submission_ids:
                    continue
            deduped_ocr_jobs.append(ocr_job)
        ocr_jobs = deduped_ocr_jobs

        book_ids: set[UUID] = set()
        page_ids: set[UUID] = set()
        for row in studio_jobs:
            if row.BookId:
                book_ids.add(row.BookId)
            if row.BookPageId:
                page_ids.add(row.BookPageId)
        for row in ocr_jobs:
            if row.BookId:
                book_ids.add(row.BookId)
            if row.PageId:
                page_ids.add(row.PageId)
        for row in admin_workflows:
            if row.BookId:
                book_ids.add(row.BookId)
            if row.PageId:
                page_ids.add(row.PageId)
        for row in parent_submissions:
            if row.BookId:
                book_ids.add(row.BookId)

        book_titles = await self.repo.get_book_titles(book_ids)
        page_numbers = await self.repo.get_page_numbers(page_ids)

        items: list[GlobalTaskItem] = []
        for job in studio_jobs:
            items.append(self._map_studio_job(job, book_titles=book_titles, page_numbers=page_numbers))
        for ocr_job in ocr_jobs:
            items.append(
                self._map_ocr_job(
                    ocr_job,
                    actor_role=actor_role,
                    worker_online=worker_online,
                    book_titles=book_titles,
                    page_numbers=page_numbers,
                )
            )
        for wf in admin_workflows:
            items.append(
                self._map_admin_workflow(wf, book_titles=book_titles, page_numbers=page_numbers)
            )
        for sub in parent_submissions:
            items.append(
                self._map_parent_submission(
                    sub,
                    worker_online=worker_online,
                    book_titles=book_titles,
                )
            )

        if active_only:
            items = [item for item in items if item.status in ACTIVE_TASK_STATUSES]

        # Sort active tasks first, then most recently updated.
        items.sort(
            key=lambda item: (
                0 if item.status in ACTIVE_TASK_STATUSES else 1,
                -(item.updated_at.timestamp() if item.updated_at else 0.0),
            )
        )
        items = items[: max(1, min(limit, 100))]

        active_count = sum(1 for item in items if item.status in ACTIVE_TASK_STATUSES)
        waiting_review_count = sum(1 for item in items if item.status == "WAITING_FOR_REVIEW")
        failed_count = sum(1 for item in items if item.status == "FAILED")
        completed_count = sum(
            1 for item in items if item.status in ("SUCCEEDED", "PARTIAL_SUCCESS")
        )

        recommended_poll_ms: int | None = None
        if any(item.status in ("RUNNING", "CANCEL_REQUESTED") for item in items):
            recommended_poll_ms = 3500
        elif active_count > 0:
            active_items = [item for item in items if item.status in ACTIVE_TASK_STATUSES]
            if worker_online is False and active_items and all(
                item.status == "WAITING_FOR_WORKER" for item in active_items
            ):
                recommended_poll_ms = 15000
            else:
                recommended_poll_ms = 8000

        return GlobalTaskListResponse(
            actor_id=actor_id,
            actor_role=actor_role,
            active_count=active_count,
            waiting_review_count=waiting_review_count,
            failed_count=failed_count,
            completed_count=completed_count,
            worker_online=worker_online,
            recommended_poll_ms=recommended_poll_ms,
            tasks=items,
        )

    async def get_capabilities(self, *, actor_id: UUID) -> CapabilitiesHealthResponse:
        actor_role = await self.require_actor_role(actor_id)
        router = self._ai_router or get_default_ai_router()
        scheduler = self._gpu_scheduler or get_default_gpu_scheduler()
        snap = router.get_capabilities_snapshot()
        providers = [ProviderCapabilitySummary(**item) for item in snap["providers"]]
        if actor_role != "admin":
            return CapabilitiesHealthResponse(
                feature_flags=snap["feature_flags"],
                providers=[
                    item.model_copy(
                        update={
                            "provider_circuit_state": "CLOSED",
                            "quota_group_circuit_state": "CLOSED",
                            "quota_group": None,
                        }
                    )
                    for item in providers
                    if item.enabled
                ],
                circuit_breakers={},
                cache_entries=0,
                scheduler={},
            )
        return CapabilitiesHealthResponse(
            feature_flags=snap["feature_flags"],
            providers=providers,
            circuit_breakers=snap["circuit_breakers"],
            cache_entries=int(snap["cache_entries"]),
            scheduler=scheduler.get_status(),
        )

    def _map_studio_job(
        self,
        job: SmartStudioJob,
        *,
        book_titles: dict[UUID, str],
        page_numbers: dict[UUID, int],
    ) -> GlobalTaskItem:
        completed, total, unit, pct, is_indeterminate = compute_honest_progress(
            job.ProgressCompleted,
            job.ProgressTotal,
            job.ProgressUnit,
        )
        actor_role: ActorRole = "admin" if job.ActorRole == "admin" else "parent"
        status_val: GlobalTaskStatus = job.Status  # type: ignore[assignment]
        created_at = job.CreatedAt or datetime.now(timezone.utc)
        updated_at = job.UpdatedAt or created_at
        return GlobalTaskItem(
            id=job.Id,
            source="smart_studio_job",
            job_type=job.JobType,
            title_vi=JOB_TYPE_TITLES_VI.get(job.JobType, "Tác vụ AI sách"),
            book_id=job.BookId,
            book_page_id=job.BookPageId,
            book_title=book_titles.get(job.BookId) if job.BookId else None,
            page_number=page_numbers.get(job.BookPageId) if job.BookPageId else None,
            source_revision_id=job.SourceRevisionId,
            actor_role=actor_role,
            status=status_val,
            status_label_vi=_status_label(status_val, job.JobType),
            stage=str(job.Stage or "QUEUED"),
            stage_label_vi=_stage_label(str(job.Stage or "QUEUED")),
            priority=int(job.Priority or 50),
            attempt_count=int(job.AttemptCount or 0),
            max_attempts=int(job.MaxAttempts or 3),
            progress_completed=completed,
            progress_total=total,
            progress_unit=unit,
            progress_pct=pct,
            is_indeterminate=is_indeterminate,
            can_retry=status_val in RETRYABLE_STUDIO_STATUSES,
            can_cancel=status_val in ("QUEUED", "RUNNING", "WAITING_FOR_WORKER", "WAITING_FOR_QUOTA", "RETRY_SCHEDULED"),
            result_href=_build_result_href(
                actor_role=actor_role,
                book_id=job.BookId,
                book_page_id=job.BookPageId,
            ),
            result_ref=dict(job.ResultRefJson or {}) if isinstance(job.ResultRefJson, dict) else {},
            checkpoints=dict(job.CheckpointsJson or {}) if isinstance(job.CheckpointsJson, dict) else {},
            error_code=job.ErrorCode,
            error_message_vi=job.ErrorMessageVi,
            created_at=created_at,
            updated_at=updated_at,
            started_at=job.StartedAt,
            completed_at=job.CompletedAt,
        )

    def _map_ocr_job(
        self,
        job: OcrInferenceJob,
        *,
        actor_role: ActorRole,
        worker_online: bool | None,
        book_titles: dict[UUID, str],
        page_numbers: dict[UUID, int],
    ) -> GlobalTaskItem:
        raw_status = str(job.Status or "QUEUED").upper()
        mapped_status: GlobalTaskStatus
        if raw_status == "QUEUED":
            mapped_status = "WAITING_FOR_WORKER" if worker_online is False else "QUEUED"
        elif raw_status in ("CLAIMED", "RUNNING"):
            mapped_status = "RUNNING"
        elif raw_status == "FAILED_RETRYABLE":
            mapped_status = "WAITING_FOR_WORKER" if worker_online is False else "RETRY_SCHEDULED"
        elif raw_status == "SUCCEEDED":
            mapped_status = "SUCCEEDED"
        elif raw_status in ("DEAD_LETTER", "FAILED"):
            mapped_status = "FAILED"
        elif raw_status == "CANCELLED":
            mapped_status = "CANCELLED"
        else:
            mapped_status = "QUEUED"

        created_at = job.CreatedAt or datetime.now(timezone.utc)
        updated_at = job.UpdatedAt or created_at
        # Single-page OCR inference has no mid-inference percentage -> honest indeterminate!
        return GlobalTaskItem(
            id=job.Id,
            source="ocr_inference_job",
            job_type=str(job.JobKind),
            title_vi=JOB_TYPE_TITLES_VI.get(str(job.JobKind), "Nhận diện chữ OCR"),
            book_id=job.BookId,
            book_page_id=job.PageId,
            book_title=book_titles.get(job.BookId) if job.BookId else None,
            page_number=page_numbers.get(job.PageId) if job.PageId else None,
            source_revision_id=job.RevisionId,
            actor_role=actor_role,
            status=mapped_status,
            status_label_vi=_status_label(mapped_status, str(job.JobKind)),
            stage="OCR",
            stage_label_vi=(
                WAITING_FOR_OCR_WORKER_SUBSTATUS_VI
                if mapped_status == "WAITING_FOR_WORKER"
                else _stage_label("OCR")
            ),
            priority=int(job.Priority or 50),
            attempt_count=int(job.AttemptCount or 0),
            max_attempts=int(job.MaxAttempts or 3),
            progress_completed=None,
            progress_total=None,
            progress_unit=None,
            progress_pct=None,
            is_indeterminate=True,
            can_retry=False,
            can_cancel=False,
            result_href=_build_result_href(
                actor_role=actor_role,
                book_id=job.BookId,
                book_page_id=job.PageId,
                job_type=str(job.JobKind),
            ),
            error_code=job.ErrorCode,
            error_message_vi=job.ErrorMessage,
            created_at=created_at,
            updated_at=updated_at,
            started_at=job.ClaimedAt,
            completed_at=job.CompletedAt,
        )

    def _map_admin_workflow(
        self,
        wf: AdminAiWorkflow,
        *,
        book_titles: dict[UUID, str],
        page_numbers: dict[UUID, int],
    ) -> GlobalTaskItem:
        raw_status = str(wf.Status or "QUEUED").upper()
        mapped_status: GlobalTaskStatus
        if raw_status == "QUEUED":
            mapped_status = "QUEUED"
        elif raw_status in ("RUNNING", "IN_PROGRESS"):
            mapped_status = "RUNNING"
        elif raw_status in ("READY_FOR_ADMIN_REVIEW", "READY_FOR_REVIEW", "NEEDS_REVIEW"):
            mapped_status = "WAITING_FOR_REVIEW"
        elif raw_status in ("APPROVED", "COMPLETED", "VERIFIED"):
            mapped_status = "SUCCEEDED"
        elif raw_status == "FAILED":
            mapped_status = "FAILED"
        elif raw_status == "CANCELLED":
            mapped_status = "CANCELLED"
        elif raw_status == "STALE":
            mapped_status = "STALE"
        else:
            mapped_status = "RUNNING"

        total_chunks = int(wf.TotalChunks or 0)
        completed_chunks = int(wf.CompletedChunks or 0)
        completed, total, unit, pct, is_indeterminate = compute_honest_progress(
            completed_chunks if total_chunks > 0 else None,
            total_chunks if total_chunks > 0 else None,
            "đoạn" if total_chunks > 0 else None,
        )
        created_at = wf.CreatedAt or datetime.now(timezone.utc)
        updated_at = wf.UpdatedAt or created_at
        return GlobalTaskItem(
            id=wf.Id,
            source="admin_ai_workflow",
            job_type="ADMIN_AI_WORKFLOW",
            title_vi=JOB_TYPE_TITLES_VI["ADMIN_AI_WORKFLOW"],
            book_id=wf.BookId,
            book_page_id=wf.PageId,
            book_title=book_titles.get(wf.BookId) if wf.BookId else None,
            page_number=page_numbers.get(wf.PageId) if wf.PageId else None,
            source_revision_id=wf.PageRevisionId,
            actor_role="admin",
            status=mapped_status,
            status_label_vi=_status_label(mapped_status, "ADMIN_AI_WORKFLOW"),
            stage=str(wf.Stage or "PROOFREADING"),
            stage_label_vi=_stage_label(str(wf.Stage or "PROOFREADING")),
            priority=60,
            attempt_count=int(wf.Attempts or 0),
            max_attempts=3,
            progress_completed=completed,
            progress_total=total,
            progress_unit=unit,
            progress_pct=pct,
            is_indeterminate=is_indeterminate,
            can_retry=False,
            can_cancel=False,
            result_href=_build_result_href(
                actor_role="admin",
                book_id=wf.BookId,
                book_page_id=wf.PageId,
            ),
            error_code=wf.ErrorCode,
            created_at=created_at,
            updated_at=updated_at,
            completed_at=wf.OcrApprovedAt,
        )

    def _map_parent_submission(
        self,
        sub: ParentBookPageSubmission,
        *,
        worker_online: bool | None,
        book_titles: dict[UUID, str],
    ) -> GlobalTaskItem:
        wf_status = str(sub.WorkflowStatus or "CHECKING").upper()
        ocr_status = str(sub.OcrStatus or "PENDING").upper()
        proof_status = str(sub.ProofreadStatus or "PENDING").upper()
        tool_status = str(sub.ToolCheckStatus or "PENDING").upper()

        stages_done = 0
        if ocr_status in ("COMPLETED", "NO_TEXT_DETECTED"):
            stages_done += 1
        if proof_status in ("COMPLETED", "SKIPPED") or bool(sub.IsImageOnly):
            stages_done += 1
        if tool_status in ("PASSED", "FLAGGED", "NEEDS_MANUAL_REVIEW"):
            stages_done += 1

        if wf_status == "CHECKING":
            if ocr_status == "PENDING" and worker_online is False:
                mapped_status: GlobalTaskStatus = "WAITING_FOR_WORKER"
            else:
                mapped_status = "RUNNING"
        elif wf_status in ("PASSED_READY_TO_ADD", "APPROVED_READY_TO_ADD", "COMMITTED", "ADDED_TO_BOOK"):
            mapped_status = "SUCCEEDED"
            stages_done = 3
        elif wf_status in ("NEEDS_ADMIN_REVIEW", "PENDING_ADMIN_REVIEW", "PENDING_ADMIN", "NEEDS_RECHECK"):
            mapped_status = "WAITING_FOR_REVIEW"
        elif wf_status in ("CHECK_FAILED", "REJECTED"):
            mapped_status = "FAILED"
        elif wf_status == "CANCELLED":
            mapped_status = "CANCELLED"
        else:
            mapped_status = "RUNNING"

        if ocr_status == "PENDING":
            stage = "OCR"
        elif proof_status == "PENDING" and not bool(sub.IsImageOnly):
            stage = "PROOFREADING"
        elif tool_status == "PENDING":
            stage = "TOOL_CHECK"
        elif mapped_status == "WAITING_FOR_REVIEW":
            stage = "WAITING_FOR_REVIEW"
        elif mapped_status == "SUCCEEDED":
            stage = "COMPLETED"
        else:
            stage = "PROCESSING"

        completed, total, unit, pct, is_indeterminate = compute_honest_progress(
            stages_done, 3, "bước"
        )
        created_at = sub.CreatedAt or datetime.now(timezone.utc)
        updated_at = sub.UpdatedAt or created_at
        err_code = sub.ToolCheckErrorCode or sub.ProofreadErrorCode or sub.OcrErrorCode
        return GlobalTaskItem(
            id=sub.Id,
            source="parent_submission",
            job_type="PARENT_PAGE_PIPELINE",
            title_vi=JOB_TYPE_TITLES_VI["PARENT_PAGE_PIPELINE"],
            book_id=sub.BookId,
            book_page_id=sub.CommittedPageId,
            book_title=book_titles.get(sub.BookId) if sub.BookId else None,
            page_number=int(sub.TargetPageNumber or sub.SourcePageNumber or 1),
            source_revision_id=sub.CommittedRevisionId,
            actor_role="parent",
            status=mapped_status,
            status_label_vi=_status_label(mapped_status, "PARENT_PAGE_PIPELINE"),
            stage=stage,
            stage_label_vi=(
                WAITING_FOR_OCR_WORKER_SUBSTATUS_VI
                if mapped_status == "WAITING_FOR_WORKER"
                else _stage_label(stage)
            ),
            priority=50,
            attempt_count=int(sub.Attempts or 0),
            max_attempts=3,
            progress_completed=completed,
            progress_total=total,
            progress_unit=unit,
            progress_pct=pct,
            is_indeterminate=is_indeterminate,
            can_retry=False,
            can_cancel=False,
            result_href=_build_result_href(
                actor_role="parent",
                book_id=sub.BookId,
                book_page_id=sub.CommittedPageId,
            ),
            error_code=err_code,
            created_at=created_at,
            updated_at=updated_at,
            completed_at=sub.CommittedAt or sub.ToolCheckCompletedAt,
        )


async def verify_smart_studio_job_fence_in_tx(
    db: AsyncSession,
    *,
    job_id: UUID,
    lease_token: UUID,
    expected_revision_id: UUID | None = None,
    book_page_id: UUID | None = None,
    now: datetime | None = None,
) -> tuple[SmartStudioJob | None, str | None]:
    """Lock and verify active lease, non-cancellation, and revision fence inside the current txn.

    Returns `(job, None)` while keeping the row lock active so callers can write active
    `BookPresentationAsset` rows and commit atomically in the SAME transaction.
    Raises `StaleLeaseError` / `JobCancelledError` on lease/cancel fence, or returns
    `(job, "STALE")` after marking the job `STALE` if superseded.
    """
    current = now or datetime.now(timezone.utc)
    repo = GlobalTasksRepository(db)
    job = await repo.get_job(job_id, lock=True)
    if job is None or job.Status == "CANCELLED":
        if callable(getattr(db, "rollback", None)):
            await db.rollback()
        raise JobCancelledError(f"Job {job_id} is cancelled or missing")

    if job.LeaseToken is None or job.LeaseToken != lease_token:
        if callable(getattr(db, "rollback", None)):
            await db.rollback()
        raise StaleLeaseError(
            f"Stale lease token for job {job_id}; refusing write from superseded worker"
        )

    if job.Status == "CANCEL_REQUESTED":
        job.Status = "CANCELLED"
        job.Stage = "CANCELLED"
        job.LeaseToken = None
        job.LeaseExpiresAt = None
        job.WorkerId = None
        job.CompletedAt = current
        job.UpdatedAt = current
        await db.commit()
        raise JobCancelledError(f"Job {job_id} cancel requested before asset write")

    if job.Status == "STALE":
        job.LeaseToken = None
        job.LeaseExpiresAt = None
        job.WorkerId = None
        job.CompletedAt = job.CompletedAt or current
        job.UpdatedAt = current
        await db.commit()
        return job, "STALE"

    target_rev = job.SourceRevisionId or expected_revision_id
    target_page = job.BookPageId or book_page_id
    if target_rev is not None and target_page is not None:
        active_rev = await repo.get_active_page_revision_id(target_page)
        if active_rev is not None and active_rev != target_rev:
            job.Status = "STALE"
            job.Stage = "STALE"
            job.LeaseToken = None
            job.LeaseExpiresAt = None
            job.WorkerId = None
            job.ErrorCode = "SOURCE_REVISION_SUPERSEDED"
            job.ErrorMessageVi = (
                "Trang sách đã có phiên bản mới hơn; kết quả cũ đã bị bỏ qua để tránh ghi đè."
            )
            job.CompletedAt = current
            job.UpdatedAt = current
            await db.commit()
            return job, "STALE"

    return job, None


def _map_non_success_studio_status(raw_status: str) -> GlobalTaskStatus:
    upper = (raw_status or "").strip().upper()
    if upper == "WAITING_FOR_QUOTA":
        return "WAITING_FOR_QUOTA"
    if upper in ("SUPERSEDED_BY_USER_UPLOAD", "STALE"):
        return "STALE"
    return "FAILED"


async def process_one_smart_studio_job(
    db: AsyncSession,
    *,
    worker_id: str = "smart-studio-worker",
    lease_seconds: int = 120,
) -> bool:
    """Claim and execute at most one durable `SmartStudioJob` with lease & revision fencing."""
    svc = GlobalTasksService(db)
    job = await svc.claim_next_job(worker_id=worker_id, lease_seconds=lease_seconds)
    if job is None or not job.LeaseToken:
        return False

    job_id = job.Id
    lease_token = job.LeaseToken
    job_type = job.JobType
    job_actor_id = job.ActorId
    job_book_id = job.BookId
    job_page_id = job.BookPageId
    source_revision_id = job.SourceRevisionId
    attempt_count = int(job.AttemptCount or 1)
    max_attempts = int(job.MaxAttempts or 3)
    job_stage = str(job.Stage or "PROCESSING")
    job_progress_completed = job.ProgressCompleted
    job_progress_total = job.ProgressTotal
    job_progress_unit = job.ProgressUnit
    checkpoints = dict(job.CheckpointsJson) if isinstance(job.CheckpointsJson, dict) else {}

    async def _is_job_still_leased() -> bool:
        current_job = await svc.repo.get_job(job_id, lock=False)
        return (
            current_job is not None
            and current_job.LeaseToken == lease_token
            and current_job.Status in ("RUNNING", "CANCEL_REQUESTED")
        )

    try:
        if job_type in ("STYLE_BIBLE", "BOOK_STYLE_BIBLE") and job_book_id is not None:
            from app.services.book_style_bible import BookStyleBibleService

            res = await BookStyleBibleService(db).build_for_actor(
                job_actor_id,
                job_book_id,
                force_refresh=True,
            )
            await svc.commit_stage_result(
                job_id=job_id,
                lease_token=lease_token,
                stage="STYLE_ANALYSIS",
                checkpoint_data={"style_context_hash": res.context_hash},
                next_status="SUCCEEDED",
                result_ref={"book_id": str(res.book_id), "context_hash": res.context_hash},
                progress_completed=1,
                progress_total=1,
                progress_unit="bước",
            )
            return True

        if job_type in ("COVER_GENERATE", "BOOK_COVER_AI") and job_book_id is not None:
            from app.schemas.book_assets import BookCoverGenerateRequest
            from app.services.book_cover_service import BookCoverService

            force_regen = bool(checkpoints.get("force_regenerate", False))
            prompt_hint = checkpoints.get("prompt_hint")
            res = await BookCoverService(db).generate_ai_cover(
                job_actor_id,
                job_book_id,
                BookCoverGenerateRequest(
                    force_regenerate=force_regen,
                    prompt_hint=str(prompt_hint) if isinstance(prompt_hint, str) and prompt_hint.strip() else None,
                    idempotency_key=f"worker:{job_id}:{attempt_count}",
                ),
                existing_job_id=job_id,
                existing_lease_token=lease_token,
            )
            if await _is_job_still_leased():
                if res.status == "SUCCEEDED" and res.cover is not None:
                    await svc.commit_stage_result(
                        job_id=job_id,
                        lease_token=lease_token,
                        stage="COVER_GEN",
                        checkpoint_data={"asset_id": str(res.cover.id)},
                        next_status="SUCCEEDED",
                        result_ref={"asset_id": str(res.cover.id)},
                        progress_completed=2,
                        progress_total=2,
                        progress_unit="bước",
                    )
                else:
                    mapped_status = _map_non_success_studio_status(res.status)
                    await svc.commit_stage_result(
                        job_id=job_id,
                        lease_token=lease_token,
                        stage=(
                            "WAITING_FOR_QUOTA"
                            if mapped_status == "WAITING_FOR_QUOTA"
                            else res.status[:40]
                            if mapped_status == "STALE"
                            else "COVER_GEN"
                        ),
                        mark_stage_completed=False,
                        next_status=mapped_status,
                        error_code=res.status,
                        error_message_vi=res.message_vi,
                    )
            return True

        if (
            job_type in ("ILLUSTRATION_EXTRACT", "PAGE_ILLUSTRATION_EXTRACT")
            and job_book_id is not None
            and job_page_id is not None
        ):
            from app.schemas.book_assets import PageIllustrationExtractRequest
            from app.services.book_illustration_service import BookIllustrationService

            res = await BookIllustrationService(db).extract_page_illustration(
                job_actor_id,
                job_book_id,
                job_page_id,
                PageIllustrationExtractRequest(),
                existing_job_id=job_id,
                existing_lease_token=lease_token,
                existing_source_revision_id=source_revision_id,
            )
            if await _is_job_still_leased():
                if res.status == "EXTRACTED_VERIFIED" and res.asset is not None:
                    await svc.commit_stage_result(
                        job_id=job_id,
                        lease_token=lease_token,
                        stage="ILLUSTRATION_EXTRACT",
                        checkpoint_data={"asset_id": str(res.asset.id)},
                        next_status="SUCCEEDED",
                        result_ref={"asset_id": str(res.asset.id)},
                        progress_completed=1,
                        progress_total=1,
                        progress_unit="trang",
                    )
                else:
                    mapped_status = _map_non_success_studio_status(res.status)
                    await svc.commit_stage_result(
                        job_id=job_id,
                        lease_token=lease_token,
                        stage="ILLUSTRATION_EXTRACT",
                        mark_stage_completed=False,
                        next_status=mapped_status,
                        error_code=res.status,
                        error_message_vi=res.message_vi,
                    )
            return True

        if (
            job_type in ("ILLUSTRATION_GENERATE", "PAGE_ILLUSTRATION_AI")
            and job_book_id is not None
            and job_page_id is not None
        ):
            from app.schemas.book_assets import PageIllustrationGenerateRequest
            from app.services.book_illustration_service import BookIllustrationService

            prompt_hint = checkpoints.get("prompt_hint")
            res = await BookIllustrationService(db).generate_page_illustration(
                job_actor_id,
                job_book_id,
                job_page_id,
                PageIllustrationGenerateRequest(
                    prompt_hint=str(prompt_hint) if isinstance(prompt_hint, str) and prompt_hint.strip() else None,
                    idempotency_key=f"worker:{job_id}:{attempt_count}",
                ),
                existing_job_id=job_id,
                existing_lease_token=lease_token,
                existing_source_revision_id=source_revision_id,
            )
            if await _is_job_still_leased():
                if res.status == "SUCCEEDED" and res.asset is not None:
                    await svc.commit_stage_result(
                        job_id=job_id,
                        lease_token=lease_token,
                        stage="ILLUSTRATION_GEN",
                        checkpoint_data={"asset_id": str(res.asset.id)},
                        next_status="SUCCEEDED",
                        result_ref={"asset_id": str(res.asset.id)},
                        progress_completed=2,
                        progress_total=2,
                        progress_unit="bước",
                    )
                else:
                    mapped_status = _map_non_success_studio_status(res.status)
                    await svc.commit_stage_result(
                        job_id=job_id,
                        lease_token=lease_token,
                        stage=(
                            "WAITING_FOR_QUOTA"
                            if mapped_status == "WAITING_FOR_QUOTA"
                            else "STALE"
                            if mapped_status == "STALE"
                            else "ILLUSTRATION_GEN"
                        ),
                        mark_stage_completed=False,
                        next_status=mapped_status,
                        error_code=res.status,
                        error_message_vi=res.message_vi,
                    )
            return True

        # Unsupported or externally-driven job type: release cleanly to WAITING_FOR_WORKER
        await svc.commit_stage_result(
            job_id=job_id,
            lease_token=lease_token,
            stage=job_stage or "QUEUED",
            mark_stage_completed=False,
            checkpoint_data={"dispatched_by": worker_id},
            next_status="WAITING_FOR_WORKER",
            progress_completed=job_progress_completed,
            progress_total=job_progress_total,
            progress_unit=job_progress_unit,
        )
        return True
    except (StaleLeaseError, JobCancelledError):
        return True
    except Exception as exc:
        logger.warning(
            "smart_studio_job_execution_failed job_id=%s type=%s err=%s",
            job_id,
            job_type,
            type(exc).__name__,
        )
        try:
            next_state: GlobalTaskStatus = (
                "FAILED"
                if attempt_count >= max_attempts
                else "RETRY_SCHEDULED"
            )
            await svc.commit_stage_result(
                job_id=job_id,
                lease_token=lease_token,
                stage=job_stage,
                mark_stage_completed=False,
                next_status=next_state,
                error_code="WORKER_EXECUTION_ERROR",
                error_message_vi="Tác vụ gặp lỗi tạm thời và sẽ tự động thử lại.",
            )
        except Exception:
            logger.debug("smart_studio_fail_job_skipped", exc_info=True)
        return True


_SMART_STUDIO_WAKE_EVENTS: dict[int, asyncio.Event] = {}
_SMART_STUDIO_LOOP_ACTIVE: set[int] = set()
_EVENT_SMART_STUDIO_TASKS: set[asyncio.Task[Any]] = set()
_EVENT_SMART_STUDIO_SEMAPHORES: dict[int, asyncio.Semaphore] = {}


def _get_smart_studio_wake_event() -> asyncio.Event:
    loop_id = id(asyncio.get_running_loop())
    ev = _SMART_STUDIO_WAKE_EVENTS.get(loop_id)
    if ev is None:
        ev = asyncio.Event()
        _SMART_STUDIO_WAKE_EVENTS[loop_id] = ev
    return ev


def _event_smart_studio_semaphore() -> asyncio.Semaphore:
    loop_id = id(asyncio.get_running_loop())
    sem = _EVENT_SMART_STUDIO_SEMAPHORES.get(loop_id)
    if sem is None:
        sem = asyncio.Semaphore(1)
        _EVENT_SMART_STUDIO_SEMAPHORES[loop_id] = sem
    return sem


def _is_smart_studio_continuous_worker_configured() -> bool:
    import os

    from app.services.ocr_inference_job_service import is_heavy_workers_disabled

    raw = os.getenv("VIREAD_ENABLE_SMART_STUDIO_WORKER")
    if raw is not None and raw.strip():
        norm = raw.strip().lower()
        if norm in {"1", "true", "yes", "on"}:
            return True
        if norm in {"0", "false", "no", "off"}:
            return False
    raw_legacy = os.getenv("VIREAD_SMART_STUDIO_WORKER_ENABLED")
    legacy_disabled = raw_legacy is not None and raw_legacy.strip().lower() in {
        "0",
        "false",
        "no",
        "off",
    }
    return (not is_heavy_workers_disabled()) and (not legacy_disabled)


async def _drain_scheduled_smart_studio_jobs(
    *,
    max_jobs: int = 8,
    worker_id: str = "smart-studio-event-drain",
) -> int:
    from app.database.session import AsyncSessionLocal
    from app.services.worker_telemetry import (
        persist_worker_heartbeat_with_factory,
        record_worker_error,
        record_worker_success,
    )

    await asyncio.sleep(0)
    sem = _event_smart_studio_semaphore()
    processed_count = 0
    async with sem:
        try:
            for _ in range(max(1, max_jobs)):
                async with AsyncSessionLocal() as db:
                    did_work = await process_one_smart_studio_job(
                        db, worker_id=worker_id
                    )
                if not did_work:
                    break
                processed_count += 1
            record_worker_success("smart_studio")
            await persist_worker_heartbeat_with_factory(
                AsyncSessionLocal,
                "smart_studio",
                execution_mode="on_demand",
                ok=True,
                items_processed=processed_count,
                source="event",
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            record_worker_error("smart_studio", exc)
            await persist_worker_heartbeat_with_factory(
                AsyncSessionLocal,
                "smart_studio",
                execution_mode="on_demand",
                ok=False,
                items_processed=processed_count,
                source="event",
                error_code=type(exc).__name__,
            )
            logger.warning(
                "smart_studio_event_drain_failed err=%s", type(exc).__name__
            )
    return processed_count


def schedule_smart_studio_drain(
    *,
    force: bool = False,
    max_jobs: int = 8,
) -> asyncio.Task[Any] | None:
    """Single-flight bounded event-driven drain when continuous Smart Studio loop is disabled."""
    import os

    from app.database.config import APP_ENVIRONMENT

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None

    if not force:
        app_env = (os.getenv("APP_ENVIRONMENT") or APP_ENVIRONMENT or "").strip().lower()
        if app_env == "test":
            return None
        if (
            id(loop) in _SMART_STUDIO_LOOP_ACTIVE
            or _is_smart_studio_continuous_worker_configured()
        ):
            return None

    active_tasks = [t for t in list(_EVENT_SMART_STUDIO_TASKS) if not t.done()]
    if active_tasks:
        return active_tasks[0]

    task = loop.create_task(
        _drain_scheduled_smart_studio_jobs(max_jobs=max_jobs),
        name="smart_studio_event_drain",
    )
    _EVENT_SMART_STUDIO_TASKS.add(task)
    task.add_done_callback(_EVENT_SMART_STUDIO_TASKS.discard)
    return task


async def shutdown_scheduled_smart_studio_tasks(
    *, timeout_seconds: float = 5.0
) -> None:
    if not _EVENT_SMART_STUDIO_TASKS:
        return
    pending = [task for task in list(_EVENT_SMART_STUDIO_TASKS) if not task.done()]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=timeout_seconds)


def notify_smart_studio_worker() -> None:
    """Wake `run_smart_studio_worker_loop` or schedule event-driven drain when disabled."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _get_smart_studio_wake_event().set()
    if (
        id(loop) not in _SMART_STUDIO_LOOP_ACTIVE
        and not _is_smart_studio_continuous_worker_configured()
    ):
        schedule_smart_studio_drain()


async def run_smart_studio_worker_loop(
    stop_event: asyncio.Event,
    *,
    poll_interval_seconds: float | None = None,
    reconcile_interval_seconds: float | None = None,
    worker_id: str = "smart-studio-web-worker",
) -> None:
    """Lightweight durable background worker for Smart Studio jobs + periodic R-01 reconciliation."""
    import os

    from app.database.session import AsyncSessionLocal
    from app.services.ocr_inference_job_service import is_heavy_workers_disabled
    from app.services.worker_telemetry import record_worker_success

    light_web_tier = is_heavy_workers_disabled()
    if poll_interval_seconds is None:
        default_poll = 60.0 if light_web_tier else 5.0
        try:
            effective_poll = max(
                1.0,
                float(
                    os.getenv("SMART_STUDIO_WORKER_POLL_SECONDS", str(default_poll))
                ),
            )
        except ValueError:
            effective_poll = default_poll
    else:
        effective_poll = max(0.05, float(poll_interval_seconds))

    if reconcile_interval_seconds is None:
        default_reconcile = 300.0 if light_web_tier else 60.0
        try:
            effective_reconcile = max(
                15.0,
                float(
                    os.getenv(
                        "SMART_STUDIO_RECONCILE_SECONDS", str(default_reconcile)
                    )
                ),
            )
        except ValueError:
            effective_reconcile = default_reconcile
    else:
        effective_reconcile = max(1.0, float(reconcile_interval_seconds))

    loop_id = id(asyncio.get_running_loop())
    _SMART_STUDIO_LOOP_ACTIVE.add(loop_id)
    wake_event = _get_smart_studio_wake_event()
    last_reconcile_at = 0.0
    try:
        while not stop_event.is_set():
            wake_event.clear()
            now_mono = time.monotonic()
            if (now_mono - last_reconcile_at) >= effective_reconcile or last_reconcile_at == 0.0:
                try:
                    async with AsyncSessionLocal() as db:
                        await GlobalTasksService(db).reconcile_stale_jobs()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.warning("smart_studio_periodic_reconcile_skipped", exc_info=True)
                last_reconcile_at = time.monotonic()

            processed = False
            try:
                async with AsyncSessionLocal() as db:
                    processed = await process_one_smart_studio_job(db, worker_id=worker_id)
                record_worker_success("smart_studio")
            except asyncio.CancelledError:
                raise
            except SQLAlchemyError as exc:
                if _is_missing_table_error(exc):
                    logger.debug("smart_studio_worker_table_missing_sleeping")
                else:
                    logger.debug("smart_studio_worker_poll_skipped", exc_info=True)
            except Exception:
                logger.debug("smart_studio_worker_poll_skipped", exc_info=True)

            if processed:
                continue

            stop_wait = asyncio.create_task(stop_event.wait())
            wake_wait = asyncio.create_task(wake_event.wait())
            try:
                await asyncio.wait(
                    {stop_wait, wake_wait},
                    timeout=effective_poll,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                for waiter in (stop_wait, wake_wait):
                    if not waiter.done():
                        waiter.cancel()
                await asyncio.gather(stop_wait, wake_wait, return_exceptions=True)
    finally:
        _SMART_STUDIO_LOOP_ACTIVE.discard(loop_id)
