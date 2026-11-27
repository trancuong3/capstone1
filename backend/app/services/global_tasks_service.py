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
from app.services.ai_task_progress import (
    compute_admin_workflow_progress,
    compute_ocr_job_progress,
    compute_parent_submission_progress,
    compute_studio_job_progress,
    extract_ocr_worker_phase,
)
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
    "OCR_EXTRACT": "Tách nội dung OCR",
    "PROOFREADING": "Soát lỗi chính tả AI",
    "CHILD_SAFETY": "Kiểm tra an toàn trẻ em",
    "CHILD_SAFETY_SCANNING": "Kiểm tra an toàn trẻ em",
    "TOOL_CHECK": "Kiểm tra an toàn & chất lượng",
    "STYLE_BIBLE": "Phân tích phong cách sách",
    "STYLE_ANALYSIS": "Phân tích phong cách sách",
    "IMAGE_GENERATING": "Đang tạo ảnh AI",
    "ILLUSTRATION": "Xử lý tranh minh họa",
    "ILLUSTRATION_EXTRACT": "Tách tranh minh họa",
    "ILLUSTRATION_GEN": "Tạo tranh minh họa AI",
    "COVER": "Xử lý bìa sách",
    "COVER_GEN": "Tạo bìa sách AI",
    "TEXT_FREE_VERIFY": "Kiểm chứng tranh không chứa chữ",
    "SAVING": "Đang lưu kết quả",
    "WAITING_FOR_REVIEW": "Chờ người dùng xác minh",
    "COMPLETED": "Hoàn tất",
    "FAILED": "Gặp lỗi",
    "CANCELLED": "Đã hủy",
    "STALE": "Đã lỗi thời",
}

_OCR_PHASE_LABELS_VI: dict[str, str] = {
    "downloading": "Đang tải ảnh trang sách",
    "fetch": "Đang tải ảnh trang sách",
    "fetching": "Đang tải ảnh trang sách",
    "loading_image": "Đang tải ảnh trang sách",
    "preprocessing": "Đang tiền xử lý ảnh trang",
    "preprocess": "Đang tiền xử lý ảnh trang",
    "deskew": "Đang căn chỉnh góc trang",
    "detecting": "Đang dò vị trí dòng chữ",
    "detection": "Đang dò vị trí dòng chữ",
    "layout": "Đang phân tích bố cục trang",
    "craft": "Đang dò vị trí dòng chữ",
    "paddle_det": "Đang dò vị trí dòng chữ",
    "recognizing": "Đang nhận diện chữ tiếng Việt",
    "recognition": "Đang nhận diện chữ tiếng Việt",
    "vietocr": "Đang nhận diện chữ tiếng Việt",
    "ocr": "Đang nhận diện chữ tiếng Việt",
    "inferencing": "Đang nhận diện chữ tiếng Việt",
    "postprocessing": "Đang hoàn tất kết quả OCR",
    "postprocess": "Đang hoàn tất kết quả OCR",
    "finalizing": "Đang hoàn tất kết quả OCR",
    "uploading": "Đang lưu kết quả OCR",
    "saving": "Đang lưu kết quả OCR",
}


def _ocr_phase_label_vi(worker_phase: str | None) -> str | None:
    if not worker_phase:
        return None
    norm = worker_phase.strip().lower()
    if norm in _OCR_PHASE_LABELS_VI:
        return _OCR_PHASE_LABELS_VI[norm]
    for marker, label in _OCR_PHASE_LABELS_VI.items():
        if marker in norm:
            return label
    return None


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

    async def resolve_actor_portal(
        self,
        actor_id: UUID,
        portal: ActorRole | None = None,
    ) -> ActorRole:
        actor_role = await self.require_actor_role(actor_id)
        if portal is not None and portal != actor_role:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="PORTAL_ROLE_MISMATCH",
            )
        return actor_role

    async def create_task(
        self,
        *,
        actor_id: UUID,
        payload: GlobalTaskCreateRequest,
        portal: ActorRole | None = None,
    ) -> GlobalTaskActionResponse:
        actor_role = await self.resolve_actor_portal(actor_id, portal)

        # Enforce strict tenant & portal ownership when referencing a book, page, or revision.
        authorized_book_id: UUID | None = None
        if payload.book_id is not None:
            book = await self.repo.get_book(payload.book_id)
            if book is None or bool(getattr(book, "IsDeleted", False)):
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BOOK_NOT_FOUND")
            if actor_role == "admin" and is_book_private(book):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="ADMIN_PRIVATE_BOOK_TASK_FORBIDDEN",
                )
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
            if actor_role == "admin":
                page_book = await self.repo.get_book(page.BookId)
                if page_book is not None and is_book_private(page_book):
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="ADMIN_PRIVATE_BOOK_TASK_FORBIDDEN",
                    )
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
        portal: ActorRole | None = None,
    ) -> GlobalTaskActionResponse:
        actor_role = await self.resolve_actor_portal(actor_id, portal)
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
        portal: ActorRole | None = None,
    ) -> GlobalTaskActionResponse:
        actor_role = await self.resolve_actor_portal(actor_id, portal)
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

    async def _resolve_worker_online(self, *, was_in_tx: bool) -> bool | None:
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
        return worker_online

    async def get_task(
        self,
        *,
        actor_id: UUID,
        job_id: UUID,
        portal: ActorRole | None = None,
    ) -> GlobalTaskItem:
        """Fetch a single task strictly scoped to `(actor_id, portal)` (404 on cross-actor/portal)."""
        in_tx_fn = getattr(self.db, "in_transaction", None)
        was_in_tx = bool(in_tx_fn()) if callable(in_tx_fn) else False
        actor_role = await self.resolve_actor_portal(actor_id, portal)
        worker_online = await self._resolve_worker_online(was_in_tx=was_in_tx)

        studio_job = await self.repo.get_job_for_actor(
            job_id,
            actor_id=actor_id,
            actor_role=actor_role,
            lock=False,
        )
        if studio_job is not None:
            book_titles = await self.repo.get_book_titles(
                {studio_job.BookId} if studio_job.BookId else set()
            )
            page_numbers = await self.repo.get_page_numbers(
                {studio_job.BookPageId} if studio_job.BookPageId else set()
            )
            ocr_by_id: dict[UUID, OcrInferenceJob] = {}
            checkpoints = (
                studio_job.CheckpointsJson
                if isinstance(studio_job.CheckpointsJson, dict)
                else {}
            )
            raw_ocr_ids = checkpoints.get("ocr_job_ids")
            if studio_job.JobType == "BATCH_BOOK_IMPORT" and isinstance(raw_ocr_ids, list):
                parsed_ids: list[UUID] = []
                for raw_id in raw_ocr_ids:
                    try:
                        parsed_ids.append(UUID(str(raw_id)))
                    except (ValueError, TypeError):
                        continue
                if parsed_ids:
                    linked_rows = await self.repo.list_ocr_inference_jobs_by_ids(
                        parsed_ids,
                        actor_id=actor_id,
                    )
                    ocr_by_id = {row.Id: row for row in linked_rows}
            return self._map_studio_job(
                studio_job,
                book_titles=book_titles,
                page_numbers=page_numbers,
                ocr_jobs_by_id=ocr_by_id,
                worker_online=worker_online,
            )

        ocr_job = await self.repo.get_ocr_inference_job_for_actor(
            job_id,
            actor_id=actor_id,
            actor_role=actor_role,
        )
        if ocr_job is not None:
            book_titles = await self.repo.get_book_titles(
                {ocr_job.BookId} if ocr_job.BookId else set()
            )
            page_numbers = await self.repo.get_page_numbers(
                {ocr_job.PageId} if ocr_job.PageId else set()
            )
            return self._map_ocr_job(
                ocr_job,
                actor_id=actor_id,
                actor_role=actor_role,
                worker_online=worker_online,
                book_titles=book_titles,
                page_numbers=page_numbers,
            )

        if actor_role == "admin":
            wf = await self.repo.get_admin_workflow_for_actor(job_id, actor_id=actor_id)
            if wf is not None:
                book_titles = await self.repo.get_book_titles(
                    {wf.BookId} if wf.BookId else set()
                )
                page_numbers = await self.repo.get_page_numbers(
                    {wf.PageId} if wf.PageId else set()
                )
                return self._map_admin_workflow(
                    wf,
                    actor_id=actor_id,
                    book_titles=book_titles,
                    page_numbers=page_numbers,
                )
        else:
            sub = await self.repo.get_parent_submission_for_actor(job_id, actor_id=actor_id)
            if sub is not None:
                linked_ocr = await self.repo.get_latest_ocr_job_for_submission(
                    sub.Id,
                    actor_id=actor_id,
                )
                book_titles = await self.repo.get_book_titles(
                    {sub.BookId} if sub.BookId else set()
                )
                return self._map_parent_submission(
                    sub,
                    worker_online=worker_online,
                    book_titles=book_titles,
                    linked_ocr_job=linked_ocr,
                )

        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="TASK_NOT_FOUND")

    async def list_tasks(
        self,
        *,
        actor_id: UUID,
        limit: int = 40,
        active_only: bool = False,
        portal: ActorRole | None = None,
    ) -> GlobalTaskListResponse:
        """Aggregate all durable workflows strictly isolated to `(actor_id, portal)`."""
        in_tx_fn = getattr(self.db, "in_transaction", None)
        was_in_tx = bool(in_tx_fn()) if callable(in_tx_fn) else False
        actor_role = await self.resolve_actor_portal(actor_id, portal)
        worker_online = await self._resolve_worker_online(was_in_tx=was_in_tx)

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
            await self.repo.list_admin_workflows(actor_id=actor_id, limit=limit)
            if actor_role == "admin"
            else []
        )
        parent_submissions: list[ParentBookPageSubmission] = (
            await self.repo.list_parent_submissions(actor_id=actor_id, limit=limit)
            if actor_role == "parent"
            else []
        )

        # Fetch any additional OCR jobs referenced by admin BATCH_BOOK_IMPORT tracking jobs.
        ocr_jobs_by_id: dict[UUID, OcrInferenceJob] = {row.Id: row for row in ocr_jobs}
        missing_batch_ocr_ids: set[UUID] = set()
        for studio_job in studio_jobs:
            if studio_job.JobType != "BATCH_BOOK_IMPORT":
                continue
            cp = studio_job.CheckpointsJson if isinstance(studio_job.CheckpointsJson, dict) else {}
            raw_ids = cp.get("ocr_job_ids")
            if isinstance(raw_ids, list):
                for raw_id in raw_ids:
                    try:
                        parsed = UUID(str(raw_id))
                    except (ValueError, TypeError):
                        continue
                    if parsed not in ocr_jobs_by_id:
                        missing_batch_ocr_ids.add(parsed)
        if missing_batch_ocr_ids:
            extra_ocr = await self.repo.list_ocr_inference_jobs_by_ids(
                list(missing_batch_ocr_ids),
                actor_id=actor_id,
            )
            for row in extra_ocr:
                ocr_jobs_by_id[row.Id] = row

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

        # Deduplicate ParentBookPageSubmission + linked PARENT_BOOK_SUBMISSION OcrInferenceJob
        # into one unified parent_submission task item with continuous merged OCR phase `%`.
        submissions_by_id: dict[UUID, ParentBookPageSubmission] = {
            sub.Id: sub for sub in parent_submissions
        }
        linked_ocr_by_submission: dict[UUID, OcrInferenceJob] = {}

        items: list[GlobalTaskItem] = []
        for job in studio_jobs:
            items.append(
                self._map_studio_job(
                    job,
                    book_titles=book_titles,
                    page_numbers=page_numbers,
                    ocr_jobs_by_id=ocr_jobs_by_id,
                    worker_online=worker_online,
                )
            )
        for ocr_job in ocr_jobs:
            if (
                actor_role == "parent"
                and str(ocr_job.JobKind) == "PARENT_BOOK_SUBMISSION"
                and ocr_job.SubmissionId is not None
                and ocr_job.SubmissionId in submissions_by_id
            ):
                linked_ocr_by_submission.setdefault(ocr_job.SubmissionId, ocr_job)
                continue
            items.append(
                self._map_ocr_job(
                    ocr_job,
                    actor_id=actor_id,
                    actor_role=actor_role,
                    worker_online=worker_online,
                    book_titles=book_titles,
                    page_numbers=page_numbers,
                )
            )
        for wf in admin_workflows:
            items.append(
                self._map_admin_workflow(
                    wf,
                    actor_id=actor_id,
                    book_titles=book_titles,
                    page_numbers=page_numbers,
                )
            )
        for sub in parent_submissions:
            items.append(
                self._map_parent_submission(
                    sub,
                    worker_online=worker_online,
                    book_titles=book_titles,
                    linked_ocr_job=linked_ocr_by_submission.get(sub.Id),
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
            portal=actor_role,
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
        ocr_jobs_by_id: dict[UUID, OcrInferenceJob] | None = None,
        worker_online: bool | None = None,
    ) -> GlobalTaskItem:
        actor_role: ActorRole = "admin" if job.ActorRole == "admin" else "parent"
        status_val: GlobalTaskStatus = job.Status  # type: ignore[assignment]
        stage_val = str(job.Stage or "QUEUED")
        raw_completed = job.ProgressCompleted
        raw_total = job.ProgressTotal
        raw_unit = job.ProgressUnit
        checkpoints = dict(job.CheckpointsJson or {}) if isinstance(job.CheckpointsJson, dict) else {}

        # Live page-level rollup for remote-OCR BATCH_BOOK_IMPORT tracking jobs.
        if (
            job.JobType == "BATCH_BOOK_IMPORT"
            and checkpoints.get("tracking_mode") == "remote_ocr_batch"
            and isinstance(checkpoints.get("ocr_job_ids"), list)
            and ocr_jobs_by_id
        ):
            linked_rows: list[OcrInferenceJob] = []
            for raw_id in checkpoints["ocr_job_ids"]:
                try:
                    uid = UUID(str(raw_id))
                except (ValueError, TypeError):
                    continue
                if uid in ocr_jobs_by_id:
                    linked_rows.append(ocr_jobs_by_id[uid])
            if linked_rows:
                total_batch = max(len(checkpoints["ocr_job_ids"]), len(linked_rows))
                succeeded_n = sum(1 for r in linked_rows if str(r.Status or "").upper() == "SUCCEEDED")
                failed_n = sum(
                    1 for r in linked_rows if str(r.Status or "").upper() in ("DEAD_LETTER", "FAILED", "CANCELLED")
                )
                running_n = sum(
                    1 for r in linked_rows if str(r.Status or "").upper() in ("CLAIMED", "RUNNING")
                )
                done_n = min(total_batch, succeeded_n + failed_n)
                raw_completed = done_n
                raw_total = total_batch
                raw_unit = raw_unit or "trang"
                if done_n >= total_batch:
                    if succeeded_n == total_batch:
                        status_val = "SUCCEEDED"
                        stage_val = "COMPLETED"
                    elif succeeded_n > 0:
                        status_val = "PARTIAL_SUCCESS"
                        stage_val = "COMPLETED"
                    else:
                        status_val = "FAILED"
                        stage_val = "FAILED"
                elif running_n > 0 or done_n > 0:
                    status_val = "RUNNING"
                    stage_val = "OCR"
                elif worker_online is False:
                    status_val = "WAITING_FOR_WORKER"
                    stage_val = "OCR"

        completed, total, unit, pct, is_indeterminate, progress_mode = compute_studio_job_progress(
            status=status_val,
            stage=stage_val,
            completed=raw_completed,
            total=raw_total,
            unit=raw_unit,
        )
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
            actor_id=job.ActorId,
            actor_role=actor_role,
            portal=actor_role,
            status=status_val,
            status_label_vi=_status_label(status_val, job.JobType),
            stage=stage_val,
            stage_label_vi=(
                WAITING_FOR_OCR_WORKER_SUBSTATUS_VI
                if status_val == "WAITING_FOR_WORKER" and stage_val == "OCR"
                else _stage_label(stage_val)
            ),
            priority=int(job.Priority or 50),
            attempt_count=int(job.AttemptCount or 0),
            max_attempts=int(job.MaxAttempts or 3),
            progress_completed=completed,
            progress_total=total,
            progress_unit=unit,
            progress_pct=pct,
            progress_mode=progress_mode,
            is_indeterminate=is_indeterminate,
            can_retry=status_val in RETRYABLE_STUDIO_STATUSES,
            can_cancel=status_val in ("QUEUED", "RUNNING", "WAITING_FOR_WORKER", "WAITING_FOR_QUOTA", "RETRY_SCHEDULED"),
            result_href=_build_result_href(
                actor_role=actor_role,
                book_id=job.BookId,
                book_page_id=job.BookPageId,
            ),
            result_ref=dict(job.ResultRefJson or {}) if isinstance(job.ResultRefJson, dict) else {},
            checkpoints=checkpoints,
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
        actor_id: UUID | None = None,
    ) -> GlobalTaskItem:
        raw_status = str(job.Status or "QUEUED").upper()
        mapped_status: GlobalTaskStatus
        if raw_status == "QUEUED":
            mapped_status = "WAITING_FOR_WORKER" if worker_online is False else "QUEUED"
        elif raw_status in ("CLAIMED", "RUNNING"):
            mapped_status = "RUNNING"
        elif raw_status == "FAILED_RETRYABLE":
            mapped_status = "RETRY_SCHEDULED"
        elif raw_status == "SUCCEEDED":
            mapped_status = "SUCCEEDED"
        elif raw_status in ("DEAD_LETTER", "FAILED"):
            mapped_status = "FAILED"
        elif raw_status == "CANCELLED":
            mapped_status = "CANCELLED"
        else:
            mapped_status = "QUEUED"

        worker_phase = extract_ocr_worker_phase(getattr(job, "ProcessingMeta", None))
        pct, progress_mode = compute_ocr_job_progress(
            status=raw_status,
            worker_phase=worker_phase,
            worker_online=worker_online,
        )
        phase_label = _ocr_phase_label_vi(worker_phase) if mapped_status == "RUNNING" else None
        stage_label_vi = (
            WAITING_FOR_OCR_WORKER_SUBSTATUS_VI
            if mapped_status == "WAITING_FOR_WORKER"
            else (phase_label or _stage_label("OCR"))
        )
        created_at = job.CreatedAt or datetime.now(timezone.utc)
        updated_at = job.UpdatedAt or created_at
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
            actor_id=job.OwnerUserId or actor_id,
            actor_role=actor_role,
            portal=actor_role,
            status=mapped_status,
            status_label_vi=_status_label(mapped_status, str(job.JobKind)),
            stage=(worker_phase.upper()[:40] if worker_phase and mapped_status == "RUNNING" else "OCR"),
            stage_label_vi=stage_label_vi,
            priority=int(job.Priority or 50),
            attempt_count=int(job.AttemptCount or 0),
            max_attempts=int(job.MaxAttempts or 3),
            progress_completed=None,
            progress_total=None,
            progress_unit=None,
            progress_pct=pct,
            progress_mode=progress_mode,
            is_indeterminate=False,
            can_retry=False,
            can_cancel=False,
            result_href=_build_result_href(
                actor_role=actor_role,
                book_id=job.BookId,
                book_page_id=job.PageId,
                job_type=str(job.JobKind),
            ),
            result_ref=({"worker_phase": worker_phase} if worker_phase else {}),
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
        actor_id: UUID | None = None,
    ) -> GlobalTaskItem:
        raw_status = str(wf.Status or "QUEUED").upper()
        mapped_status: GlobalTaskStatus
        if raw_status == "QUEUED":
            mapped_status = "QUEUED"
        elif raw_status in ("RUNNING", "IN_PROGRESS", "PROOFREADING", "CHILD_SAFETY_SCANNING"):
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
        completed = max(0, min(completed_chunks, total_chunks)) if total_chunks > 0 else None
        total = total_chunks if total_chunks > 0 else None
        unit = "đoạn" if total_chunks > 0 else None
        pct, progress_mode = compute_admin_workflow_progress(
            status=raw_status,
            stage=str(wf.Stage or "PROOFREADING"),
            completed_chunks=completed_chunks,
            total_chunks=total_chunks,
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
            actor_id=wf.ActorId or actor_id,
            actor_role="admin",
            portal="admin",
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
            progress_mode=progress_mode,
            is_indeterminate=False,
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
        linked_ocr_job: OcrInferenceJob | None = None,
    ) -> GlobalTaskItem:
        wf_status = str(sub.WorkflowStatus or "CHECKING").upper()
        ocr_status = str(sub.OcrStatus or "PENDING").upper()
        proof_status = str(sub.ProofreadStatus or "PENDING").upper()
        tool_status = str(sub.ToolCheckStatus or "PENDING").upper()

        linked_ocr_status = str(linked_ocr_job.Status or "").upper() if linked_ocr_job is not None else None
        linked_worker_phase = (
            extract_ocr_worker_phase(getattr(linked_ocr_job, "ProcessingMeta", None))
            if linked_ocr_job is not None
            else None
        )

        if wf_status == "CHECKING":
            if (
                ocr_status == "PENDING"
                and (linked_ocr_status is None or linked_ocr_status == "QUEUED")
                and worker_online is False
            ):
                mapped_status: GlobalTaskStatus = "WAITING_FOR_WORKER"
            else:
                mapped_status = "RUNNING"
        elif wf_status in ("PASSED_READY_TO_ADD", "APPROVED_READY_TO_ADD", "COMMITTED", "ADDED_TO_BOOK"):
            mapped_status = "SUCCEEDED"
        elif wf_status in ("NEEDS_ADMIN_REVIEW", "PENDING_ADMIN_REVIEW", "PENDING_ADMIN", "NEEDS_RECHECK"):
            mapped_status = "WAITING_FOR_REVIEW"
        elif wf_status in ("CHECK_FAILED", "REJECTED"):
            mapped_status = "FAILED"
        elif wf_status == "CANCELLED":
            mapped_status = "CANCELLED"
        else:
            mapped_status = "RUNNING"

        if ocr_status in ("PENDING", "RUNNING"):
            stage = "OCR"
        elif proof_status in ("PENDING", "RUNNING") and not bool(sub.IsImageOnly):
            stage = "PROOFREADING"
        elif tool_status in ("PENDING", "RUNNING"):
            stage = "TOOL_CHECK"
        elif mapped_status == "WAITING_FOR_REVIEW":
            stage = "WAITING_FOR_REVIEW"
        elif mapped_status == "SUCCEEDED":
            stage = "COMPLETED"
        else:
            stage = "PROCESSING"

        stages_done, total_stages, pct, progress_mode = compute_parent_submission_progress(
            workflow_status=wf_status,
            ocr_status=ocr_status,
            proofread_status=proof_status,
            tool_check_status=tool_status,
            is_image_only=bool(sub.IsImageOnly),
            linked_ocr_status=linked_ocr_status,
            linked_ocr_worker_phase=linked_worker_phase,
            worker_online=worker_online,
        )
        phase_label = (
            _ocr_phase_label_vi(linked_worker_phase)
            if stage == "OCR" and mapped_status == "RUNNING"
            else None
        )
        stage_label_vi = (
            WAITING_FOR_OCR_WORKER_SUBSTATUS_VI
            if mapped_status == "WAITING_FOR_WORKER"
            else (phase_label or _stage_label(stage))
        )
        created_at = sub.CreatedAt or datetime.now(timezone.utc)
        updated_at = sub.UpdatedAt or created_at
        if linked_ocr_job is not None and linked_ocr_job.UpdatedAt and linked_ocr_job.UpdatedAt > updated_at:
            updated_at = linked_ocr_job.UpdatedAt
        err_code = sub.ToolCheckErrorCode or sub.ProofreadErrorCode or sub.OcrErrorCode
        result_ref: dict[str, Any] = {}
        if linked_ocr_job is not None:
            result_ref["linked_ocr_job_id"] = str(linked_ocr_job.Id)
            if linked_worker_phase:
                result_ref["worker_phase"] = linked_worker_phase
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
            actor_id=sub.OwnerParentId,
            actor_role="parent",
            portal="parent",
            status=mapped_status,
            status_label_vi=_status_label(mapped_status, "PARENT_PAGE_PIPELINE"),
            stage=stage,
            stage_label_vi=stage_label_vi,
            priority=50,
            attempt_count=int(sub.Attempts or 0),
            max_attempts=3,
            progress_completed=stages_done,
            progress_total=total_stages,
            progress_unit="bước",
            progress_pct=pct,
            progress_mode=progress_mode,
            is_indeterminate=False,
            can_retry=False,
            can_cancel=False,
            result_href=_build_result_href(
                actor_role="parent",
                book_id=sub.BookId,
                book_page_id=sub.CommittedPageId,
            ),
            result_ref=result_ref,
            error_code=err_code,
            created_at=created_at,
            updated_at=updated_at,
            completed_at=sub.CommittedAt or sub.ToolCheckCompletedAt,
        )


async def _execute_ocr_extract_job(
    db: AsyncSession,
    svc: GlobalTasksService,
    job: SmartStudioJob,
    lease_token: UUID,
    scheduler: GpuWorkloadScheduler,
) -> None:
    """Execute durable OCR_EXTRACT job with sibling cross-page analysis & boundary detection."""
    if job.BookPageId is None:
        await svc.commit_stage_result(
            job_id=job.Id,
            lease_token=lease_token,
            stage="OCR_EXTRACT",
            mark_stage_completed=False,
            next_status="FAILED",
            error_code="MISSING_BOOK_PAGE_ID",
            error_message_vi="Tác vụ tách nội dung OCR thiếu mã trang sách.",
        )
        return

    from app.repositories.ocr_extraction_repository import OcrExtractionRepository
    from app.services.ocr_content_extraction import extract_ocr_content
    from app.services.ocr_document_boundary import detect_document_boundary
    from app.services.smart_studio_flags import SmartStudioFlags
    from app.services.storage_service import download_object
    from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET, SUPABASE_STORAGE_BUCKET
    from app.services.gpu_workload_scheduler import WorkloadPriority

    repo = OcrExtractionRepository(db)
    pair = await repo.get_page_with_book(job.BookPageId)
    if pair is None:
        await svc.commit_stage_result(
            job_id=job.Id,
            lease_token=lease_token,
            stage="OCR_EXTRACT",
            mark_stage_completed=False,
            next_status="FAILED",
            error_code="PAGE_NOT_FOUND",
            error_message_vi="Không tìm thấy trang sách cần tách nội dung OCR.",
        )
        return

    page, book = pair
    if job.ActorRole == "parent" and (
        not is_book_private(book) or book.OwnerParentId != job.ActorId
    ):
        await svc.commit_stage_result(
            job_id=job.Id,
            lease_token=lease_token,
            stage="OCR_EXTRACT",
            mark_stage_completed=False,
            next_status="FAILED",
            error_code="ACCESS_DENIED",
            error_message_vi="Bạn không có quyền xử lý trang sách này.",
        )
        return

    checkpoints = job.CheckpointsJson if isinstance(job.CheckpointsJson, dict) else {}
    req_opts = checkpoints.get("request") if isinstance(checkpoints.get("request"), dict) else {}
    raw_mode = str(req_opts.get("filter_mode") or SmartStudioFlags.from_environment().ocr_filter_mode).strip().lower()
    filter_mode = raw_mode if raw_mode in ("off", "shadow", "active") else "active"
    include_cross_page = bool(req_opts.get("include_cross_page", True))
    detect_boundary = bool(req_opts.get("detect_boundary", True))

    revision = await repo.resolve_revision_for_page(page, job.SourceRevisionId)
    words = await repo.load_revision_words(revision.Id) if revision is not None else []
    cross_pages = (
        await repo.load_sibling_cross_pages(book.Id, page.Id)
        if include_cross_page
        else []
    )

    boundary = None
    remaining_stages = get_remaining_stages(job, ["BOUNDARY_DETECT", "OCR_EXTRACT"])
    async with scheduler.acquire(
        priority=WorkloadPriority.URGENT_OCR,
        workload_id=f"ocr-extract:{job.Id}",
        estimated_vram_mb=1500,
    ) as handle:
        if "BOUNDARY_DETECT" in remaining_stages and detect_boundary and page.ImagePath:
            try:
                bucket = (
                    SUPABASE_PRIVATE_BOOKS_BUCKET
                    if is_book_private(book)
                    else (SUPABASE_STORAGE_BUCKET or "books")
                )
                img_bytes = download_object(page.ImagePath, bucket_name=bucket)
                if img_bytes:
                    boundary = detect_document_boundary(
                        img_bytes,
                        word_bboxes_norm=[w.bbox for w in words] if words else None,
                    )
            except Exception as exc:
                logger.debug(
                    "ocr_extract_boundary_skipped page_id=%s err=%s",
                    page.Id,
                    type(exc).__name__,
                )
            handle.checkpoint("BOUNDARY_DETECT", raise_on_preempt=True)

        await svc.commit_stage_result(
            job_id=job.Id,
            lease_token=lease_token,
            stage="BOUNDARY_DETECT",
            mark_stage_completed=True,
            checkpoint_data={"boundary_detected": boundary is not None},
            progress_completed=1,
            progress_total=2,
            progress_unit="bước",
        )

        result = extract_ocr_content(
            words,
            page_number=max(1, int(page.PageNumber or 1)),
            book_title=book.Title,
            book_author=book.Author,
            cross_pages=cross_pages,
            boundary=boundary,
            filter_mode=filter_mode,  # type: ignore[arg-type]
            book_id=book.Id,
            book_page_id=page.Id,
            page_revision_id=revision.Id if revision is not None else None,
        )

    owner_id = book.OwnerParentId if is_book_private(book) else None
    existing_row, load_degraded = await repo.get_latest_extraction(page.Id)
    saved_row = None
    storage_degraded = load_degraded
    if not load_degraded:
        saved_row, storage_degraded = await repo.save_extraction(
            book_id=book.Id,
            page_id=page.Id,
            page_revision_id=revision.Id if revision is not None else None,
            owner_id=owner_id,
            extraction=result,
            source_words=list(words),
            undo_stack=[],
            existing_row=existing_row,
        )

    await svc.commit_stage_result(
        job_id=job.Id,
        lease_token=lease_token,
        stage="OCR_EXTRACT",
        checkpoint_data={
            "page_id": str(page.Id),
            "page_kind": result.page_kind,
            "filter_mode": result.filter_mode,
            "storage_degraded": storage_degraded,
        },
        next_status="SUCCEEDED",
        result_ref={
            "extraction_id": str(saved_row.Id) if saved_row is not None else None,
            "book_id": str(book.Id),
            "page_id": str(page.Id),
            "page_revision_id": str(revision.Id) if revision is not None else None,
            "page_kind": result.page_kind,
            "requires_review": bool(result.requires_review),
            "kept_blocks": result.stats.keep_blocks,
            "excluded_blocks": result.stats.exclude_blocks,
            "review_blocks": result.stats.review_blocks,
        },
        progress_completed=2,
        progress_total=2,
        progress_unit="bước",
    )


async def _execute_batch_book_import_job(
    db: AsyncSession,
    svc: GlobalTasksService,
    job: SmartStudioJob,
    lease_token: UUID,
    scheduler: GpuWorkloadScheduler,
    ai_router: AiCapabilityRouter,
) -> None:
    """Execute durable BATCH_BOOK_IMPORT job with per-page checkpoints & cooperative preemption."""
    if job.BookId is None:
        await svc.commit_stage_result(
            job_id=job.Id,
            lease_token=lease_token,
            stage="BATCH_BOOK_IMPORT",
            mark_stage_completed=False,
            next_status="FAILED",
            error_code="MISSING_BOOK_ID",
            error_message_vi="Tác vụ nhập hàng loạt thiếu mã sách.",
        )
        return

    from sqlalchemy import select as sa_select
    from app.models import BookPage
    from app.repositories.ocr_extraction_repository import OcrExtractionRepository
    from app.services.book_illustration_service import (
        BookIllustrationService,
        _build_default_ocr_check_fn,
    )
    from app.services.gpu_workload_scheduler import WorkloadPriority
    from app.services.ocr_content_extraction import extract_ocr_content
    from app.services.smart_studio_flags import SmartStudioFlags
    from app.schemas.book_assets import PageIllustrationExtractRequest

    book = await svc.repo.get_book(job.BookId)
    if book is None or bool(getattr(book, "IsDeleted", False)):
        await svc.commit_stage_result(
            job_id=job.Id,
            lease_token=lease_token,
            stage="BATCH_BOOK_IMPORT",
            mark_stage_completed=False,
            next_status="FAILED",
            error_code="BOOK_NOT_FOUND",
            error_message_vi="Không tìm thấy sách cho tác vụ nhập hàng loạt.",
        )
        return

    if job.ActorRole == "parent" and (
        not is_book_private(book) or book.OwnerParentId != job.ActorId
    ):
        await svc.commit_stage_result(
            job_id=job.Id,
            lease_token=lease_token,
            stage="BATCH_BOOK_IMPORT",
            mark_stage_completed=False,
            next_status="FAILED",
            error_code="ACCESS_DENIED",
            error_message_vi="Bạn không có quyền nhập hàng loạt cho cuốn sách này.",
        )
        return

    checkpoints = dict(job.CheckpointsJson or {}) if isinstance(job.CheckpointsJson, dict) else {}
    req_opts = checkpoints.get("request") if isinstance(checkpoints.get("request"), dict) else {}
    source_storage_path = (
        checkpoints.get("source_storage_path")
        or req_opts.get("source_storage_path")
    )

    # Mode 0: Remote-OCR batch import tracker (reflects real completion of enqueued OcrInferenceJob rows)
    if checkpoints.get("tracking_mode") == "remote_ocr_batch" and isinstance(checkpoints.get("ocr_job_ids"), list):
        ocr_job_uuids: list[UUID] = []
        for raw_id in checkpoints["ocr_job_ids"]:
            try:
                ocr_job_uuids.append(UUID(str(raw_id)))
            except (ValueError, TypeError):
                continue
        tracked_rows = await svc.repo.list_ocr_inference_jobs_by_ids(ocr_job_uuids)
        total_tracked = max(1, len(ocr_job_uuids))
        succeeded_n = sum(1 for r in tracked_rows if str(r.Status or "").upper() == "SUCCEEDED")
        failed_n = sum(
            1 for r in tracked_rows if str(r.Status or "").upper() in ("DEAD_LETTER", "FAILED", "CANCELLED")
        )
        done_n = min(total_tracked, succeeded_n + failed_n)
        if done_n >= total_tracked:
            final_st: GlobalTaskStatus = (
                "SUCCEEDED"
                if succeeded_n == total_tracked
                else ("PARTIAL_SUCCESS" if succeeded_n > 0 else "FAILED")
            )
            await svc.commit_stage_result(
                job_id=job.Id,
                lease_token=lease_token,
                stage="COMPLETED" if final_st != "FAILED" else "FAILED",
                mark_stage_completed=(final_st != "FAILED"),
                next_status=final_st,
                result_ref={
                    "book_id": str(book.Id),
                    "succeeded_pages": succeeded_n,
                    "failed_pages": failed_n,
                    "total_pages": total_tracked,
                },
                progress_completed=done_n,
                progress_total=total_tracked,
                progress_unit="trang",
            )
        else:
            worker_online = await svc.repo.is_remote_ocr_worker_online(
                ttl_seconds=worker_heartbeat_ttl_seconds()
            )
            await svc.commit_stage_result(
                job_id=job.Id,
                lease_token=lease_token,
                stage="OCR",
                mark_stage_completed=False,
                next_status=("WAITING_FOR_WORKER" if worker_online is False else "RETRY_SCHEDULED"),
                progress_completed=done_n,
                progress_total=total_tracked,
                progress_unit="trang",
            )
        return

    # Mode A: Stored multi-page PDF/DOCX rasterization & page ingestion
    if isinstance(source_storage_path, str) and source_storage_path.strip() and job.ActorRole == "admin":
        from tempfile import SpooledTemporaryFile
        from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET, SUPABASE_STORAGE_BUCKET
        from app.services.admin_ocr_service import AdminOcrService
        from app.services.document_rasterizer_service import (
            SpooledUploadDocument,
            iter_rasterized_spooled_document,
        )
        from app.services.storage_service import download_object

        bucket = (
            SUPABASE_PRIVATE_BOOKS_BUCKET
            if is_book_private(book)
            else (SUPABASE_STORAGE_BUCKET or "books")
        )
        doc_bytes = download_object(source_storage_path.strip(), bucket_name=bucket)
        file_name = str(
            checkpoints.get("file_name")
            or req_opts.get("file_name")
            or source_storage_path.rsplit("/", 1)[-1]
        )
        spool_file = SpooledTemporaryFile(max_size=2 * 1024 * 1024, mode="w+b")
        spool_file.write(doc_bytes)
        spool_file.seek(0)
        spooled = SpooledUploadDocument(
            file_name=file_name,
            content_type=str(checkpoints.get("content_type") or "application/pdf"),
            size_bytes=len(doc_bytes),
            file_obj=spool_file,
        )
        completed_source_pages = {
            int(p)
            for p in (checkpoints.get("completed_source_pages") or [])
            if isinstance(p, int) or (isinstance(p, str) and p.isdigit())
        }
        created_page_ids: list[str] = list(checkpoints.get("created_page_ids") or [])
        failed_source_pages: list[int] = list(checkpoints.get("failed_source_pages") or [])
        total_source_pages = int(checkpoints.get("total_source_pages") or 0)
        admin_ocr = AdminOcrService(db)
        started_perf = time.perf_counter()

        try:
            async with scheduler.acquire(
                priority=WorkloadPriority.BATCH_MAINTENANCE,
                workload_id=f"batch-import:{job.Id}",
                estimated_vram_mb=1500,
            ) as handle:
                with iter_rasterized_spooled_document(spooled) as (
                    _fname,
                    _fmt,
                    _sha,
                    page_iter,
                ):
                    rasterized = list(page_iter)
                    total_source_pages = max(total_source_pages, len(rasterized))
                    for item in rasterized:
                        if item.source_page in completed_source_pages:
                            continue
                        handle.checkpoint(
                            f"source_page_{item.source_page}", raise_on_preempt=True
                        )
                        try:
                            _page_num, rev = await admin_ocr._ingest_validated_page_image(
                                job.ActorId,
                                book.Id,
                                data=item.image_bytes,
                                content_type=item.content_type,
                                extension=item.extension,
                                width=item.width,
                                height=item.height,
                                upload_id=None,
                                started_at=started_perf,
                            )
                            completed_source_pages.add(item.source_page)
                            created_page_ids.append(str(rev.page_id))
                        except Exception as exc:
                            logger.warning(
                                "batch_import_document_page_failed job_id=%s source_page=%s err=%s",
                                job.Id,
                                item.source_page,
                                type(exc).__name__,
                            )
                            failed_source_pages.append(item.source_page)
                        done_count = len(completed_source_pages) + len(failed_source_pages)
                        await svc.commit_stage_result(
                            job_id=job.Id,
                            lease_token=lease_token,
                            stage="BATCH_BOOK_IMPORT",
                            mark_stage_completed=False,
                            checkpoint_data={
                                "completed_source_pages": sorted(completed_source_pages),
                                "created_page_ids": created_page_ids,
                                "failed_source_pages": failed_source_pages,
                                "total_source_pages": total_source_pages,
                            },
                            progress_completed=done_count,
                            progress_total=max(1, total_source_pages),
                            progress_unit="trang",
                        )
        finally:
            spooled.close()

        final_status: GlobalTaskStatus
        if created_page_ids and not failed_source_pages:
            final_status = "SUCCEEDED"
        elif created_page_ids and failed_source_pages:
            final_status = "PARTIAL_SUCCESS"
        else:
            final_status = "FAILED"
        await svc.commit_stage_result(
            job_id=job.Id,
            lease_token=lease_token,
            stage="BATCH_BOOK_IMPORT",
            mark_stage_completed=(final_status != "FAILED"),
            next_status=final_status,
            result_ref={
                "book_id": str(book.Id),
                "created_page_ids": created_page_ids,
                "failed_source_pages": failed_source_pages,
                "total_source_pages": total_source_pages,
            },
            progress_completed=len(completed_source_pages) + len(failed_source_pages),
            progress_total=max(1, total_source_pages),
            progress_unit="trang",
            error_code="BATCH_PARTIAL_OR_FAILED" if final_status != "SUCCEEDED" else None,
            error_message_vi=(
                "Một số trang không thể nhập thành công; bạn có thể thử lại."
                if final_status != "SUCCEEDED"
                else None
            ),
        )
        return

    # Mode B: Batch OCR content extraction (and optional illustration extraction) across book pages
    requested_page_ids_raw = checkpoints.get("page_ids") or req_opts.get("page_ids") or []
    requested_page_ids: list[UUID] = []
    for raw_pid in requested_page_ids_raw:
        try:
            requested_page_ids.append(UUID(str(raw_pid)))
        except (ValueError, TypeError):
            continue

    page_query = sa_select(BookPage).where(BookPage.BookId == book.Id)
    if requested_page_ids:
        page_query = page_query.where(BookPage.Id.in_(requested_page_ids))
    page_query = page_query.order_by(BookPage.PageNumber.asc())
    pages = list((await db.scalars(page_query)).all())
    pages = [p for p in pages if str(getattr(p, "LifecycleStatus", "ACTIVE")).upper() != "RETIRED"]

    if not pages:
        await svc.commit_stage_result(
            job_id=job.Id,
            lease_token=lease_token,
            stage="BATCH_BOOK_IMPORT",
            mark_stage_completed=False,
            next_status="FAILED",
            error_code="NO_PAGES_TO_IMPORT",
            error_message_vi="Sách chưa có trang nào để xử lý hàng loạt.",
        )
        return

    raw_mode = str(req_opts.get("filter_mode") or SmartStudioFlags.from_environment().ocr_filter_mode).strip().lower()
    filter_mode = raw_mode if raw_mode in ("off", "shadow", "active") else "active"
    extract_illustrations = bool(
        checkpoints.get("extract_illustrations") or req_opts.get("extract_illustrations")
    )

    stage_outputs = checkpoints.get("stage_outputs") if isinstance(checkpoints.get("stage_outputs"), dict) else {}
    prev_batch_state = stage_outputs.get("BATCH_BOOK_IMPORT") if isinstance(stage_outputs.get("BATCH_BOOK_IMPORT"), dict) else {}
    completed_page_ids: list[str] = list(
        prev_batch_state.get("completed_page_ids")
        or checkpoints.get("completed_page_ids")
        or []
    )
    completed_set = set(completed_page_ids)
    failed_page_ids: list[str] = list(prev_batch_state.get("failed_page_ids") or [])
    extraction_ids: dict[str, str] = dict(prev_batch_state.get("extraction_ids") or {})

    ocr_repo = OcrExtractionRepository(db)
    total_pages = len(pages)
    owner_id = book.OwnerParentId if is_book_private(book) else None

    async with scheduler.acquire(
        priority=WorkloadPriority.BATCH_MAINTENANCE,
        workload_id=f"batch-import:{job.Id}",
        estimated_vram_mb=1500,
    ) as handle:
        for page in pages:
            pid_str = str(page.Id)
            if pid_str in completed_set:
                continue
            handle.checkpoint(f"page:{pid_str}", raise_on_preempt=True)
            try:
                revision = await ocr_repo.resolve_revision_for_page(page)
                words = await ocr_repo.load_revision_words(revision.Id) if revision is not None else []
                cross_pages = await ocr_repo.load_sibling_cross_pages(book.Id, page.Id)
                extracted = extract_ocr_content(
                    words,
                    page_number=max(1, int(page.PageNumber or 1)),
                    book_title=book.Title,
                    book_author=book.Author,
                    cross_pages=cross_pages,
                    filter_mode=filter_mode,  # type: ignore[arg-type]
                    book_id=book.Id,
                    book_page_id=page.Id,
                    page_revision_id=revision.Id if revision is not None else None,
                )
                existing_row, load_degraded = await ocr_repo.get_latest_extraction(page.Id)
                if not load_degraded:
                    saved_row, _ = await ocr_repo.save_extraction(
                        book_id=book.Id,
                        page_id=page.Id,
                        page_revision_id=revision.Id if revision is not None else None,
                        owner_id=owner_id,
                        extraction=extracted,
                        source_words=list(words),
                        undo_stack=[],
                        existing_row=existing_row,
                    )
                    if saved_row is not None:
                        extraction_ids[pid_str] = str(saved_row.Id)

                if extract_illustrations:
                    try:
                        ill_svc = BookIllustrationService(
                            db,
                            ocr_check_fn=_build_default_ocr_check_fn(),
                            ai_router=ai_router,
                            gpu_scheduler=scheduler,
                        )
                        await ill_svc.extract_page_illustration(
                            job.ActorId,
                            book.Id,
                            page.Id,
                            PageIllustrationExtractRequest(),
                        )
                    except Exception as ill_exc:
                        logger.debug(
                            "batch_import_illustration_skipped page_id=%s err=%s",
                            page.Id,
                            type(ill_exc).__name__,
                        )

                completed_page_ids.append(pid_str)
                completed_set.add(pid_str)
            except Exception as exc:
                logger.warning(
                    "batch_import_page_failed job_id=%s page_id=%s err=%s",
                    job.Id,
                    page.Id,
                    type(exc).__name__,
                )
                if pid_str not in failed_page_ids:
                    failed_page_ids.append(pid_str)

            processed_count = min(total_pages, len(completed_set) + len(failed_page_ids))
            await svc.commit_stage_result(
                job_id=job.Id,
                lease_token=lease_token,
                stage="BATCH_BOOK_IMPORT",
                mark_stage_completed=False,
                checkpoint_data={
                    "completed_page_ids": completed_page_ids,
                    "failed_page_ids": failed_page_ids,
                    "extraction_ids": extraction_ids,
                },
                progress_completed=processed_count,
                progress_total=total_pages,
                progress_unit="trang",
            )

    if completed_page_ids and not failed_page_ids:
        final_status = "SUCCEEDED"
    elif completed_page_ids and failed_page_ids:
        final_status = "PARTIAL_SUCCESS"
    else:
        final_status = "FAILED"

    await svc.commit_stage_result(
        job_id=job.Id,
        lease_token=lease_token,
        stage="BATCH_BOOK_IMPORT",
        mark_stage_completed=(final_status != "FAILED"),
        checkpoint_data={
            "completed_page_ids": completed_page_ids,
            "failed_page_ids": failed_page_ids,
            "extraction_ids": extraction_ids,
        },
        next_status=final_status,
        result_ref={
            "book_id": str(book.Id),
            "processed_pages": len(completed_page_ids),
            "failed_pages": len(failed_page_ids),
            "total_pages": total_pages,
            "extraction_ids": extraction_ids,
        },
        progress_completed=min(total_pages, len(completed_set) + len(failed_page_ids)),
        progress_total=total_pages,
        progress_unit="trang",
        error_code="BATCH_PARTIAL_FAILURE" if final_status != "SUCCEEDED" else None,
        error_message_vi=(
            f"Đã xử lý {len(completed_page_ids)}/{total_pages} trang; có {len(failed_page_ids)} trang lỗi."
            if final_status != "SUCCEEDED"
            else None
        ),
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
    ai_router: AiCapabilityRouter | None = None,
    gpu_scheduler: GpuWorkloadScheduler | None = None,
) -> bool:
    """Claim and execute at most one durable `SmartStudioJob` with lease, revision & GPU fencing."""
    from app.services.gpu_workload_scheduler import PreemptionRequested, WorkloadPriority

    router = ai_router or get_default_ai_router()
    scheduler = gpu_scheduler or get_default_gpu_scheduler()
    svc = GlobalTasksService(db, ai_router=router, gpu_scheduler=scheduler)
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

    # Never mis-execute mirrored in-process legacy /ai-correct/jobs rows!
    if checkpoints.get("mirror_source") == "admin_ocr_ai_correct":
        await svc.commit_stage_result(
            job_id=job_id,
            lease_token=lease_token,
            stage="PROOFREADING",
            mark_stage_completed=False,
            next_status="FAILED",
            error_code="SERVER_RESTART_INTERRUPTED",
            error_message_vi="Tác vụ soát lỗi AI đã bị gián đoạn khi máy chủ khởi động lại.",
        )
        return True

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

            await svc.commit_stage_result(
                job_id=job_id,
                lease_token=lease_token,
                stage="STYLE_BIBLE",
                mark_stage_completed=False,
                progress_completed=1,
                progress_total=2,
                progress_unit="bước",
            )
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
                progress_completed=2,
                progress_total=2,
                progress_unit="bước",
            )
            return True

        if job_type in ("COVER_GENERATE", "BOOK_COVER_AI") and job_book_id is not None:
            from app.schemas.book_assets import BookCoverGenerateRequest
            from app.services.book_cover_service import BookCoverService
            from app.services.book_illustration_service import _build_default_ocr_check_fn

            req_opts = checkpoints.get("request") if isinstance(checkpoints.get("request"), dict) else {}
            raw_hint = req_opts.get("prompt_hint") if "prompt_hint" in req_opts else checkpoints.get("prompt_hint")
            force_regen = bool(
                req_opts.get("force_regenerate")
                if "force_regenerate" in req_opts
                else checkpoints.get("force_regenerate", False)
            )
            res = await BookCoverService(
                db,
                ai_router=router,
                gpu_scheduler=scheduler,
                ocr_check_fn=_build_default_ocr_check_fn(),
            ).execute_ai_cover_job(
                job_actor_id,
                job_book_id,
                BookCoverGenerateRequest(
                    force_regenerate=force_regen,
                    prompt_hint=str(raw_hint) if isinstance(raw_hint, str) and raw_hint.strip() else None,
                    idempotency_key=f"worker:{job_id}:{attempt_count}",
                ),
                existing_job_id=job_id,
                existing_lease_token=lease_token,
                managed_by_worker=True,
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
                        progress_completed=4,
                        progress_total=4,
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
            from app.services.book_illustration_service import (
                BookIllustrationService,
                _build_default_ocr_check_fn,
            )

            async with scheduler.acquire(
                priority=WorkloadPriority.PREPROCESSING,
                workload_id=f"illust-extract:{job_id}",
                estimated_vram_mb=512,
            ):
                res = await BookIllustrationService(
                    db,
                    ocr_check_fn=_build_default_ocr_check_fn(),
                    ai_router=router,
                    gpu_scheduler=scheduler,
                ).extract_page_illustration(
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
                        progress_completed=3,
                        progress_total=3,
                        progress_unit="bước",
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
            from app.services.book_illustration_service import (
                BookIllustrationService,
                _build_default_ocr_check_fn,
            )

            req_opts = checkpoints.get("request") if isinstance(checkpoints.get("request"), dict) else {}
            raw_hint = req_opts.get("prompt_hint") if "prompt_hint" in req_opts else checkpoints.get("prompt_hint")
            res = await BookIllustrationService(
                db,
                ocr_check_fn=_build_default_ocr_check_fn(),
                ai_router=router,
                gpu_scheduler=scheduler,
            ).execute_ai_illustration_job(
                job_actor_id,
                job_book_id,
                job_page_id,
                PageIllustrationGenerateRequest(
                    prompt_hint=str(raw_hint) if isinstance(raw_hint, str) and raw_hint.strip() else None,
                    idempotency_key=f"worker:{job_id}:{attempt_count}",
                ),
                existing_job_id=job_id,
                existing_lease_token=lease_token,
                existing_source_revision_id=source_revision_id,
                managed_by_worker=True,
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
                        progress_completed=4,
                        progress_total=4,
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

        if job_type == "OCR_EXTRACT":
            await _execute_ocr_extract_job(db, svc, job, lease_token, scheduler)
            return True

        if job_type == "BATCH_BOOK_IMPORT":
            await _execute_batch_book_import_job(
                db, svc, job, lease_token, scheduler, router
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
    except PreemptionRequested as exc:
        logger.info(
            "smart_studio_job_preempted job_id=%s stage=%s waiting_prio=%s",
            job.Id,
            exc.stage,
            exc.waiting_priority,
        )
        try:
            await svc.commit_stage_result(
                job_id=job.Id,
                lease_token=lease_token,
                stage=str(job.Stage or exc.stage),
                mark_stage_completed=False,
                next_status="RETRY_SCHEDULED",
                error_code="GPU_PREEMPTED_HIGHER_PRIORITY",
                error_message_vi="Tác vụ tạm nhường GPU cho phiên đọc/OCR ưu tiên cao và sẽ tự tiếp tục.",
            )
        except Exception:
            logger.debug("smart_studio_preempt_requeue_skipped", exc_info=True)
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
