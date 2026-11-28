"""Business services for Parent Private Books ("Sách của tôi") and Admin User-Books moderation."""
from __future__ import annotations

import asyncio
import gc
import hashlib
import inspect
import logging
import math
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.diagnostic_logging import log_diagnostic
from app.models import (
    Book,
    BookPage,
    PageRevision,
    PageRevisionWord,
    ParentBookModerationRequest,
    ParentBookPageSubmission,
)
from app.policies.book_access import (
    MODERATION_ACTIVE,
    MODERATION_SUSPENDED,
    VISIBILITY_PARENT_PRIVATE,
    admin_submission_image_url,
    admin_submission_image_url_async,
    is_private_book_readable_by,
    private_page_image_url,
    private_page_image_urls_async,
    private_submission_image_url,
    private_submission_image_urls_async,
)
from app.repositories.parent_private_book_repository import ParentPrivateBookRepository
from app.services.tts_audio_cache_service import invalidate_tts_cache_best_effort
from app.schemas.parent_private_book import (
    SOURCE_TYPE_LABELS,
    WORKFLOW_STATUS_LABELS,
    AdminModerationHistoryItemRead,
    AdminSuspendPrivateBookRequest,
    AdminUserBookDecisionRequest,
    AdminUserBookDecisionResponse,
    AdminUserBookQueueFilter,
    AdminUserBookQueueItemRead,
    AdminUserBookQueuePageRead,
    AdminUserBookSubmissionDetailRead,
    ParentAcceptSpellingRequest,
    ParentAddPageRequest,
    ParentAddPageResponse,
    ParentDeletePrivateBookResponse,
    ParentDeletePrivatePageResponse,
    ParentPageSubmissionRead,
    ParentPrivateBookCreate,
    ParentPrivateBookDetailRead,
    ParentPrivateBookPageRead,
    ParentPrivateBookSummaryRead,
    ParentPrivateBookUpdate,
    ParentPrivatePageEditRequest,
    ParentPrivatePageRead,
    ParentRequestAdminReviewRequest,
    ParentRetrySubmissionRequest,
    ParentSubmissionEditRequest,
    ParentSubmitPagesResponse,
    ProofreadSuggestionRead,
    ProviderEventSummaryRead,
    ToolCheckFindingRead,
    ToolCheckScopeRead,
)
from app.services.document_rasterizer_service import (
    MAX_DOCUMENT_BYTES,
    RasterizedDocumentPage,
    iter_rasterized_spooled_document,
    spool_upload_file,
)
from app.services.ocr_ai.child_safety import content_hash as safety_content_hash
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_inference_job_service import (
    JOB_KIND_PARENT_SUBMISSION,
    PRIORITY_PARENT_SUBMISSION,
    OcrInferenceJobService,
    align_edited_text_to_words,
    compute_candidate_hash,
    is_remote_ocr_mode,
    normalize_word,
    schedule_parent_submission_post_ocr,
)
from app.services.parent_flow2_contribution_service import ParentFlow2ContributionService
from app.services.storage_service import delete_object, download_object, upload_object

logger = logging.getLogger(__name__)

STAGING_TTL_DAYS = 7
ADMIN_REVIEW_TTL_DAYS = 30
VALID_SOURCE_TYPES = set(SOURCE_TYPE_LABELS.keys())

_ORIGINAL_PRIVATE_PAGE_IMAGE_URL = private_page_image_url
_ORIGINAL_PRIVATE_SUBMISSION_IMAGE_URL = private_submission_image_url
_ORIGINAL_ADMIN_SUBMISSION_IMAGE_URL = admin_submission_image_url


def _safe_media_type(path: str) -> str:
    lower = (path or "").lower()
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        return "image/jpeg"
    if lower.endswith(".webp"):
        return "image/webp"
    return "image/png"


def _ext_from_path(path: str) -> str:
    lower = (path or "").lower()
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        return "jpg"
    if lower.endswith(".webp"):
        return "webp"
    return "png"


def _coerce_word_bounding_box(item: dict[str, Any], idx: int, total: int) -> list[float]:
    """Coerce word bbox from canonical list or legacy {x, y, w, h} dict into a bounded [x, y, w, h] list."""
    raw: object = None
    for key in ("bounding_box", "bbox", "BoundingBox"):
        cand = item.get(key)
        if cand is not None:
            raw = cand
            break
    raw_vals: list[object] | None = None
    if isinstance(raw, (list, tuple)) and len(raw) == 4:
        raw_vals = list(raw)
    elif isinstance(raw, dict) and "x" in raw and "y" in raw:
        raw_vals = [
            raw["x"],
            raw["y"],
            raw.get("w", raw.get("width", 0.0)),
            raw.get("h", raw.get("height", 0.0)),
        ]
    vals: list[float] | None = None
    if raw_vals is not None and not any(isinstance(v, bool) for v in raw_vals):
        try:
            vals = [float(v) for v in raw_vals]
        except (TypeError, ValueError):
            vals = None
    if vals is not None:
        x, y, w, h = vals
        if (
            all(math.isfinite(v) for v in vals)
            and 0.0 <= x < 1.0
            and 0.0 <= y < 1.0
            and w > 0.0
            and h > 0.0
        ):
            rx = round(x, 6)
            ry = round(y, 6)
            rw = round(min(w, 1.0 - rx), 6)
            rh = round(min(h, 1.0 - ry), 6)
            if rx < 1.0 and ry < 1.0 and rw > 0.0 and rh > 0.0:
                return [rx, ry, rw, rh]
    count = max(1, total)
    cols = min(8, count)
    col = idx % cols
    row = idx // cols
    rows = max(1, (count + cols - 1) // cols)
    x = min(0.92, 0.05 + col * (0.86 / cols))
    y = min(0.92, 0.06 + row * min(0.08, 0.84 / rows))
    w = min(0.84 / cols, 1.0 - x)
    h = min(0.06, 1.0 - y)
    return [round(x, 6), round(y, 6), round(max(0.015, w), 6), round(max(0.015, h), 6)]


def _parse_source_declaration(raw: str | None) -> tuple[str, str | None]:
    cleaned = (raw or "").strip()
    if not cleaned:
        return "OWNED_PHYSICAL_BOOK", None
    if cleaned.startswith("[") and "]" in cleaned:
        tag, rest = cleaned[1:].split("]", 1)
        tag = tag.strip()
        if tag in VALID_SOURCE_TYPES:
            return tag, (rest.strip() or None)
    return "OWNED_PHYSICAL_BOOK", cleaned


def _format_source_declaration(source_type: str, source_note: str | None) -> str:
    note = (source_note or "").strip()
    declaration = f"[{source_type}] {note}" if note else f"[{source_type}]"
    return declaration[:1000]


def _reset_submission_for_full_recheck(
    sub: ParentBookPageSubmission,
    *,
    now: datetime,
    reset_ocr: bool,
    auto_recheck: bool = True,
) -> None:
    """Reset check stages & invalidate any prior approval/commit so the submission re-runs cleanly."""
    sub.SubmissionVersion = int(sub.SubmissionVersion) + 1
    sub.OptimisticLockVersion = int(sub.OptimisticLockVersion) + 1
    sub.CommittedPageId = None
    sub.CommittedRevisionId = None
    sub.CommittedAt = None

    if reset_ocr:
        sub.OcrStatus = "PENDING"
        sub.OcrText = None
        sub.OcrWordsJson = []
        sub.OcrMetaJson = {}
        sub.OcrHash = None
        sub.OcrErrorCode = None
        sub.IsImageOnly = False
        sub.CandidateText = None
        sub.CandidateHash = None
        sub.CandidateWordsJson = []

    # Always reset Stage 2 (Proofreading / Spelling)
    sub.ProofreadStatus = "PENDING"
    sub.ProofreadText = None
    sub.ProofreadHash = None
    sub.ProofreadSuggestionsJson = []
    sub.UncertainWordIndicesJson = []
    sub.ProofreadProviderEventsJson = []
    sub.ProofreadErrorCode = None
    sub.SpellingAcceptedAt = None

    # Always reset Stage 3 (Tool Check / Child Safety / Rules)
    sub.ToolCheckStatus = "PENDING"
    sub.ToolCheckInputHash = None
    sub.ToolCheckSuitability = None
    sub.ToolCheckScopeJson = {}
    sub.ToolCheckFindingsJson = []
    sub.ToolCheckProviderEventsJson = []
    sub.ToolCheckErrorCode = None
    sub.ToolCheckPolicyBlocked = False
    sub.ToolCheckWorkflowId = None
    sub.ToolCheckCompletedAt = None

    # Always invalidate prior Admin approvals
    sub.ApprovedSnapshotHash = None
    sub.ApprovedSubmissionVersion = None
    sub.ApprovedBy = None
    sub.ApprovedAt = None
    sub.AdminDecision = None
    sub.AdminDecisionReason = None

    # Release any worker lease & enqueue for full recheck
    sub.WorkerId = None
    sub.LeaseExpiresAt = None
    sub.RetryAfter = None
    sub.WorkflowStatus = "CHECKING" if auto_recheck else "NEEDS_RECHECK"
    sub.TempExpiresAt = now + timedelta(days=STAGING_TTL_DAYS)
    sub.UpdatedAt = now


def _parent_safe_notice(sub: ParentBookPageSubmission) -> str | None:
    """Return a parent-appropriate explanation without exposing sensitive raw excerpts to children."""
    status_val = sub.WorkflowStatus
    if status_val == "CHECKING":
        return "Hệ thống đang nhận diện chữ, rà chính tả và kiểm tra an toàn nội dung cho trang này."
    if status_val == "PASSED_READY_TO_ADD":
        if sub.ProofreadSuggestionsJson and sub.SpellingAcceptedAt is None:
            return "Kiểm tra an toàn nội dung đã đạt. Hãy xem và chấp nhận đề xuất chính tả trước khi thêm trang vào sách."
        return "Trang đã đạt toàn bộ kiểm tra nhận diện chữ, chính tả và an toàn nội dung. Bạn có thể thêm vào sách."
    if status_val == "NEEDS_ADMIN_REVIEW":
        if sub.IsImageOnly:
            return "Trang không phát hiện chữ hoặc chỉ có hình ảnh. Hệ thống kiểm tra an toàn nội dung chỉ kiểm tra văn bản nên trang này cần Admin xem xét trực tiếp."
        if sub.ToolCheckPolicyBlocked:
            return "Trang này có nội dung bị chính sách an toàn cho trẻ gắn cờ mức nghiêm trọng. Bạn cần chỉnh sửa nội dung hoặc gửi Admin xem xét."
        return "Trang này cần Admin xem xét trước khi có thể thêm vào sách riêng."
    if status_val == "CHECK_FAILED":
        return "Quá trình kiểm tra gặp sự cố kỹ thuật. Kết quả các bước đã hoàn tất vẫn được giữ; bạn có thể bấm thử lại."
    if status_val == "PENDING_ADMIN":
        return "Yêu cầu đã được gửi tới Admin. Trang sẽ được mở khóa thêm vào sách sau khi Admin phê duyệt đúng phiên bản này."
    if status_val == "APPROVED_READY_TO_ADD":
        return "Admin đã phê duyệt đúng phiên bản trang này. Bạn có thể thêm trang vào sách ngay."
    if status_val == "REJECTED":
        return "Admin đã từ chối phiên bản trang này. Hãy xem lý do, chỉnh sửa hoặc tải bản mới để kiểm tra lại."
    if status_val == "NEEDS_RECHECK":
        if sub.AdminDecision == "REQUEST_CHANGES":
            return "Admin yêu cầu chỉnh sửa trang này. Sau khi sửa nội dung hoặc tải ảnh mới, trang cần chạy kiểm tra lại."
        return "Nội dung hoặc ảnh đã thay đổi nên kết quả kiểm tra và phê duyệt cũ không còn hiệu lực. Cần kiểm tra lại."
    if status_val == "ADDED_TO_BOOK":
        return "Trang đã được thêm vào sách riêng."
    return None


def _default_local_ai_enforced() -> bool:
    try:
        from app.services.ocr_ai.config import OcrCorrectionConfig

        return not OcrCorrectionConfig.private_book_allow_cloud_ai()
    except Exception:
        return True


def _build_scope(raw: dict[str, Any] | None) -> ToolCheckScopeRead:
    data = raw if isinstance(raw, dict) else {}
    default_local_ai_enforced = not OcrCorrectionConfig.private_book_allow_cloud_ai()
    local_enforced = (
        bool(data["local_ai_enforced"])
        if "local_ai_enforced" in data and data["local_ai_enforced"] is not None
        else default_local_ai_enforced
    )
    return ToolCheckScopeRead(
        modality=str(data.get("modality") or "TEXT_ONLY_WITH_OCR_IMAGE_PROOFREAD"),
        covers_all_chunks=bool(data.get("covers_all_chunks", False)),
        chunks_checked=int(data.get("chunks_checked") or 0),
        total_chunks=int(data.get("total_chunks") or 0),
        image_visual_safety_checked=bool(data.get("image_visual_safety_checked", False)),
        requires_admin_visual_review=bool(data.get("requires_admin_visual_review", False)),
        copyright_scanner_status=str(data.get("copyright_scanner_status") or "NOT_CONFIGURED"),
        local_ai_enforced=local_enforced,
    )


def _build_suggestions(raw: list[Any] | None) -> list[ProofreadSuggestionRead]:
    items: list[ProofreadSuggestionRead] = []
    for entry in raw or []:
        if not isinstance(entry, dict):
            continue
        try:
            items.append(ProofreadSuggestionRead.model_validate(entry))
        except Exception:
            continue
    return items


def _build_provider_events(sub: ParentBookPageSubmission) -> list[ProviderEventSummaryRead]:
    combined: list[ProviderEventSummaryRead] = []
    for source in (sub.ProofreadProviderEventsJson or [], sub.ToolCheckProviderEventsJson or []):
        for entry in source:
            if not isinstance(entry, dict):
                continue
            try:
                combined.append(ProviderEventSummaryRead.model_validate(entry))
            except Exception:
                continue
    return combined


def _can_add_submission(book: Book, sub: ParentBookPageSubmission) -> bool:
    if book.LifecycleStatus != "ACTIVE" or book.ModerationStatus != MODERATION_ACTIVE:
        return False
    if sub.ToolCheckPolicyBlocked:
        return False
    if not sub.CandidateHash:
        return False
    if sub.WorkflowStatus == "PASSED_READY_TO_ADD":
        return (
            sub.OcrStatus == "COMPLETED"
            and sub.ProofreadStatus == "COMPLETED"
            and sub.ToolCheckStatus == "PASSED"
            and sub.ToolCheckInputHash == sub.CandidateHash
            and sub.ToolCheckSuitability == "SUITABLE"
            and len(sub.ToolCheckFindingsJson or []) == 0
            and not sub.IsImageOnly
            and bool((sub.CandidateText or "").strip())
            and (
                not (sub.ProofreadSuggestionsJson or [])
                or sub.SpellingAcceptedAt is not None
            )
        )
    if sub.WorkflowStatus == "APPROVED_READY_TO_ADD":
        return (
            sub.ApprovedBy is not None
            and sub.ApprovedAt is not None
            and sub.AdminDecision == "APPROVE"
            and sub.ApprovedSnapshotHash == sub.CandidateHash
            and sub.ApprovedSubmissionVersion == sub.SubmissionVersion
        )
    return False


class ParentPrivateBookService:
    """Service layer for Parent Private Books & Admin User-Books moderation."""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = ParentPrivateBookRepository(db)

    async def _require_parent(self, actor_id: UUID) -> None:
        if await self.repo.role(actor_id) != "parent":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    async def _require_admin(self, actor_id: UUID) -> None:
        if await self.repo.role(actor_id) != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    def _serialize_submission(
        self,
        book: Book,
        sub: ParentBookPageSubmission,
        *,
        base_url: str | None = None,
        prebuilt_image_url: str | None = None,
    ) -> ParentPageSubmissionRead:
        can_add = _can_add_submission(book, sub)
        can_req = (
            book.LifecycleStatus == "ACTIVE"
            and book.ModerationStatus == MODERATION_ACTIVE
            and sub.WorkflowStatus == "NEEDS_ADMIN_REVIEW"
            and bool(sub.CandidateHash)
        )
        can_retry = (
            book.LifecycleStatus == "ACTIVE"
            and book.ModerationStatus == MODERATION_ACTIVE
            and sub.WorkflowStatus in ("CHECK_FAILED", "NEEDS_RECHECK")
        )
        resolved_image_url = (
            prebuilt_image_url
            if prebuilt_image_url is not None
            else private_submission_image_url(
                sub.BookId,
                sub.Id,
                base_url=base_url,
                storage_path=sub.SourceStoragePath,
                owner_id=sub.OwnerParentId,
            )
        )
        from app.services.ai_task_progress import compute_parent_submission_progress

        _stages_done, _total_stages, progress_pct, _progress_mode = compute_parent_submission_progress(
            workflow_status=sub.WorkflowStatus,
            ocr_status=sub.OcrStatus,
            proofread_status=sub.ProofreadStatus,
            tool_check_status=sub.ToolCheckStatus,
            is_image_only=bool(sub.IsImageOnly),
        )
        return ParentPageSubmissionRead(
            id=sub.Id,
            book_id=sub.BookId,
            batch_id=sub.BatchId,
            batch_total_pages=int(sub.BatchTotalPages),
            source_page_number=int(sub.SourcePageNumber),
            target_page_number=sub.TargetPageNumber,
            source_file_name=sub.SourceFileName,
            source_format=sub.SourceFormat,
            image_width=int(sub.ImageWidth),
            image_height=int(sub.ImageHeight),
            image_url=resolved_image_url,
            source_type=sub.SourceType,  # type: ignore[arg-type]
            source_type_label=SOURCE_TYPE_LABELS.get(sub.SourceType, sub.SourceType),
            source_note=sub.SourceNote,
            submission_version=int(sub.SubmissionVersion),
            optimistic_lock_version=int(sub.OptimisticLockVersion),
            workflow_status=sub.WorkflowStatus,  # type: ignore[arg-type]
            workflow_status_label=WORKFLOW_STATUS_LABELS.get(sub.WorkflowStatus, sub.WorkflowStatus),
            progress_pct=progress_pct,
            ocr_status=sub.OcrStatus,
            ocr_text=sub.OcrText,
            ocr_error_code=sub.OcrErrorCode,
            is_image_only=bool(sub.IsImageOnly),
            proofread_status=sub.ProofreadStatus,
            proofread_text=sub.ProofreadText,
            proofread_suggestions=_build_suggestions(sub.ProofreadSuggestionsJson),
            uncertain_word_indices=[int(i) for i in (sub.UncertainWordIndicesJson or []) if isinstance(i, int)],
            proofread_error_code=sub.ProofreadErrorCode,
            spelling_accepted=sub.SpellingAcceptedAt is not None,
            candidate_text=sub.CandidateText,
            candidate_hash=sub.CandidateHash,
            tool_check_status=sub.ToolCheckStatus,
            tool_check_suitability=sub.ToolCheckSuitability,
            tool_check_scope=_build_scope(sub.ToolCheckScopeJson),
            tool_check_findings_count=len(sub.ToolCheckFindingsJson or []),
            tool_check_parent_notice=_parent_safe_notice(sub),
            tool_check_policy_blocked=bool(sub.ToolCheckPolicyBlocked),
            tool_check_workflow_id=sub.ToolCheckWorkflowId,
            tool_check_error_code=sub.ToolCheckErrorCode,
            provider_events=_build_provider_events(sub),
            can_add_to_book=can_add,
            can_request_admin_review=can_req,
            can_retry=can_retry,
            admin_decision=sub.AdminDecision,
            admin_decision_reason=sub.AdminDecisionReason,
            approved_snapshot_hash=sub.ApprovedSnapshotHash,
            approved_submission_version=sub.ApprovedSubmissionVersion,
            committed_page_id=sub.CommittedPageId,
            committed_revision_id=sub.CommittedRevisionId,
            created_at=sub.CreatedAt,
            updated_at=sub.UpdatedAt,
        )

    async def _serialize_submissions_async(
        self,
        book: Book,
        subs: list[ParentBookPageSubmission],
        *,
        base_url: str | None = None,
    ) -> list[ParentPageSubmissionRead]:
        if not subs:
            return []
        if private_submission_image_url is not _ORIGINAL_PRIVATE_SUBMISSION_IMAGE_URL:
            return [
                self._serialize_submission(book, sub, base_url=base_url)
                for sub in subs
            ]
        book_id = book.Id
        sign_items = [
            (sub.Id, sub.SourceStoragePath, sub.OwnerParentId)
            for sub in subs
        ]
        dtos = [
            self._serialize_submission(
                book, sub, base_url=base_url, prebuilt_image_url=""
            )
            for sub in subs
        ]
        rollback_fn = getattr(self.repo, "rollback", None)
        if inspect.iscoroutinefunction(rollback_fn):
            await rollback_fn()
        urls = await private_submission_image_urls_async(
            book_id,
            sign_items,
            base_url=base_url,
        )
        return [
            dto.model_copy(update={"image_url": url})
            for dto, url in zip(dtos, urls)
        ]

    async def _serialize_submission_async(
        self,
        book: Book,
        sub: ParentBookPageSubmission,
        *,
        base_url: str | None = None,
    ) -> ParentPageSubmissionRead:
        return (await self._serialize_submissions_async(book, [sub], base_url=base_url))[0]

    def _serialize_book_summary(
        self,
        book: Book,
        *,
        committed_count: int,
        submissions: list[ParentBookPageSubmission],
        readable_for_children: bool,
        ocr_contribution: Any | None = None,
        readability: Any | None = None,
    ) -> ParentPrivateBookSummaryRead:
        pending_count = sum(
            1 for s in submissions if s.WorkflowStatus in ("CHECKING", "PENDING_ADMIN", "NEEDS_RECHECK")
        )
        flagged_count = sum(
            1 for s in submissions if s.WorkflowStatus in ("NEEDS_ADMIN_REVIEW", "REJECTED")
        )
        failed_count = sum(1 for s in submissions if s.WorkflowStatus == "CHECK_FAILED")
        ready_to_add_count = sum(
            1 for s in submissions if s.WorkflowStatus in ("PASSED_READY_TO_ADD", "APPROVED_READY_TO_ADD")
        )
        has_held_multipage = any(
            s.BatchTotalPages > 1 and s.WorkflowStatus not in ("ADDED_TO_BOOK", "CANCELLED")
            for s in submissions
        )
        if ocr_contribution is not None and getattr(ocr_contribution, "enabled", False):
            privacy_notice = (
                "Chỉ bạn và các hồ sơ trẻ của bạn có thể đọc sách này. "
                "Đóng góp dữ liệu cải thiện nhận diện chữ đang BẬT cho cuốn sách này — bạn có thể ngừng đóng góp bất kỳ lúc nào."
            )
        else:
            privacy_notice = (
                "Chỉ bạn và các hồ sơ trẻ của bạn có thể đọc sách này sau khi trang được kiểm tra. "
                "Sách này hiện không được dùng để đóng góp dữ liệu cải thiện nhận diện chữ."
            )
        try:
            from app.services.ocr_ai.config import OcrCorrectionConfig

            if (
                OcrCorrectionConfig.private_book_allow_cloud_ai()
                and (os.getenv("OCR_CLOUD_CORRECTION_ENABLED") or "").strip().lower()
                in {"1", "true", "yes", "on"}
            ):
                privacy_notice = (
                    f"{privacy_notice} Văn bản trang sách tải lên được soát lỗi chính tả và kiểm tra an toàn trẻ em qua dịch vụ AI đám mây bảo mật."
                )
        except Exception:
            pass
        return ParentPrivateBookSummaryRead(
            id=book.Id,
            title=book.Title,
            author=book.Author,
            min_grade=int(book.MinGrade),
            max_grade=int(book.MaxGrade),
            lifecycle_status=book.LifecycleStatus,  # type: ignore[arg-type]
            visibility_scope="PARENT_PRIVATE",
            moderation_status=book.ModerationStatus,  # type: ignore[arg-type]
            suspended_reason=book.SuspendedReason,
            source_declaration=book.SourceDeclaration,
            committed_page_count=committed_count,
            pending_submission_count=pending_count,
            flagged_submission_count=flagged_count,
            failed_submission_count=failed_count,
            ready_to_add_count=ready_to_add_count,
            readable_for_children=readable_for_children,
            has_held_multipage_batch=has_held_multipage,
            privacy_notice=privacy_notice,
            ocr_contribution=ocr_contribution,
            readability=readability,
            created_at=book.CreatedAt,
        )

    async def _load_contribution_states(
        self, books: list[Book]
    ) -> dict[UUID, Any]:
        if not books:
            return {}
        svc = ParentFlow2ContributionService(self.db)
        try:
            async with self.db.begin_nested():
                book_ids = [b.Id for b in books]
                consents = await svc.repo.list_consents_for_books(book_ids)
                counts = await svc.repo.get_candidate_counts_by_book(book_ids)
            return {
                b.Id: svc.serialize_state(b, consents.get(b.Id), counts.get(b.Id, {}))
                for b in books
            }
        except Exception:
            return {b.Id: svc.serialize_state(b, None, {}) for b in books}

    async def _safe_revoke_flow2_contributions(
        self,
        *,
        book: Book,
        actor_id: UUID,
        reason: str,
        page_id: UUID | None = None,
        consent_event_action: str | None = None,
    ) -> None:
        svc = ParentFlow2ContributionService(self.db)
        try:
            async with self.db.begin_nested():
                await svc.revoke_on_lifecycle_change(
                    book=book,
                    actor_id=actor_id,
                    reason=reason,
                    page_id=page_id,
                    consent_event_action=consent_event_action,
                )
        except Exception as exc:
            msg = str(exc).lower()
            if "does not exist" in msg or "undefinedtable" in msg or "undefinedcolumn" in msg:
                return
            raise

    async def _refresh_after_commit(self, *instances: Any) -> None:
        if not isinstance(self.db, AsyncSession):
            return
        for inst in instances:
            if inst is not None:
                await self.db.refresh(inst)

    async def _safe_recruit_flow2_page(
        self,
        *,
        book: Book,
        page: BookPage,
        revision: PageRevision,
        submission: ParentBookPageSubmission,
        image_bytes: bytes | None = None,
        commit: bool = False,
    ) -> None:
        # Capture scalar IDs up-front so best-effort rollback logging never reads expired ORM attributes.
        book_id_str = str(book.Id)
        page_id_str = str(page.Id)
        svc = ParentFlow2ContributionService(self.db)
        try:
            if commit:
                await svc.recruit_committed_page_if_opted_in(
                    book=book,
                    page=page,
                    revision=revision,
                    submission=submission,
                    preloaded_image_bytes=image_bytes,
                )
                await self.repo.commit()
            else:
                async with self.db.begin_nested():
                    await svc.recruit_committed_page_if_opted_in(
                        book=book,
                        page=page,
                        revision=revision,
                        submission=submission,
                        preloaded_image_bytes=image_bytes,
                    )
        except Exception as exc:
            if commit:
                await self.repo.rollback()
            msg = str(exc).lower()
            if "does not exist" in msg or "undefinedtable" in msg or "undefinedcolumn" in msg:
                return
            if commit:
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="parent_private_book_flow2_recruit_failed",
                    stage="flow2_recruit",
                    book_id=book_id_str,
                    page_id=page_id_str,
                    exception=exc,
                )
                return
            raise

    # ------------------------------------------------------------------
    # Parent Book CRUD
    # ------------------------------------------------------------------
    async def create_book(
        self, actor_id: UUID, payload: ParentPrivateBookCreate
    ) -> ParentPrivateBookSummaryRead:
        await self._require_parent(actor_id)
        declaration = (
            f"[{payload.source_type}] {payload.source_note}"
            if payload.source_note
            else f"[{payload.source_type}]"
        )
        book = Book(
            Name=payload.title[:250],
            Title=payload.title,
            Author=payload.author,
            MinGrade=payload.min_grade,
            MaxGrade=payload.max_grade,
            LifecycleStatus="ACTIVE",
            CreatedBy=actor_id,
            VisibilityScope=VISIBILITY_PARENT_PRIVATE,
            OwnerParentId=actor_id,
            ModerationStatus=MODERATION_ACTIVE,
            SourceDeclaration=declaration[:1000],
        )
        await self.repo.create_private_book(book)
        await self.repo.add_audit_log(
            actor_id=actor_id,
            action="parent_private_book.created",
            resource_type="book",
            resource_id=book.Id,
            metadata={"visibility_scope": VISIBILITY_PARENT_PRIVATE, "source_type": payload.source_type},
        )
        await self.repo.commit()
        await self.db.refresh(book)
        contrib_map = await self._load_contribution_states([book])
        return self._serialize_book_summary(
            book,
            committed_count=0,
            submissions=[],
            readable_for_children=False,
            ocr_contribution=contrib_map.get(book.Id),
        )

    async def _readable_private_book_ids(
        self, book_ids: list[UUID], actor_id: UUID
    ) -> set[UUID] | None:
        if not book_ids:
            return set()
        batch_fn = getattr(self.repo, "readable_private_book_ids", None)
        if inspect.iscoroutinefunction(batch_fn):
            return set(await batch_fn(book_ids, actor_id))
        if isinstance(getattr(self, "db", None), AsyncSession):
            readable_rows = await self.db.execute(
                select(Book.Id).where(
                    Book.Id.in_(book_ids),
                    is_private_book_readable_by(actor_id),
                )
            )
            return set(readable_rows.scalars().all())
        return None

    async def _serialize_book_summaries(
        self,
        actor_id: UUID,
        books: list[Book],
        *,
        ready_only: bool = False,
    ) -> list[ParentPrivateBookSummaryRead]:
        if not books:
            return []
        book_ids = [b.Id for b in books]
        committed_map = await self.repo.committed_page_counts(book_ids)
        all_subs = await self.repo.list_submissions_for_books(book_ids)
        contrib_map = await self._load_contribution_states(books)
        subs_by_book: dict[UUID, list[ParentBookPageSubmission]] = {}
        for sub in all_subs:
            subs_by_book.setdefault(sub.BookId, []).append(sub)

        readable_ids: set[UUID] | None = None
        if not ready_only:
            readable_ids = await self._readable_private_book_ids(book_ids, actor_id)

        texts_by_book: dict[UUID, list[str]] = {}
        committed_book_ids = [
            b_id for b_id in book_ids if committed_map.get(b_id, 0) > 0
        ]
        if (
            isinstance(getattr(self, "db", None), AsyncSession)
            and committed_book_ids
        ):
            try:
                text_rows = await self.db.execute(
                    select(BookPage.BookId, PageRevision.VerifiedText)
                    .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
                    .where(
                        BookPage.BookId.in_(committed_book_ids),
                        BookPage.LifecycleStatus == "ACTIVE",
                        PageRevision.VerificationStatus == "VERIFIED",
                    )
                    .order_by(BookPage.BookId, BookPage.PageNumber)
                )
                for b_id, v_text in text_rows.all():
                    if v_text:
                        texts_by_book.setdefault(b_id, []).append(str(v_text))
            except Exception:
                texts_by_book = {}

        from app.schemas.parent_private_book import VietnameseReadabilityRead
        from app.services.vietnamese_readability import analyse_vietnamese_readability

        results: list[ParentPrivateBookSummaryRead] = []
        for book in books:
            if ready_only:
                readable = True
            elif readable_ids is not None:
                readable = book.Id in readable_ids
            else:
                readable = await self.repo.is_private_book_readable(book.Id, actor_id)
            book_texts = texts_by_book.get(book.Id, [])
            book_readability = (
                VietnameseReadabilityRead(
                    **analyse_vietnamese_readability(
                        "\n".join(book_texts),
                        min_grade=int(book.MinGrade),
                        max_grade=int(book.MaxGrade),
                    ).to_dict()
                )
                if book_texts
                else None
            )
            results.append(
                self._serialize_book_summary(
                    book,
                    committed_count=committed_map.get(book.Id, 0),
                    submissions=subs_by_book.get(book.Id, []),
                    readable_for_children=readable,
                    ocr_contribution=contrib_map.get(book.Id),
                    readability=book_readability,
                )
            )
        return results

    async def list_books(
        self, actor_id: UUID, *, ready_only: bool = False
    ) -> list[ParentPrivateBookSummaryRead]:
        await self._require_parent(actor_id)
        books = await self.repo.list_owned_private_books(actor_id, ready_only=ready_only)
        return await self._serialize_book_summaries(
            actor_id, books, ready_only=ready_only
        )

    async def list_books_paged(
        self,
        actor_id: UUID,
        *,
        ready_only: bool = False,
        search: str | None = None,
        limit: int = 9,
        offset: int = 0,
    ) -> ParentPrivateBookPageRead:
        await self._require_parent(actor_id)
        books, total = await self.repo.list_owned_private_books_paged(
            actor_id,
            ready_only=ready_only,
            search=search,
            limit=limit,
            offset=offset,
        )
        items = await self._serialize_book_summaries(
            actor_id, books, ready_only=ready_only
        )
        return ParentPrivateBookPageRead(
            items=items,
            total=total,
            limit=limit,
            offset=offset,
        )

    async def get_book(
        self, actor_id: UUID, book_id: UUID, *, base_url: str | None = None
    ) -> ParentPrivateBookDetailRead:
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        pages_rows = await self.repo.list_committed_pages(book_id)
        submissions = await self.repo.list_submissions_for_book(book_id)
        readable = await self.repo.is_private_book_readable(book_id, actor_id)
        contrib_map = await self._load_contribution_states([book])

        pending_ocr_sub = next(
            (
                s
                for s in submissions
                if s.WorkflowStatus == "CHECKING" and s.OcrStatus == "PENDING"
            ),
            None,
        )
        if pending_ocr_sub is not None:
            from app.services.remote_ocr_wakeup import (
                maybe_nudge_ocr_wakeup_for_stale_queued_job,
            )

            maybe_nudge_ocr_wakeup_for_stale_queued_job(
                job_id=pending_ocr_sub.Id,
                created_at=pending_ocr_sub.UpdatedAt or pending_ocr_sub.CreatedAt,
                reason="parent_book_poll_nudge",
            )

        book_id_val = book.Id
        book_owner_id = book.OwnerParentId
        page_items = [
            (page.Id, page.CurrentVerifiedRevisionId, page.ImagePath)
            for page, _rev in pages_rows
        ]
        sub_items = [
            (sub.Id, sub.SourceStoragePath, sub.OwnerParentId)
            for sub in submissions
        ]
        from app.schemas.parent_private_book import VietnameseReadabilityRead
        from app.services.vietnamese_readability import analyse_vietnamese_readability

        pages_dto = []
        committed_texts: list[str] = []
        for page, rev in pages_rows:
            v_text = (rev.VerifiedText or "") if rev else ""
            if v_text.strip():
                committed_texts.append(v_text)
            page_readability = (
                VietnameseReadabilityRead(
                    **analyse_vietnamese_readability(
                        v_text,
                        min_grade=int(book.MinGrade),
                        max_grade=int(book.MaxGrade),
                    ).to_dict()
                )
                if v_text.strip()
                else None
            )
            pages_dto.append(
                ParentPrivatePageRead(
                    page_id=page.Id,
                    page_number=int(page.PageNumber),
                    current_verified_revision_id=page.CurrentVerifiedRevisionId,
                    verified_text=v_text,
                    verified_text_preview=v_text[:240],
                    image_url="",
                    readability=page_readability,
                    created_at=page.CreatedAt,
                )
            )
        book_readability = (
            VietnameseReadabilityRead(
                **analyse_vietnamese_readability(
                    "\n".join(committed_texts),
                    min_grade=int(book.MinGrade),
                    max_grade=int(book.MaxGrade),
                ).to_dict()
            )
            if committed_texts
            else None
        )
        summary = self._serialize_book_summary(
            book,
            committed_count=len(pages_rows),
            submissions=submissions,
            readable_for_children=readable,
            ocr_contribution=contrib_map.get(book.Id),
            readability=book_readability,
        )
        submissions_dto = [
            self._serialize_submission(
                book, sub, base_url=base_url, prebuilt_image_url=""
            )
            for sub in submissions
        ]
        rollback_fn = getattr(self.repo, "rollback", None)
        if inspect.iscoroutinefunction(rollback_fn):
            await rollback_fn()
        if page_items:
            if private_page_image_url is not _ORIGINAL_PRIVATE_PAGE_IMAGE_URL:
                page_urls = [
                    await asyncio.to_thread(
                        private_page_image_url,
                        book_id_val,
                        page_id,
                        revision_id=rev_id,
                        base_url=base_url,
                        storage_path=storage_path,
                        owner_id=book_owner_id,
                    )
                    for page_id, rev_id, storage_path in page_items
                ]
            else:
                page_urls = await private_page_image_urls_async(
                    book_id_val,
                    page_items,
                    base_url=base_url,
                    owner_id=book_owner_id,
                )
            pages_dto = [
                dto.model_copy(update={"image_url": url})
                for dto, url in zip(pages_dto, page_urls)
            ]
        if sub_items:
            if private_submission_image_url is not _ORIGINAL_PRIVATE_SUBMISSION_IMAGE_URL:
                sub_urls = [
                    await asyncio.to_thread(
                        private_submission_image_url,
                        book_id_val,
                        sub_id,
                        base_url=base_url,
                        storage_path=storage_path,
                        owner_id=sub_owner_id,
                    )
                    for sub_id, storage_path, sub_owner_id in sub_items
                ]
            else:
                sub_urls = await private_submission_image_urls_async(
                    book_id_val,
                    sub_items,
                    base_url=base_url,
                )
            submissions_dto = [
                dto.model_copy(update={"image_url": url})
                for dto, url in zip(submissions_dto, sub_urls)
            ]
        return ParentPrivateBookDetailRead(
            book=summary,
            pages=pages_dto,
            submissions=submissions_dto,
        )

    async def update_book(
        self, actor_id: UUID, book_id: UUID, payload: ParentPrivateBookUpdate
    ) -> ParentPrivateBookSummaryRead:
        """Edit private book metadata -> if anything changed, retire committed pages and re-check ALL pages from scratch."""
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.ModerationStatus != MODERATION_ACTIVE or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(
                status_code=409,
                detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động nên không thể chỉnh sửa.",
            )

        cur_source_type, cur_source_note = _parse_source_declaration(book.SourceDeclaration)
        fields_set = payload.model_fields_set
        new_title = payload.title if "title" in fields_set and payload.title is not None else book.Title
        new_author = payload.author if "author" in fields_set else book.Author
        new_min = payload.min_grade if payload.min_grade is not None else int(book.MinGrade)
        new_max = payload.max_grade if payload.max_grade is not None else int(book.MaxGrade)
        if new_min > new_max:
            raise HTTPException(status_code=422, detail="Lớp tối thiểu không được lớn hơn lớp tối đa.")
        new_source_type = payload.source_type if payload.source_type is not None else cur_source_type
        new_source_note = payload.source_note if "source_note" in fields_set else cur_source_note
        new_declaration = (
            _format_source_declaration(new_source_type, new_source_note)
            if ("source_type" in fields_set or "source_note" in fields_set)
            else book.SourceDeclaration
        )

        changed = (
            new_title != book.Title
            or new_author != book.Author
            or new_min != int(book.MinGrade)
            or new_max != int(book.MaxGrade)
            or new_declaration != book.SourceDeclaration
        )
        if not changed:
            committed_map = await self.repo.committed_page_counts([book.Id])
            submissions = await self.repo.list_submissions_for_book(book.Id)
            readable = await self.repo.is_private_book_readable(book.Id, actor_id)
            contrib_map = await self._load_contribution_states([book])
            return self._serialize_book_summary(
                book,
                committed_count=committed_map.get(book.Id, 0),
                submissions=submissions,
                readable_for_children=readable,
                ocr_contribution=contrib_map.get(book.Id),
            )

        # Snapshot committed pages into plain tuples BEFORE rollback so Storage I/O runs outside DB write locks
        committed_snapshot = await self.repo.list_committed_pages(book_id)
        existing_subs_snapshot = await self.repo.list_submissions_for_book(book_id)
        linked_sub_id_by_page: dict[UUID, UUID] = {
            sub.CommittedPageId: sub.Id
            for sub in existing_subs_snapshot
            if sub.CommittedPageId is not None
        }
        page_copies_todo: list[tuple[UUID, str, int, int, int]] = [
            (page.Id, str(page.ImagePath), int(page.Width), int(page.Height), int(page.PageNumber))
            for page, _rev in committed_snapshot
        ]
        await self.repo.rollback()

        staged_copies: dict[UUID, tuple[str, str, int, int, str]] = {}
        uploaded_paths: list[str] = []
        try:
            locked_book: Book | None = None
            locked_pages: list[tuple[BookPage, PageRevision | None]] = []
            locked_subs: list[ParentBookPageSubmission] = []
            for attempt in range(3):
                for page_id, image_path, page_width, page_height, page_number in page_copies_todo:
                    if page_id in staged_copies:
                        continue
                    ext = _ext_from_path(image_path)
                    img_bytes = await asyncio.to_thread(
                        download_object,
                        image_path,
                        bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                    )
                    img_sha = hashlib.sha256(img_bytes).hexdigest()
                    target_sub_id = linked_sub_id_by_page.get(page_id) or uuid4()
                    fresh_path = (
                        f"private-books/{actor_id}/{book_id}/staging/{target_sub_id}/"
                        f"recheck-{uuid4().hex[:8]}.{ext}"
                    )
                    await asyncio.to_thread(
                        upload_object,
                        fresh_path,
                        img_bytes,
                        _safe_media_type(fresh_path),
                        bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                        upsert=False,
                    )
                    uploaded_paths.append(fresh_path)
                    staged_copies[page_id] = (
                        fresh_path,
                        img_sha,
                        page_width,
                        page_height,
                        f"trang-{page_number}.{ext}",
                    )

                locked_book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
                if locked_book is None:
                    raise HTTPException(status_code=404, detail="Resource not found")
                if locked_book.ModerationStatus != MODERATION_ACTIVE or locked_book.LifecycleStatus != "ACTIVE":
                    raise HTTPException(status_code=409, detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.")

                locked_pages = await self.repo.list_committed_pages(book_id, lock=True)
                locked_subs = await self.repo.list_submissions_for_book(book_id, lock=True)
                missing_pages = [
                    (page.Id, str(page.ImagePath), int(page.Width), int(page.Height), int(page.PageNumber))
                    for page, _rev in locked_pages
                    if page.Id not in staged_copies
                ]
                if not missing_pages:
                    break
                if attempt >= 2:
                    raise HTTPException(
                        status_code=409,
                        detail="Danh sách trang của sách vừa thay đổi đồng thời. Vui lòng thử cập nhật lại.",
                    )
                for sub in locked_subs:
                    if sub.CommittedPageId is not None:
                        linked_sub_id_by_page[sub.CommittedPageId] = sub.Id
                await self.repo.rollback()
                page_copies_todo = missing_pages

            if locked_book is None:
                raise HTTPException(status_code=404, detail="Resource not found")

            locked_book.Title = new_title
            locked_book.Name = new_title[:250]
            locked_book.Author = new_author
            locked_book.MinGrade = new_min
            locked_book.MaxGrade = new_max
            locked_book.SourceDeclaration = new_declaration

            now = datetime.now(timezone.utc)
            sub_by_committed_page: dict[UUID, ParentBookPageSubmission] = {
                sub.CommittedPageId: sub
                for sub in locked_subs
                if sub.CommittedPageId is not None
            }

            reset_sub_ids: set[UUID] = set()
            requeued_committed = 0
            recheck_batch_id = uuid4()
            new_submissions: list[ParentBookPageSubmission] = []
            for idx, (page, _rev) in enumerate(locked_pages, start=1):
                copied = staged_copies.get(page.Id)
                linked_sub = sub_by_committed_page.get(page.Id)
                if copied is None and linked_sub is None:
                    raise HTTPException(
                        status_code=409,
                        detail="Danh sách trang của sách vừa thay đổi đồng thời. Vui lòng thử cập nhật lại.",
                    )
                page.LifecycleStatus = "RETIRED"
                requeued_committed += 1
                if linked_sub is not None:
                    if copied is not None:
                        linked_sub.SourceStoragePath = copied[0]
                        linked_sub.SourceSha256 = copied[1]
                    linked_sub.TargetPageNumber = int(page.PageNumber)
                    if "source_type" in fields_set and payload.source_type is not None:
                        linked_sub.SourceType = new_source_type
                    if "source_note" in fields_set:
                        linked_sub.SourceNote = new_source_note
                    _reset_submission_for_full_recheck(
                        linked_sub, now=now, reset_ocr=True, auto_recheck=True
                    )
                    reset_sub_ids.add(linked_sub.Id)
                elif copied is not None:
                    fresh_path, img_sha, width, height, fname = copied
                    new_sub = ParentBookPageSubmission(
                        Id=uuid4(),
                        BookId=locked_book.Id,
                        OwnerParentId=actor_id,
                        BatchId=recheck_batch_id,
                        BatchTotalPages=max(1, len(locked_pages)),
                        SourcePageNumber=idx,
                        TargetPageNumber=int(page.PageNumber),
                        IdempotencyKey=f"book-edit-{recheck_batch_id.hex[:16]}-{idx}",
                        SourceFileName=fname,
                        SourceFormat="IMAGE",
                        SourceStoragePath=fresh_path,
                        SourceSha256=img_sha,
                        ImageWidth=width,
                        ImageHeight=height,
                        SourceType=new_source_type,
                        SourceNote=new_source_note,
                        SubmissionVersion=1,
                        OptimisticLockVersion=1,
                        WorkflowStatus="CHECKING",
                        OcrStatus="PENDING",
                        ProofreadStatus="PENDING",
                        ToolCheckStatus="PENDING",
                        TempExpiresAt=now + timedelta(days=STAGING_TTL_DAYS),
                        CreatedAt=now,
                        UpdatedAt=now,
                    )
                    new_submissions.append(new_sub)
                    reset_sub_ids.add(new_sub.Id)

            if new_submissions:
                await self.repo.add_submissions(new_submissions)

            reset_staged = 0
            for sub in locked_subs:
                if sub.Id in reset_sub_ids:
                    continue
                if "source_type" in fields_set and payload.source_type is not None:
                    sub.SourceType = new_source_type
                if "source_note" in fields_set:
                    sub.SourceNote = new_source_note
                _reset_submission_for_full_recheck(
                    sub, now=now, reset_ocr=True, auto_recheck=True
                )
                reset_sub_ids.add(sub.Id)
                reset_staged += 1

            await self.repo.supersede_open_moderation_requests_for_book(locked_book.Id, now)
            affected_subs = list(new_submissions)
            if reset_sub_ids:
                all_book_subs = await self.repo.list_submissions_for_book(
                    locked_book.Id, lock=True
                )
                affected_subs.extend(s for s in all_book_subs if s.Id in reset_sub_ids and s not in new_submissions)
            post_ocr_ready = await self._sync_remote_ocr_for_submissions(
                affected_subs, reason="BOOK_METADATA_UPDATED_RECHECK"
            )
            await self._safe_revoke_flow2_contributions(
                book=locked_book,
                actor_id=actor_id,
                reason="BOOK_METADATA_UPDATED_RECHECK",
            )
            await self.repo.add_audit_log(
                actor_id=actor_id,
                action="parent_private_book.updated_full_recheck",
                resource_type="book",
                resource_id=locked_book.Id,
                metadata={
                    "requeued_committed_pages": requeued_committed,
                    "reset_staged_submissions": reset_staged,
                },
            )
            await self.repo.commit()
            await self.db.refresh(locked_book)
            self._dispatch_post_ocr_if_ready(post_ocr_ready)
        except Exception:
            await self.repo.rollback()
            for p in uploaded_paths:
                try:
                    await asyncio.to_thread(delete_object, p, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET)
                except Exception:
                    pass
            raise

        committed_map = await self.repo.committed_page_counts([locked_book.Id])
        submissions = await self.repo.list_submissions_for_book(locked_book.Id)
        readable = await self.repo.is_private_book_readable(locked_book.Id, actor_id)
        contrib_map = await self._load_contribution_states([locked_book])
        return self._serialize_book_summary(
            locked_book,
            committed_count=committed_map.get(locked_book.Id, 0),
            submissions=submissions,
            readable_for_children=readable,
            ocr_contribution=contrib_map.get(locked_book.Id),
        )

    async def _sync_remote_ocr_for_submissions(
        self,
        submissions: list[ParentBookPageSubmission],
        *,
        reason: str = "SUPERSEDED_BY_PARENT_ACTION",
    ) -> list[ParentBookPageSubmission]:
        """Enqueue remote OCR jobs without firing post-OCR before transaction commit.

        Returns submissions that hit the SHA-256 OCR cache and are ready for
        post-OCR dispatch strictly AFTER `await self.repo.commit()`.
        """
        if not is_remote_ocr_mode() or not isinstance(self.db, AsyncSession):
            return []
        job_svc = OcrInferenceJobService(self.db)
        post_ocr_ready: list[ParentBookPageSubmission] = []
        for sub in submissions:
            await job_svc.cancel_for_submission(sub.Id, reason=reason)
            if sub.WorkflowStatus == "CHECKING" and sub.OcrStatus == "PENDING":
                job = await job_svc.enqueue_job(
                    job_kind=JOB_KIND_PARENT_SUBMISSION,
                    owner_user_id=sub.OwnerParentId,
                    book_id=sub.BookId,
                    submission_id=sub.Id,
                    image_bucket=SUPABASE_PRIVATE_BOOKS_BUCKET,
                    image_path=sub.SourceStoragePath,
                    image_sha256=sub.SourceSha256,
                    image_width=int(sub.ImageWidth),
                    image_height=int(sub.ImageHeight),
                    priority=PRIORITY_PARENT_SUBMISSION,
                    idempotency_key=(
                        f"parent_sub:{sub.Id}:v{int(sub.SubmissionVersion)}:o{int(sub.OptimisticLockVersion or 1)}"
                    ),
                    expected_version=int(sub.SubmissionVersion),
                    expected_candidate_hash=sub.CandidateHash,
                    processing_meta={"source_page_number": int(sub.SourcePageNumber)},
                    schedule_post_ocr=False,
                )
                if getattr(job, "should_schedule_post_ocr", False) or (
                    sub.WorkflowStatus == "CHECKING"
                    and sub.OcrStatus in ("COMPLETED", "NO_TEXT_DETECTED")
                ):
                    post_ocr_ready.append(sub)
        return post_ocr_ready

    @staticmethod
    def _dispatch_post_ocr_if_ready(submissions: list[ParentBookPageSubmission]) -> None:
        if not is_remote_ocr_mode():
            return
        for sub in submissions:
            if sub.WorkflowStatus == "CHECKING" and sub.OcrStatus in ("COMPLETED", "NO_TEXT_DETECTED"):
                schedule_parent_submission_post_ocr(sub.Id)

    async def delete_book(
        self, actor_id: UUID, book_id: UUID
    ) -> ParentDeletePrivateBookResponse:
        """Delete an owned private book immediately (soft-retire to preserve FK history; NO re-check)."""
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        now = datetime.now(timezone.utc)
        locked_pages = await self.repo.list_committed_pages(book_id, lock=True)
        locked_subs = await self.repo.list_submissions_for_book(book_id, lock=True)

        book.LifecycleStatus = "RETIRED"
        retired_pages_count = 0
        for page, _rev in locked_pages:
            page.LifecycleStatus = "RETIRED"
            retired_pages_count += 1

        staging_paths: list[str] = []
        cancelled_submissions_count = 0
        for sub in locked_subs:
            if sub.SourceStoragePath:
                staging_paths.append(sub.SourceStoragePath)
            sub.WorkflowStatus = "CANCELLED"
            sub.WorkerId = None
            sub.LeaseExpiresAt = None
            sub.RetryAfter = None
            sub.UpdatedAt = now
            cancelled_submissions_count += 1

        if is_remote_ocr_mode() and isinstance(self.db, AsyncSession):
            await OcrInferenceJobService(self.db).cancel_for_book(book.Id, reason="BOOK_DELETED")
        await self.repo.supersede_open_moderation_requests_for_book(book.Id, now)
        await self._safe_revoke_flow2_contributions(
            book=book,
            actor_id=actor_id,
            reason="BOOK_DELETED",
            consent_event_action="REVOKE_BOOK_DELETED",
        )
        await self.repo.add_audit_log(
            actor_id=actor_id,
            action="parent_private_book.deleted",
            resource_type="book",
            resource_id=book.Id,
            metadata={
                "retired_pages_count": retired_pages_count,
                "cancelled_submissions_count": cancelled_submissions_count,
            },
        )
        await self.repo.commit()
        await invalidate_tts_cache_best_effort(self.db, book_id=book_id, commit=True)

        # Best-effort cleanup of staging objects not referenced by moderation history
        preserved_paths = await self.repo.list_moderation_storage_paths_for_book(book_id)
        await self.repo.rollback()
        for path in set(staging_paths):
            if path and path not in preserved_paths:
                try:
                    await asyncio.to_thread(
                        delete_object, path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
                    )
                except Exception:
                    pass

        return ParentDeletePrivateBookResponse(
            status="deleted",
            book_id=book_id,
            retired_pages_count=retired_pages_count,
            cancelled_submissions_count=cancelled_submissions_count,
        )

    async def edit_committed_page(
        self,
        actor_id: UUID,
        book_id: UUID,
        page_id: UUID,
        payload: ParentPrivatePageEditRequest,
        *,
        base_url: str | None = None,
    ) -> ParentPageSubmissionRead:
        """Edit an already-committed page -> retire it from readable book and re-check from scratch."""
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.ModerationStatus != MODERATION_ACTIVE or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(
                status_code=409,
                detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động nên không thể sửa trang.",
            )
        page_row = await self.repo.get_committed_page(book_id, page_id)
        if page_row is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        page_snap, rev_snap = page_row
        linked_sub_snap = await self.repo.get_submission_by_committed_page_id(book_id, page_id)
        base_words_raw: list[dict[str, Any]] = []
        if rev_snap is not None:
            rev_words = await self.repo.list_revision_words(rev_snap.Id)
            base_words_raw = [
                {
                    "word_index": int(w.WordIndex),
                    "line_index": int(w.LineIndex),
                    "text": w.Text,
                    "normalized_text": w.NormalizedText,
                    "bounding_box": list(w.BoundingBox or []),
                    "ocr_confidence": w.OCRConfidence,
                }
                for w in rev_words
            ]
        elif linked_sub_snap is not None:
            base_words_raw = list(linked_sub_snap.OcrWordsJson or [])

        existing_text = (rev_snap.VerifiedText or "").strip() if rev_snap is not None else ""
        fields_set = payload.model_fields_set
        text_changed = (
            "candidate_text" in fields_set
            and payload.candidate_text is not None
            and payload.candidate_text.strip() != existing_text
        )
        page_num_changed = (
            payload.page_number is not None and payload.page_number != int(page_snap.PageNumber)
        )
        cur_source_type, cur_source_note = (
            (linked_sub_snap.SourceType, linked_sub_snap.SourceNote)
            if linked_sub_snap is not None
            else _parse_source_declaration(book.SourceDeclaration)
        )
        source_type_changed = (
            payload.source_type is not None and payload.source_type != cur_source_type
        )
        source_note_changed = (
            "source_note" in fields_set and payload.source_note != cur_source_note
        )
        if not (text_changed or page_num_changed or source_type_changed or source_note_changed):
            raise HTTPException(
                status_code=422,
                detail="Không có thay đổi nào để cập nhật cho trang này.",
            )

        page_image_path = page_snap.ImagePath
        page_width = int(page_snap.Width)
        page_height = int(page_snap.Height)
        target_sub_id = linked_sub_snap.Id if linked_sub_snap is not None else uuid4()
        await self.repo.rollback()

        ext = _ext_from_path(page_image_path)
        fresh_staging_path = (
            f"private-books/{actor_id}/{book_id}/staging/{target_sub_id}/"
            f"edit-{uuid4().hex[:8]}.{ext}"
        )
        uploaded_staging = False
        try:
            img_bytes = await asyncio.to_thread(
                download_object, page_image_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
            )
            img_sha = hashlib.sha256(img_bytes).hexdigest()
            await asyncio.to_thread(
                upload_object,
                fresh_staging_path,
                img_bytes,
                _safe_media_type(fresh_staging_path),
                bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                upsert=False,
            )
            uploaded_staging = True
            locked_book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
            if locked_book is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            if locked_book.ModerationStatus != MODERATION_ACTIVE or locked_book.LifecycleStatus != "ACTIVE":
                raise HTTPException(status_code=409, detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.")
            locked_pair = await self.repo.get_committed_page(book_id, page_id, lock=True)
            if locked_pair is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            locked_page, _locked_rev = locked_pair
            now = datetime.now(timezone.utc)
            locked_page.LifecycleStatus = "RETIRED"

            target_page_num = payload.page_number or int(locked_page.PageNumber)
            eff_source_type = payload.source_type or cur_source_type
            eff_source_note = payload.source_note if "source_note" in fields_set else cur_source_note

            sub = await self.repo.get_submission_by_committed_page_id(book_id, page_id, lock=True)
            if sub is None:
                sub = ParentBookPageSubmission(
                    Id=target_sub_id,
                    BookId=locked_book.Id,
                    OwnerParentId=actor_id,
                    BatchId=uuid4(),
                    BatchTotalPages=1,
                    SourcePageNumber=int(locked_page.PageNumber),
                    TargetPageNumber=target_page_num,
                    IdempotencyKey=f"page-edit-{uuid4().hex[:16]}",
                    SourceFileName=f"trang-{int(locked_page.PageNumber)}.{ext}",
                    SourceFormat="IMAGE",
                    SourceStoragePath=fresh_staging_path,
                    SourceSha256=img_sha,
                    ImageWidth=page_width,
                    ImageHeight=page_height,
                    SourceType=eff_source_type,
                    SourceNote=eff_source_note,
                    SubmissionVersion=1,
                    OptimisticLockVersion=1,
                    WorkflowStatus="CHECKING" if payload.auto_recheck else "NEEDS_RECHECK",
                    OcrStatus="PENDING",
                    ProofreadStatus="PENDING",
                    ToolCheckStatus="PENDING",
                    TempExpiresAt=now + timedelta(days=STAGING_TTL_DAYS),
                    CreatedAt=now,
                    UpdatedAt=now,
                )
                await self.repo.add_submissions([sub])
            else:
                sub.SourceStoragePath = fresh_staging_path
                sub.SourceSha256 = img_sha
                sub.TargetPageNumber = target_page_num
                sub.SourceType = eff_source_type
                sub.SourceNote = eff_source_note
                _reset_submission_for_full_recheck(
                    sub, now=now, reset_ocr=True, auto_recheck=payload.auto_recheck
                )

            if text_changed and payload.candidate_text is not None:
                new_text = payload.candidate_text.strip()
                if new_text:
                    aligned_words = align_edited_text_to_words(new_text, base_words_raw)
                    sub.OcrStatus = "COMPLETED"
                    sub.OcrText = new_text
                    sub.OcrWordsJson = aligned_words
                    sub.OcrHash = safety_content_hash(new_text)
                    sub.OcrErrorCode = None
                    sub.IsImageOnly = False
                    sub.CandidateText = new_text
                    sub.CandidateWordsJson = aligned_words
                    sub.CandidateHash = compute_candidate_hash(
                        new_text, source_sha256=img_sha, is_image_only=False
                    )
                    # Proofreading (Stage 2) and Tool Check (Stage 3) stay PENDING to re-check from scratch!

            await self.repo.supersede_open_moderation_requests(sub.Id, now)
            await self._sync_remote_ocr_for_submissions(
                [sub], reason="SUPERSEDED_BY_PARENT_COMMITTED_EDIT"
            )
            await self._safe_revoke_flow2_contributions(
                book=locked_book,
                actor_id=actor_id,
                page_id=locked_page.Id,
                reason="PAGE_EDITED_RECHECK",
            )
            await self.repo.add_audit_log(
                actor_id=actor_id,
                action="parent_private_book.page.edited_recheck",
                resource_type="book_page",
                resource_id=locked_page.Id,
                metadata={
                    "book_id": str(locked_book.Id),
                    "submission_id": str(sub.Id),
                    "submission_version": int(sub.SubmissionVersion),
                    "target_page_number": target_page_num,
                },
            )
            await self.repo.commit()
            await self.db.refresh(sub)
            self._dispatch_post_ocr_if_ready([sub])
        except Exception:
            await self.repo.rollback()
            if uploaded_staging:
                try:
                    await asyncio.to_thread(
                        delete_object, fresh_staging_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
                    )
                except Exception:
                    pass
            raise

        return await self._serialize_submission_async(locked_book, sub, base_url=base_url)

    async def _rasterize_single_spooled_page(
        self, upload: UploadFile
    ) -> tuple[str, str, RasterizedDocumentPage]:
        """Spool upload to disk and stream at most 2 pages so multi-page files fail fast in O(1) RAM."""
        spooled = await spool_upload_file(upload, max_bytes=MAX_DOCUMENT_BYTES)
        if spooled.byte_length <= 0:
            spooled.close()
            raise HTTPException(
                status_code=422, detail="The uploaded document is empty or corrupted"
            )
        try:
            with iter_rasterized_spooled_document(spooled) as (
                file_name,
                source_format,
                _source_sha256,
                page_iter,
            ):
                def _take_max_two(
                    it: Any,
                ) -> tuple[RasterizedDocumentPage | None, RasterizedDocumentPage | None]:
                    try:
                        first = next(it, None)
                        second = next(it, None) if first is not None else None
                        return first, second
                    finally:
                        close_fn = getattr(it, "close", None)
                        if callable(close_fn):
                            close_fn()

                first_page, second_page = await asyncio.to_thread(_take_max_two, page_iter)

            if first_page is None:
                raise HTTPException(
                    status_code=422,
                    detail="The uploaded document is empty or corrupted",
                )
            if second_page is not None:
                del second_page
                raise HTTPException(
                    status_code=422,
                    detail="Khi thay ảnh cho một trang cụ thể, hãy chọn đúng 1 ảnh hoặc tài liệu 1 trang.",
                )
            return file_name, source_format, first_page
        finally:
            spooled.close()
            gc.collect()

    async def replace_committed_page_file(
        self,
        actor_id: UUID,
        book_id: UUID,
        page_id: UUID,
        upload: UploadFile,
        *,
        source_type: str | None = None,
        source_note: str | None = None,
        base_url: str | None = None,
    ) -> ParentPageSubmissionRead:
        """Replace image of a committed page -> retire old page and run full OCR -> Proofread -> Tool Check."""
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.ModerationStatus != MODERATION_ACTIVE or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.")
        page_row = await self.repo.get_committed_page(book_id, page_id)
        if page_row is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        linked_sub_snap = await self.repo.get_submission_by_committed_page_id(book_id, page_id)
        target_sub_id = linked_sub_snap.Id if linked_sub_snap is not None else uuid4()
        cur_source_type, cur_source_note = (
            (linked_sub_snap.SourceType, linked_sub_snap.SourceNote)
            if linked_sub_snap is not None
            else _parse_source_declaration(book.SourceDeclaration)
        )
        await self.repo.rollback()

        if source_type is not None and source_type not in VALID_SOURCE_TYPES:
            raise HTTPException(status_code=422, detail="Loại nguồn sử dụng không hợp lệ.")

        source_file_name, source_format, page_img = await self._rasterize_single_spooled_page(
            upload
        )
        page_bytes = page_img.image_bytes
        page_content_type = page_img.content_type
        page_extension = page_img.extension
        page_width = page_img.width
        page_height = page_img.height
        del page_img
        gc.collect()
        new_sha = hashlib.sha256(page_bytes).hexdigest()
        new_storage_path = (
            f"private-books/{actor_id}/{book_id}/staging/{target_sub_id}/"
            f"replace-{uuid4().hex[:8]}.{page_extension}"
        )
        uploaded_new_storage = False
        try:
            await asyncio.to_thread(
                upload_object,
                new_storage_path,
                page_bytes,
                page_content_type,
                bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                upsert=False,
            )
            del page_bytes
            gc.collect()
            uploaded_new_storage = True
            locked_book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
            if locked_book is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            if locked_book.ModerationStatus != MODERATION_ACTIVE or locked_book.LifecycleStatus != "ACTIVE":
                raise HTTPException(status_code=409, detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.")
            locked_pair = await self.repo.get_committed_page(book_id, page_id, lock=True)
            if locked_pair is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            locked_page, _locked_rev = locked_pair
            now = datetime.now(timezone.utc)
            locked_page.LifecycleStatus = "RETIRED"

            eff_source_type = source_type or cur_source_type
            eff_source_note = (
                (source_note.strip()[:1000] or None) if source_note is not None else cur_source_note
            )

            sub = await self.repo.get_submission_by_committed_page_id(book_id, page_id, lock=True)
            if sub is None:
                sub = ParentBookPageSubmission(
                    Id=target_sub_id,
                    BookId=locked_book.Id,
                    OwnerParentId=actor_id,
                    BatchId=uuid4(),
                    BatchTotalPages=1,
                    SourcePageNumber=int(locked_page.PageNumber),
                    TargetPageNumber=int(locked_page.PageNumber),
                    IdempotencyKey=f"page-replace-{uuid4().hex[:16]}",
                    SourceFileName=source_file_name,
                    SourceFormat=source_format,
                    SourceStoragePath=new_storage_path,
                    SourceSha256=new_sha,
                    ImageWidth=page_width,
                    ImageHeight=page_height,
                    SourceType=eff_source_type,
                    SourceNote=eff_source_note,
                    SubmissionVersion=1,
                    OptimisticLockVersion=1,
                    WorkflowStatus="CHECKING",
                    OcrStatus="PENDING",
                    ProofreadStatus="PENDING",
                    ToolCheckStatus="PENDING",
                    TempExpiresAt=now + timedelta(days=STAGING_TTL_DAYS),
                    CreatedAt=now,
                    UpdatedAt=now,
                )
                await self.repo.add_submissions([sub])
            else:
                sub.SourceFileName = source_file_name
                sub.SourceFormat = source_format
                sub.SourceStoragePath = new_storage_path
                sub.SourceSha256 = new_sha
                sub.ImageWidth = page_width
                sub.ImageHeight = page_height
                sub.TargetPageNumber = int(locked_page.PageNumber)
                sub.SourceType = eff_source_type
                sub.SourceNote = eff_source_note
                _reset_submission_for_full_recheck(
                    sub, now=now, reset_ocr=True, auto_recheck=True
                )

            await self.repo.supersede_open_moderation_requests(sub.Id, now)
            post_ocr_ready = await self._sync_remote_ocr_for_submissions(
                [sub], reason="SUPERSEDED_BY_PARENT_COMMITTED_REPLACE"
            )
            await self._safe_revoke_flow2_contributions(
                book=locked_book,
                actor_id=actor_id,
                page_id=locked_page.Id,
                reason="PAGE_IMAGE_REPLACED",
            )
            await self.repo.add_audit_log(
                actor_id=actor_id,
                action="parent_private_book.page.replaced_recheck",
                resource_type="book_page",
                resource_id=locked_page.Id,
                metadata={
                    "book_id": str(locked_book.Id),
                    "submission_id": str(sub.Id),
                    "submission_version": int(sub.SubmissionVersion),
                    "target_page_number": int(locked_page.PageNumber),
                },
            )
            await self.repo.commit()
            await self.db.refresh(sub)
            self._dispatch_post_ocr_if_ready(post_ocr_ready)
        except Exception:
            await self.repo.rollback()
            if uploaded_new_storage:
                try:
                    await asyncio.to_thread(
                        delete_object, new_storage_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
                    )
                except Exception:
                    pass
            raise

        resp = await self._serialize_submission_async(locked_book, sub, base_url=base_url)
        await invalidate_tts_cache_best_effort(self.db, page_id=page_id, commit=True)
        return resp

    async def delete_committed_page(
        self, actor_id: UUID, book_id: UUID, page_id: UUID
    ) -> ParentDeletePrivatePageResponse:
        """Delete a committed page immediately (soft-retire to preserve FK history; NO re-check)."""
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        locked_pair = await self.repo.get_committed_page(book_id, page_id, lock=True)
        if locked_pair is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        locked_page, _locked_rev = locked_pair

        now = datetime.now(timezone.utc)
        locked_page.LifecycleStatus = "RETIRED"
        linked_sub = await self.repo.get_submission_by_committed_page_id(book_id, page_id, lock=True)
        if linked_sub is not None and linked_sub.WorkflowStatus != "CANCELLED":
            linked_sub.WorkflowStatus = "CANCELLED"
            linked_sub.WorkerId = None
            linked_sub.LeaseExpiresAt = None
            linked_sub.RetryAfter = None
            linked_sub.UpdatedAt = now
            if is_remote_ocr_mode() and isinstance(self.db, AsyncSession):
                await OcrInferenceJobService(self.db).cancel_for_submission(
                    linked_sub.Id, reason="BOOK_PAGE_RETIRED"
                )

        await self._safe_revoke_flow2_contributions(
            book=book,
            actor_id=actor_id,
            page_id=locked_page.Id,
            reason="PAGE_DELETED",
        )
        await self.repo.add_audit_log(
            actor_id=actor_id,
            action="parent_private_book.page.deleted",
            resource_type="book_page",
            resource_id=locked_page.Id,
            metadata={
                "book_id": str(book.Id),
                "page_number": int(locked_page.PageNumber),
            },
        )
        await self.repo.commit()
        committed_map = await self.repo.committed_page_counts([book_id])
        readable = await self.repo.is_private_book_readable(book_id, actor_id)
        resp = ParentDeletePrivatePageResponse(
            status="deleted",
            book_id=book_id,
            page_id=page_id,
            committed_page_count=committed_map.get(book_id, 0),
            readable_for_children=readable,
        )
        await invalidate_tts_cache_best_effort(self.db, page_id=page_id, commit=True)
        return resp

    # ------------------------------------------------------------------
    # Parent Page Submission (Upload -> Staging -> Check Queue)
    # ------------------------------------------------------------------
    async def submit_pages(
        self,
        actor_id: UUID,
        book_id: UUID,
        upload: UploadFile,
        *,
        idempotency_key: str,
        source_type: str = "OWNED_PHYSICAL_BOOK",
        source_note: str | None = None,
        target_page_number: int | None = None,
        base_url: str | None = None,
    ) -> ParentSubmitPagesResponse:
        await self._require_parent(actor_id)
        normalized_key = (idempotency_key or "").strip()
        if not normalized_key or len(normalized_key) > 128:
            raise HTTPException(status_code=422, detail="Khóa idempotency không hợp lệ.")
        if source_type not in VALID_SOURCE_TYPES:
            raise HTTPException(status_code=422, detail="Loại nguồn sử dụng không hợp lệ.")
        if target_page_number is not None and not (1 <= int(target_page_number) <= 32767):
            raise HTTPException(status_code=422, detail="Số trang đích phải nằm trong khoảng từ 1 đến 32767.")
        clean_note = (source_note or "").strip()[:1000] or None

        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.LifecycleStatus != "ACTIVE" or book.ModerationStatus != MODERATION_ACTIVE:
            raise HTTPException(
                status_code=409,
                detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động nên không thể tải thêm trang.",
            )

        # Idempotency replay check BEFORE reading/uploading bytes
        existing = await self.repo.get_submissions_by_idempotency(actor_id, book_id, normalized_key)
        if existing:
            existing_batch_id = existing[0].BatchId
            existing_source_format = existing[0].SourceFormat
            existing_total = len(existing)
            serialized_existing = await self._serialize_submissions_async(
                book, existing, base_url=base_url
            )
            return ParentSubmitPagesResponse(
                book_id=book_id,
                batch_id=existing_batch_id,
                source_format=existing_source_format,
                total_pages=existing_total,
                replayed_idempotency=True,
                submissions=serialized_existing,
            )

        await self.repo.rollback()

        spooled = await spool_upload_file(upload, max_bytes=MAX_DOCUMENT_BYTES)
        if spooled.byte_length <= 0:
            spooled.close()
            raise HTTPException(status_code=422, detail="The uploaded document is empty or corrupted")

        batch_id = uuid4()
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(days=STAGING_TTL_DAYS)
        uploaded_paths: list[str] = []
        created_rows: list[ParentBookPageSubmission] = []
        post_ocr_ready: list[ParentBookPageSubmission] = []
        source_format: str = "IMAGE"

        try:
            with iter_rasterized_spooled_document(spooled) as (
                file_name,
                source_format,
                _source_sha256,
                page_iter,
            ):
                def _next_page(it):
                    return next(it, None)

                idx = 0
                while True:
                    page = await asyncio.to_thread(_next_page, page_iter)
                    if page is None:
                        break
                    idx += 1
                    page_target = (
                        (target_page_number + idx - 1)
                        if target_page_number is not None
                        else None
                    )
                    if page_target is not None and page_target > 32767:
                        raise HTTPException(
                            status_code=422,
                            detail="Số trang đích của lô tài liệu vượt quá giới hạn tối đa (32767).",
                        )
                    try:
                        sub_id = uuid4()
                        page_sha = hashlib.sha256(page.image_bytes).hexdigest()
                        storage_path = (
                            f"private-books/{actor_id}/{book_id}/staging/{sub_id}/"
                            f"page-{page.source_page}.{page.extension}"
                        )
                        await asyncio.to_thread(
                            upload_object,
                            storage_path,
                            page.image_bytes,
                            page.content_type,
                            bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                            upsert=False,
                        )
                        uploaded_paths.append(storage_path)
                        created_rows.append(
                            ParentBookPageSubmission(
                                Id=sub_id,
                                BookId=book_id,
                                OwnerParentId=actor_id,
                                BatchId=batch_id,
                                BatchTotalPages=1,
                                SourcePageNumber=page.source_page,
                                TargetPageNumber=page_target,
                                IdempotencyKey=normalized_key,
                                SourceFileName=file_name,
                                SourceFormat=source_format,
                                SourceStoragePath=storage_path,
                                SourceSha256=page_sha,
                                ImageWidth=page.width,
                                ImageHeight=page.height,
                                SourceType=source_type,
                                SourceNote=clean_note,
                                SubmissionVersion=1,
                                OptimisticLockVersion=1,
                                WorkflowStatus="CHECKING",
                                OcrStatus="PENDING",
                                ProofreadStatus="PENDING",
                                ToolCheckStatus="PENDING",
                                TempExpiresAt=expires_at,
                                CreatedAt=now,
                                UpdatedAt=now,
                            )
                        )
                    finally:
                        del page
                        gc.collect()

            total_batch_pages = len(created_rows)
            for row in created_rows:
                row.BatchTotalPages = total_batch_pages

            # Re-verify book state & persist atomically
            locked_book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
            if locked_book is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            if locked_book.LifecycleStatus != "ACTIVE" or locked_book.ModerationStatus != MODERATION_ACTIVE:
                raise HTTPException(
                    status_code=409,
                    detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.",
                )
            await self.repo.add_submissions(created_rows)
            post_ocr_ready = await self._sync_remote_ocr_for_submissions(
                created_rows, reason="INITIAL_SUBMIT"
            )
            await self.repo.commit()
            self._dispatch_post_ocr_if_ready(post_ocr_ready)
        except IntegrityError:
            await self.repo.rollback()
            for p in uploaded_paths:
                try:
                    await asyncio.to_thread(delete_object, p, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET)
                except Exception:
                    pass
            replayed = await self.repo.get_submissions_by_idempotency(actor_id, book_id, normalized_key)
            if replayed:
                book_after = await self.repo.get_owned_private_book(book_id, actor_id)
                if book_after is None:
                    raise HTTPException(status_code=404, detail="Resource not found")
                replayed_batch_id = replayed[0].BatchId
                replayed_source_format = replayed[0].SourceFormat
                replayed_total = len(replayed)
                serialized_replayed = await self._serialize_submissions_async(
                    book_after, replayed, base_url=base_url
                )
                return ParentSubmitPagesResponse(
                    book_id=book_id,
                    batch_id=replayed_batch_id,
                    source_format=replayed_source_format,
                    total_pages=replayed_total,
                    replayed_idempotency=True,
                    submissions=serialized_replayed,
                )
            raise
        except Exception:
            await self.repo.rollback()
            for p in uploaded_paths:
                try:
                    await asyncio.to_thread(delete_object, p, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET)
                except Exception:
                    pass
            raise
        finally:
            spooled.close()

        for row in created_rows:
            await self.db.refresh(row)

        serialized_created = await self._serialize_submissions_async(
            locked_book, created_rows, base_url=base_url
        )
        return ParentSubmitPagesResponse(
            book_id=book_id,
            batch_id=batch_id,
            source_format=source_format,
            total_pages=len(created_rows),
            replayed_idempotency=False,
            submissions=serialized_created,
        )

    async def get_submission(
        self,
        actor_id: UUID,
        book_id: UUID,
        submission_id: UUID,
        *,
        base_url: str | None = None,
    ) -> ParentPageSubmissionRead:
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        sub = await self.repo.get_owned_submission(book_id, submission_id, actor_id)
        if sub is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if sub.WorkflowStatus == "CHECKING" and sub.OcrStatus == "PENDING":
            from app.services.remote_ocr_wakeup import (
                maybe_nudge_ocr_wakeup_for_stale_queued_job,
            )

            maybe_nudge_ocr_wakeup_for_stale_queued_job(
                job_id=sub.Id,
                created_at=sub.UpdatedAt or sub.CreatedAt,
                reason="parent_submission_poll_nudge",
            )
        return await self._serialize_submission_async(book, sub, base_url=base_url)

    async def accept_spelling(
        self,
        actor_id: UUID,
        book_id: UUID,
        submission_id: UUID,
        payload: ParentAcceptSpellingRequest,
        *,
        base_url: str | None = None,
    ) -> ParentPageSubmissionRead:
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        sub = await self.repo.get_owned_submission(book_id, submission_id, actor_id, lock=True)
        if sub is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if (
            int(sub.SubmissionVersion) != payload.expected_submission_version
            or sub.CandidateHash != payload.expected_candidate_hash
        ):
            raise HTTPException(
                status_code=409,
                detail="Phiên bản trang đã thay đổi. Hãy tải lại trước khi chấp nhận chính tả.",
            )
        if sub.ProofreadStatus != "COMPLETED":
            raise HTTPException(
                status_code=409,
                detail="Bước rà chính tả chưa hoàn tất.",
            )
        now = datetime.now(timezone.utc)
        sub.SpellingAcceptedAt = now
        sub.UpdatedAt = now
        await self.repo.commit()
        await self.db.refresh(sub)
        return await self._serialize_submission_async(book, sub, base_url=base_url)

    async def edit_submission(
        self,
        actor_id: UUID,
        book_id: UUID,
        submission_id: UUID,
        payload: ParentSubmissionEditRequest,
        *,
        base_url: str | None = None,
    ) -> ParentPageSubmissionRead:
        """Edit candidate text or source declaration -> creates new snapshot & invalidates check/approval."""
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.ModerationStatus != MODERATION_ACTIVE or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.")

        sub = await self.repo.get_owned_submission(book_id, submission_id, actor_id, lock=True)
        if sub is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if sub.WorkflowStatus in ("ADDED_TO_BOOK", "CANCELLED"):
            raise HTTPException(status_code=409, detail="Không thể chỉnh sửa bản nộp đã hoàn tất hoặc đã hủy.")
        if (
            payload.expected_lock_version is not None
            and int(sub.OptimisticLockVersion) != payload.expected_lock_version
        ):
            raise HTTPException(status_code=409, detail="Phiên bản trang vừa thay đổi. Hãy tải lại.")

        now = datetime.now(timezone.utc)
        fields_set = payload.model_fields_set
        changed = False
        text_changed = False
        new_text_value: str | None = None
        if "candidate_text" in fields_set and payload.candidate_text is not None:
            new_text = payload.candidate_text.strip()
            if new_text != (sub.CandidateText or "").strip():
                changed = True
                text_changed = True
                new_text_value = new_text

        if "source_type" in fields_set and payload.source_type is not None and payload.source_type != sub.SourceType:
            sub.SourceType = payload.source_type
            changed = True
        if "source_note" in fields_set and payload.source_note != sub.SourceNote:
            sub.SourceNote = payload.source_note
            changed = True

        if not changed:
            dto = await self._serialize_submission_async(book, sub, base_url=base_url)
            await self.repo.rollback()
            return dto

        # Full re-check from scratch on any edit:
        # - If text was cleared to empty OR only source metadata changed -> reset all 3 stages (OCR -> Proofread -> Tool Check).
        # - If parent typed non-empty text -> preserve their text as OCR input and reset Stage 2 Proofreading + Stage 3 Tool Check + Admin approvals.
        base_words = list(sub.OcrWordsJson or [])
        if text_changed and new_text_value:
            aligned_words = align_edited_text_to_words(new_text_value, base_words)
            _reset_submission_for_full_recheck(
                sub, now=now, reset_ocr=False, auto_recheck=payload.auto_recheck
            )
            sub.OcrStatus = "COMPLETED"
            sub.OcrText = new_text_value
            sub.OcrWordsJson = aligned_words
            sub.OcrHash = safety_content_hash(new_text_value)
            sub.OcrErrorCode = None
            sub.IsImageOnly = False
            sub.CandidateText = new_text_value
            sub.CandidateWordsJson = aligned_words
            sub.CandidateHash = compute_candidate_hash(
                new_text_value,
                source_sha256=sub.SourceSha256,
                is_image_only=False,
            )
        else:
            _reset_submission_for_full_recheck(
                sub, now=now, reset_ocr=True, auto_recheck=payload.auto_recheck
            )

        await self.repo.supersede_open_moderation_requests(sub.Id, now)
        await self._sync_remote_ocr_for_submissions([sub], reason="SUPERSEDED_BY_PARENT_EDIT")
        await self.repo.commit()
        await self.db.refresh(sub)
        self._dispatch_post_ocr_if_ready([sub])
        return await self._serialize_submission_async(book, sub, base_url=base_url)

    async def replace_submission_file(
        self,
        actor_id: UUID,
        book_id: UUID,
        submission_id: UUID,
        upload: UploadFile,
        *,
        source_type: str | None = None,
        source_note: str | None = None,
        base_url: str | None = None,
    ) -> ParentPageSubmissionRead:
        """Replace staged page image -> invalidates OCR, Proofreading, Tool Check, and any Admin approval."""
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.ModerationStatus != MODERATION_ACTIVE or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.")
        existing = await self.repo.get_owned_submission(book_id, submission_id, actor_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if existing.WorkflowStatus in ("ADDED_TO_BOOK", "CANCELLED"):
            raise HTTPException(status_code=409, detail="Không thể thay ảnh cho bản nộp đã hoàn tất hoặc đã hủy.")
        await self.repo.rollback()

        source_file_name, source_format, page = await self._rasterize_single_spooled_page(
            upload
        )
        page_bytes = page.image_bytes
        page_content_type = page.content_type
        page_extension = page.extension
        page_width = page.width
        page_height = page.height
        del page
        gc.collect()
        new_sha = hashlib.sha256(page_bytes).hexdigest()
        new_storage_path = (
            f"private-books/{actor_id}/{book_id}/staging/{submission_id}/"
            f"v-{uuid4().hex[:8]}.{page_extension}"
        )
        old_storage_path: str | None = None
        locked_book: Book | None = None
        uploaded_new = False
        try:
            await asyncio.to_thread(
                upload_object,
                new_storage_path,
                page_bytes,
                page_content_type,
                bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                upsert=False,
            )
            del page_bytes
            gc.collect()
            uploaded_new = True
            locked_book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
            if locked_book is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            if locked_book.ModerationStatus != MODERATION_ACTIVE or locked_book.LifecycleStatus != "ACTIVE":
                raise HTTPException(status_code=409, detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.")
            sub = await self.repo.get_owned_submission(book_id, submission_id, actor_id, lock=True)
            if sub is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            if sub.WorkflowStatus in ("ADDED_TO_BOOK", "CANCELLED"):
                raise HTTPException(status_code=409, detail="Không thể thay ảnh cho bản nộp đã hoàn tất.")
            old_storage_path = sub.SourceStoragePath
            now = datetime.now(timezone.utc)
            sub.SubmissionVersion = int(sub.SubmissionVersion) + 1
            sub.OptimisticLockVersion = int(sub.OptimisticLockVersion) + 1
            sub.SourceFileName = source_file_name
            sub.SourceFormat = source_format
            sub.SourceStoragePath = new_storage_path
            sub.SourceSha256 = new_sha
            sub.ImageWidth = page_width
            sub.ImageHeight = page_height
            if source_type is not None:
                if source_type not in VALID_SOURCE_TYPES:
                    raise HTTPException(status_code=422, detail="Loại nguồn sử dụng không hợp lệ.")
                sub.SourceType = source_type
            if source_note is not None:
                sub.SourceNote = source_note.strip()[:1000] or None

            # Reset ALL stages & invalidate prior approvals
            sub.OcrStatus = "PENDING"
            sub.OcrText = None
            sub.OcrWordsJson = []
            sub.OcrMetaJson = {}
            sub.OcrHash = None
            sub.OcrErrorCode = None
            sub.IsImageOnly = False
            sub.ProofreadStatus = "PENDING"
            sub.ProofreadText = None
            sub.ProofreadHash = None
            sub.ProofreadSuggestionsJson = []
            sub.UncertainWordIndicesJson = []
            sub.ProofreadProviderEventsJson = []
            sub.ProofreadErrorCode = None
            sub.SpellingAcceptedAt = None
            sub.CandidateText = None
            sub.CandidateHash = None
            sub.CandidateWordsJson = []
            sub.ToolCheckStatus = "PENDING"
            sub.ToolCheckInputHash = None
            sub.ToolCheckSuitability = None
            sub.ToolCheckScopeJson = {}
            sub.ToolCheckFindingsJson = []
            sub.ToolCheckProviderEventsJson = []
            sub.ToolCheckErrorCode = None
            sub.ToolCheckPolicyBlocked = False
            sub.ToolCheckCompletedAt = None
            sub.ApprovedSnapshotHash = None
            sub.ApprovedSubmissionVersion = None
            sub.ApprovedBy = None
            sub.ApprovedAt = None
            sub.AdminDecision = None
            sub.AdminDecisionReason = None
            sub.WorkerId = None
            sub.LeaseExpiresAt = None
            sub.RetryAfter = None
            sub.WorkflowStatus = "CHECKING"
            sub.TempExpiresAt = now + timedelta(days=STAGING_TTL_DAYS)
            sub.UpdatedAt = now
            await self.repo.supersede_open_moderation_requests(sub.Id, now)
            post_ocr_ready = await self._sync_remote_ocr_for_submissions(
                [sub], reason="SUPERSEDED_BY_PARENT_REPLACE"
            )
            await self.repo.commit()
            await self.db.refresh(sub)
            self._dispatch_post_ocr_if_ready(post_ocr_ready)
        except Exception:
            await self.repo.rollback()
            if uploaded_new:
                try:
                    await asyncio.to_thread(delete_object, new_storage_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET)
                except Exception:
                    pass
            raise

        # Keep old staging file if referenced by historical moderation request; delete only if never moderated
        history = await self.repo.list_moderation_history(submission_id)
        should_delete_old = bool(
            old_storage_path and not any(h.SourceStoragePath == old_storage_path for h in history)
        )
        if locked_book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        response_dto = await self._serialize_submission_async(locked_book, sub, base_url=base_url)
        await self.repo.rollback()
        if should_delete_old and old_storage_path:
            try:
                await asyncio.to_thread(delete_object, old_storage_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET)
            except Exception:
                pass
        return response_dto

    async def retry_submission(
        self,
        actor_id: UUID,
        book_id: UUID,
        submission_id: UUID,
        payload: ParentRetrySubmissionRequest,
        *,
        base_url: str | None = None,
    ) -> ParentPageSubmissionRead:
        """Retry ONLY the failed/pending stage while preserving already-completed earlier stages."""
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.ModerationStatus != MODERATION_ACTIVE or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.")

        sub = await self.repo.get_owned_submission(book_id, submission_id, actor_id, lock=True)
        if sub is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if sub.WorkflowStatus not in ("CHECK_FAILED", "NEEDS_RECHECK"):
            raise HTTPException(
                status_code=409,
                detail="Chỉ có thể thử lại các trang đang ở trạng thái kiểm tra lỗi hoặc cần kiểm tra lại.",
            )

        now = datetime.now(timezone.utc)
        stage = payload.stage
        if (
            stage == "OCR"
            or (
                stage == "AUTO"
                and (sub.OcrStatus in ("PENDING", "FAILED", "NO_TEXT_DETECTED") or bool(sub.IsImageOnly))
            )
            or (
                stage == "PROOFREADING"
                and (bool(sub.IsImageOnly) or sub.OcrStatus != "COMPLETED")
            )
        ):
            sub.OcrStatus = "PENDING"
            sub.OcrErrorCode = None
            sub.IsImageOnly = False
            sub.ProofreadStatus = "PENDING"
            sub.ProofreadErrorCode = None
            sub.ToolCheckStatus = "PENDING"
            sub.ToolCheckErrorCode = None
        elif stage == "PROOFREADING" or (stage == "AUTO" and sub.ProofreadStatus in ("PENDING", "FAILED")):
            # Preserve completed Stage 1 (OCR)
            sub.ProofreadStatus = "PENDING"
            sub.ProofreadErrorCode = None
            sub.ToolCheckStatus = "PENDING"
            sub.ToolCheckErrorCode = None
        else:
            # Preserve completed Stage 1 (OCR) & Stage 2 (Proofreading)
            sub.ToolCheckStatus = "PENDING"
            sub.ToolCheckErrorCode = None

        sub.WorkflowStatus = "CHECKING"
        sub.WorkerId = None
        sub.LeaseExpiresAt = None
        sub.RetryAfter = None
        sub.TempExpiresAt = now + timedelta(days=STAGING_TTL_DAYS)
        sub.OptimisticLockVersion = int(sub.OptimisticLockVersion or 1) + 1
        sub.UpdatedAt = now
        await self._sync_remote_ocr_for_submissions(
            [sub], reason="SUPERSEDED_BY_PARENT_RETRY"
        )
        await self.repo.commit()
        await self.db.refresh(sub)
        self._dispatch_post_ocr_if_ready([sub])
        return await self._serialize_submission_async(book, sub, base_url=base_url)

    async def cancel_submission(
        self, actor_id: UUID, book_id: UUID, submission_id: UUID
    ) -> dict[str, str]:
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        sub = await self.repo.get_owned_submission(book_id, submission_id, actor_id, lock=True)
        if sub is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if sub.WorkflowStatus == "ADDED_TO_BOOK":
            raise HTTPException(status_code=409, detail="Không thể hủy trang đã thêm vào sách.")
        now = datetime.now(timezone.utc)
        storage_path = sub.SourceStoragePath
        sub.WorkflowStatus = "CANCELLED"
        sub.WorkerId = None
        sub.LeaseExpiresAt = None
        sub.UpdatedAt = now
        if is_remote_ocr_mode() and isinstance(self.db, AsyncSession):
            await OcrInferenceJobService(self.db).cancel_for_submission(
                sub.Id, reason="SUBMISSION_CANCELLED"
            )
        await self.repo.supersede_open_moderation_requests(sub.Id, now)
        await self.repo.commit()

        history = await self.repo.list_moderation_history(submission_id)
        should_delete = bool(
            storage_path and not any(h.SourceStoragePath == storage_path for h in history)
        )
        await self.repo.rollback()
        if should_delete and storage_path:
            try:
                await asyncio.to_thread(delete_object, storage_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET)
            except Exception:
                pass
        return {"status": "cancelled", "submission_id": str(submission_id)}

    async def get_submission_ocr_job_status(
        self, actor_id: UUID, book_id: UUID, submission_id: UUID
    ) -> dict[str, object]:
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        sub = await self.repo.get_owned_submission(book_id, submission_id, actor_id)
        if sub is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        job_svc = OcrInferenceJobService(self.db)
        job = await job_svc.repo.latest_for_submission(submission_id)
        if job is None:
            return {
                "submission_id": str(submission_id),
                "ocr_status": sub.OcrStatus,
                "workflow_status": sub.WorkflowStatus,
                "job": None,
            }
        return {
            "submission_id": str(submission_id),
            "ocr_status": sub.OcrStatus,
            "workflow_status": sub.WorkflowStatus,
            "job": OcrInferenceJobService.serialize_job(job),
        }

    # ------------------------------------------------------------------
    # Parent -> Admin Review Escalation
    # ------------------------------------------------------------------
    async def request_admin_review(
        self,
        actor_id: UUID,
        book_id: UUID,
        submission_id: UUID,
        payload: ParentRequestAdminReviewRequest,
        *,
        base_url: str | None = None,
    ) -> ParentPageSubmissionRead:
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.ModerationStatus != MODERATION_ACTIVE or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.")

        sub = await self.repo.get_owned_submission(book_id, submission_id, actor_id, lock=True)
        if sub is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        if (
            int(sub.SubmissionVersion) != payload.expected_submission_version
            or sub.CandidateHash != payload.expected_candidate_hash
        ):
            raise HTTPException(
                status_code=409,
                detail="Phiên bản trang không khớp snapshot hiện tại. Hãy tải lại trước khi gửi Admin.",
            )
        if sub.WorkflowStatus == "PENDING_ADMIN":
            # Idempotent if already awaiting Admin on exact same snapshot
            dto = await self._serialize_submission_async(book, sub, base_url=base_url)
            await self.repo.rollback()
            return dto
        if sub.WorkflowStatus != "NEEDS_ADMIN_REVIEW":
            raise HTTPException(
                status_code=409,
                detail="Chỉ trang đang ở trạng thái Cần Admin duyệt mới có thể gửi yêu cầu xem xét.",
            )
        if not sub.CandidateHash:
            raise HTTPException(status_code=409, detail="Trang chưa có snapshot hợp lệ để gửi Admin.")

        now = datetime.now(timezone.utc)
        effective_source_type = payload.source_type or sub.SourceType
        effective_source_note = (
            payload.source_note if payload.source_note is not None else sub.SourceNote
        )
        sub.SourceType = effective_source_type
        sub.SourceNote = effective_source_note
        sub.WorkflowStatus = "PENDING_ADMIN"
        sub.TempExpiresAt = now + timedelta(days=ADMIN_REVIEW_TTL_DAYS)
        sub.UpdatedAt = now

        mod_request = ParentBookModerationRequest(
            Id=uuid4(),
            BookId=book.Id,
            SubmissionId=sub.Id,
            OwnerParentId=actor_id,
            SubmissionVersion=int(sub.SubmissionVersion),
            SnapshotHash=sub.CandidateHash,
            SourceSha256=sub.SourceSha256,
            SourceStoragePath=sub.SourceStoragePath,
            OcrTextSnapshot=sub.OcrText,
            ProofreadTextSnapshot=sub.ProofreadText,
            CandidateTextSnapshot=sub.CandidateText,
            ToolCheckSnapshotJson={
                "tool_check_status": sub.ToolCheckStatus,
                "suitability": sub.ToolCheckSuitability,
                "scope": sub.ToolCheckScopeJson or {},
                "findings": sub.ToolCheckFindingsJson or [],
                "policy_blocked": bool(sub.ToolCheckPolicyBlocked),
                "workflow_id": str(sub.ToolCheckWorkflowId) if sub.ToolCheckWorkflowId else None,
            },
            ParentSourceType=effective_source_type,
            ParentSourceNote=effective_source_note,
            ParentRequestNote=payload.request_note,
            Status="PENDING_ADMIN",
            PolicyBlocked=bool(sub.ToolCheckPolicyBlocked),
            OptimisticLockVersion=1,
            CreatedAt=now,
            UpdatedAt=now,
        )
        await self.repo.add_moderation_request(mod_request)
        await self.repo.add_audit_log(
            actor_id=actor_id,
            action="parent_private_book.moderation.requested",
            resource_type="parent_book_submission",
            resource_id=sub.Id,
            metadata={
                "book_id": str(book.Id),
                "request_id": str(mod_request.Id),
                "submission_version": int(sub.SubmissionVersion),
                "snapshot_hash": sub.CandidateHash,
                "policy_blocked": bool(sub.ToolCheckPolicyBlocked),
            },
        )
        await self.repo.commit()
        await self.db.refresh(sub)
        return await self._serialize_submission_async(book, sub, base_url=base_url)

    # ------------------------------------------------------------------
    # Transactional Add Page to Private Book Gate (Section 3.8)
    # ------------------------------------------------------------------
    async def add_page_to_book(
        self,
        actor_id: UUID,
        book_id: UUID,
        submission_id: UUID,
        payload: ParentAddPageRequest,
        *,
        base_url: str | None = None,
    ) -> ParentAddPageResponse:
        """Atomically verify ownership, stage results, exact hash/version, and approval before adding page."""
        await self._require_parent(actor_id)

        async def _validate_add_preconditions(
            book_row: Book, sub_row: ParentBookPageSubmission, *, mutate_accept: bool
        ) -> tuple[UUID, str, str, list[dict[str, Any]]]:
            if (
                int(sub_row.SubmissionVersion) != payload.expected_submission_version
                or not sub_row.CandidateHash
                or sub_row.CandidateHash != payload.expected_candidate_hash
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Phiên bản hoặc hash của trang không khớp kết quả kiểm tra hiện hành.",
                )
            if sub_row.ToolCheckPolicyBlocked:
                raise HTTPException(
                    status_code=409,
                    detail="Trang có nội dung vi phạm mức chặn theo chính sách an toàn trẻ em nên không thể thêm vào sách.",
                )

            verified_actor: UUID = actor_id
            mode: str = "PARENT_CLEAN_TOOL_CHECK"
            if sub_row.WorkflowStatus == "PASSED_READY_TO_ADD":
                if (
                    sub_row.OcrStatus != "COMPLETED"
                    or sub_row.ProofreadStatus != "COMPLETED"
                    or sub_row.ToolCheckStatus != "PASSED"
                    or sub_row.ToolCheckInputHash != sub_row.CandidateHash
                    or sub_row.ToolCheckSuitability != "SUITABLE"
                    or len(sub_row.ToolCheckFindingsJson or []) > 0
                    or sub_row.IsImageOnly
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="Trang chưa hoàn tất nhận diện chữ, rà chính tả và kiểm tra an toàn nội dung cho đúng phiên bản hiện tại.",
                    )
                if (sub_row.ProofreadSuggestionsJson or []) and sub_row.SpellingAcceptedAt is None:
                    if payload.accept_spelling:
                        if mutate_accept:
                            sub_row.SpellingAcceptedAt = datetime.now(timezone.utc)
                    else:
                        raise HTTPException(
                            status_code=409,
                            detail="Vui lòng xem và chấp nhận đề xuất chính tả trước khi thêm trang vào sách.",
                        )
            elif sub_row.WorkflowStatus == "APPROVED_READY_TO_ADD":
                if (
                    sub_row.ApprovedBy is None
                    or sub_row.ApprovedAt is None
                    or sub_row.AdminDecision != "APPROVE"
                    or sub_row.ApprovedSnapshotHash != sub_row.CandidateHash
                    or sub_row.ApprovedSubmissionVersion != sub_row.SubmissionVersion
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="Phê duyệt của Admin không khớp đúng phiên bản/hash hiện tại của trang.",
                    )
                approved_req = await self.repo.get_matching_approved_request(
                    sub_row.Id, int(sub_row.SubmissionVersion), sub_row.CandidateHash
                )
                if approved_req is None:
                    raise HTTPException(
                        status_code=409,
                        detail="Không tìm thấy quyết định phê duyệt hợp lệ của Admin cho đúng phiên bản này.",
                    )
                verified_actor = sub_row.ApprovedBy
                mode = "ADMIN_APPROVED_REVISION"
            else:
                raise HTTPException(
                    status_code=409,
                    detail="Trang đang chờ kiểm tra, bị gắn cờ hoặc chưa được Admin phê duyệt nên không thể thêm vào sách.",
                )

            v_text = (sub_row.CandidateText or "").strip()
            r_words = list(sub_row.CandidateWordsJson or [])
            if not v_text and sub_row.IsImageOnly and mode == "ADMIN_APPROVED_REVISION":
                v_text = "Trang minh họa"
                r_words = [
                    {
                        "word_index": 0,
                        "line_index": 0,
                        "text": "Trang",
                        "normalized_text": "trang",
                        "bounding_box": [0.08, 0.08, 0.25, 0.06],
                        "ocr_confidence": None,
                    },
                    {
                        "word_index": 1,
                        "line_index": 0,
                        "text": "minh",
                        "normalized_text": "minh",
                        "bounding_box": [0.35, 0.08, 0.22, 0.06],
                        "ocr_confidence": None,
                    },
                    {
                        "word_index": 2,
                        "line_index": 0,
                        "text": "họa",
                        "normalized_text": "họa",
                        "bounding_box": [0.59, 0.08, 0.22, 0.06],
                        "ocr_confidence": None,
                    },
                ]
            if not v_text:
                raise HTTPException(status_code=409, detail="Trang không có văn bản hợp lệ để thêm vào sách.")
            if not r_words:
                r_words = align_edited_text_to_words(v_text, list(sub_row.OcrWordsJson or []))
            if not r_words:
                raise HTTPException(status_code=409, detail="Trang không có dữ liệu từ và tọa độ hợp lệ.")
            return verified_actor, mode, v_text, r_words

        # Phase 1: Unlocked pre-check & snapshot before releasing DB transaction for Storage I/O
        book_snap = await self.repo.get_owned_private_book(book_id, actor_id)
        if book_snap is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book_snap.ModerationStatus != MODERATION_ACTIVE or book_snap.LifecycleStatus != "ACTIVE":
            raise HTTPException(
                status_code=409,
                detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động nên không thể thêm trang.",
            )
        sub_snap = await self.repo.get_owned_submission(book_id, submission_id, actor_id)
        if sub_snap is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        if sub_snap.WorkflowStatus == "ADDED_TO_BOOK" and sub_snap.CommittedPageId and sub_snap.CommittedRevisionId:
            committed_page_id = sub_snap.CommittedPageId
            committed_rev_id = sub_snap.CommittedRevisionId
            existing_page = await self.repo.get_committed_page(book_id, committed_page_id)
            page_number = int(existing_page[0].PageNumber) if existing_page else 1
            readable = await self.repo.is_private_book_readable(book_id, actor_id)
            serialized_sub = await self._serialize_submission_async(
                book_snap, sub_snap, base_url=base_url
            )
            return ParentAddPageResponse(
                book_id=book_id,
                page_id=committed_page_id,
                page_number=page_number,
                revision_id=committed_rev_id,
                submission=serialized_sub,
                book_readable_for_children=readable,
            )

        await _validate_add_preconditions(book_snap, sub_snap, mutate_accept=False)
        staging_path = str(sub_snap.SourceStoragePath)
        ext = "jpg" if staging_path.lower().endswith((".jpg", ".jpeg")) else (
            "webp" if staging_path.lower().endswith(".webp") else "png"
        )
        await self.repo.rollback()

        # Phase 2: Copy staging object to committed object OUTSIDE any DB transaction/locks
        page_id = uuid4()
        permanent_path = f"private-books/{actor_id}/{book_id}/pages/{page_id}/rev-1.{ext}"
        uploaded_permanent = False
        image_bytes: bytes = b""
        try:
            image_bytes = await asyncio.to_thread(
                download_object, staging_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
            )
            await asyncio.to_thread(
                upload_object,
                permanent_path,
                image_bytes,
                _safe_media_type(permanent_path),
                bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                upsert=False,
            )
            uploaded_permanent = True

            # Phase 3: Acquire canonical Book -> Submission locks and commit atomically
            book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
            if book is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            if book.ModerationStatus != MODERATION_ACTIVE or book.LifecycleStatus != "ACTIVE":
                raise HTTPException(
                    status_code=409,
                    detail="Sách riêng đang bị đình chỉ hoặc ngừng hoạt động nên không thể thêm trang.",
                )
            sub = await self.repo.get_owned_submission(book_id, submission_id, actor_id, lock=True)
            if sub is None:
                raise HTTPException(status_code=404, detail="Resource not found")

            if sub.WorkflowStatus == "ADDED_TO_BOOK" and sub.CommittedPageId and sub.CommittedRevisionId:
                committed_page_id = sub.CommittedPageId
                committed_rev_id = sub.CommittedRevisionId
                existing_page = await self.repo.get_committed_page(book_id, committed_page_id)
                page_number = int(existing_page[0].PageNumber) if existing_page else 1
                readable = await self.repo.is_private_book_readable(book_id, actor_id)
                serialized_sub = await self._serialize_submission_async(
                    book, sub, base_url=base_url
                )
                idempotent_resp = ParentAddPageResponse(
                    book_id=book_id,
                    page_id=committed_page_id,
                    page_number=page_number,
                    revision_id=committed_rev_id,
                    submission=serialized_sub,
                    book_readable_for_children=readable,
                )
                await self.repo.rollback()
                if uploaded_permanent:
                    try:
                        await asyncio.to_thread(
                            delete_object, permanent_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
                        )
                    except Exception:
                        pass
                return idempotent_resp

            if str(sub.SourceStoragePath) != staging_path:
                raise HTTPException(
                    status_code=409,
                    detail="Ảnh nguồn của trang vừa thay đổi. Vui lòng tải lại và thử lại.",
                )

            verified_by_actor, approval_mode, verified_text, raw_words = (
                await _validate_add_preconditions(book, sub, mutate_accept=True)
            )

            # Allocate page number under Book lock
            requested_page_num = payload.target_page_number or sub.TargetPageNumber
            if requested_page_num is not None:
                if await self.repo.page_number_exists(book_id, requested_page_num):
                    page_number = (await self.repo.max_page_number(book_id)) + 1
                else:
                    page_number = requested_page_num
            else:
                page_number = (await self.repo.max_page_number(book_id)) + 1
            if page_number < 1 or page_number > 32767:
                raise HTTPException(
                    status_code=409,
                    detail="Số trang đã vượt quá giới hạn tối đa cho một cuốn sách (32767).",
                )

            now = datetime.now(timezone.utc)
            page_row = BookPage(
                Id=page_id,
                BookId=book.Id,
                PageNumber=page_number,
                ImagePath=permanent_path,
                Width=min(32767, int(sub.ImageWidth)),
                Height=min(32767, int(sub.ImageHeight)),
                ProcessingMeta={
                    "parent_private_book": True,
                    "parent_submission_id": str(sub.Id),
                    "parent_submission_batch_id": str(sub.BatchId),
                    "parent_submission_batch_total": int(sub.BatchTotalPages),
                    "approval_mode": approval_mode,
                    "snapshot_hash": sub.CandidateHash,
                },
                LifecycleStatus="ACTIVE",
                CreatedAt=now,
            )
            revision_row = PageRevision(
                Id=uuid4(),
                RevisionNo="1",
                VerificationStatus="VERIFIED",
                OriginalOcrText=sub.OcrText or "",
                VerifiedText=verified_text,
                DraftText=verified_text,
                ContentHash=sub.CandidateHash,
                ProcessingMeta={
                    "source_image_path": permanent_path,
                    "source_image_width": int(sub.ImageWidth),
                    "source_image_height": int(sub.ImageHeight),
                    "parent_submission_id": str(sub.Id),
                    "parent_submission_version": int(sub.SubmissionVersion),
                    "approval_mode": approval_mode,
                    "tool_check_workflow_id": str(sub.ToolCheckWorkflowId) if sub.ToolCheckWorkflowId else None,
                },
                VerifiedBy=verified_by_actor,
                VerifiedAt=now,
                CreatedAt=now,
            )
            word_rows = [
                PageRevisionWord(
                    Id=uuid4(),
                    WordIndex=int(idx),
                    LineIndex=max(0, int(item.get("line_index", 0) or 0)),
                    Text=str(item["text"]),
                    NormalizedText=str(item.get("normalized_text") or normalize_word(str(item["text"])) or str(item["text"]).lower()),
                    BoundingBox=_coerce_word_bounding_box(item, idx, len(raw_words)),
                    OCRConfidence=item.get("ocr_confidence"),
                )
                for idx, item in enumerate(raw_words)
            ]
            created_page, created_rev = await self.repo.create_committed_page(
                page=page_row, revision=revision_row, words=word_rows
            )
            sub.WorkflowStatus = "ADDED_TO_BOOK"
            sub.CommittedPageId = created_page.Id
            sub.CommittedRevisionId = created_rev.Id
            sub.CommittedAt = now
            sub.OptimisticLockVersion = int(sub.OptimisticLockVersion) + 1
            sub.UpdatedAt = now

            await self.repo.add_audit_log(
                actor_id=actor_id,
                action="parent_private_book.page.added",
                resource_type="book_page",
                resource_id=created_page.Id,
                metadata={
                    "book_id": str(book.Id),
                    "submission_id": str(sub.Id),
                    "submission_version": int(sub.SubmissionVersion),
                    "snapshot_hash": sub.CandidateHash,
                    "approval_mode": approval_mode,
                    "page_number": page_number,
                },
            )
            committed_book_id = book.Id
            committed_page_id = created_page.Id
            committed_rev_id = created_rev.Id
            await self.repo.commit()
        except Exception:
            await self.repo.rollback()
            if uploaded_permanent:
                try:
                    await asyncio.to_thread(delete_object, permanent_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET)
                except Exception:
                    pass
            raise

        # Non-fatal V2 post-commit hook: persist PageOcrExtraction + extract clean artwork
        try:
            from app.services.ocr_content_extraction import persist_committed_parent_page_v2

            await persist_committed_parent_page_v2(
                self.db,
                actor_id=actor_id,
                book_id=book.Id,
                page_id=created_page.Id,
                revision_id=created_rev.Id,
                submission=sub,
                image_bytes=image_bytes,
                trigger_illustration_extract=True,
            )
        except Exception:
            logger.warning(
                "Non-fatal Smart Book Studio V2 post-commit hook skipped for page %s",
                created_page.Id,
            )

        await self.db.refresh(sub)
        await self._refresh_after_commit(book, created_page, created_rev)
        # Phase 4: Recruit Flow 2 line candidates AFTER releasing Book/Submission locks (reusing in-memory image bytes)
        await self._safe_recruit_flow2_page(
            book=book,
            page=created_page,
            revision=created_rev,
            submission=sub,
            image_bytes=image_bytes,
            commit=True,
        )
        # Re-hydrate book & sub in case best-effort Flow 2 recruitment rolled back the session (which expires all instances).
        await self._refresh_after_commit(book, sub)
        readable = await self.repo.is_private_book_readable(committed_book_id, actor_id)
        serialized_sub = await self._serialize_submission_async(book, sub, base_url=base_url)
        return ParentAddPageResponse(
            book_id=committed_book_id,
            page_id=committed_page_id,
            page_number=page_number,
            revision_id=committed_rev_id,
            submission=serialized_sub,
            book_readable_for_children=readable,
        )

    # ------------------------------------------------------------------
    # Authenticated Private Media Streaming (Owner Parent & Admin)
    # ------------------------------------------------------------------
    async def read_owner_page_image(
        self,
        actor_id: UUID,
        book_id: UUID,
        page_id: UUID,
        *,
        revision_id: UUID | None = None,
    ) -> tuple[bytes, str]:
        """Verify owner parent + ACTIVE + non-suspended book on EVERY request."""
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.ModerationStatus != MODERATION_ACTIVE or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(
                status_code=403,
                detail="Sách riêng đang bị đình chỉ hoặc không còn khả dụng.",
            )
        if not await self.repo.is_private_book_readable(book_id, actor_id):
            raise HTTPException(status_code=404, detail="Resource not found")

        row = await self.repo.get_committed_page(book_id, page_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        page, current_rev = row
        storage_path = page.ImagePath
        if revision_id is not None:
            rev = await self.repo.get_page_revision(page.Id, revision_id)
            if rev is None or rev.VerificationStatus != "VERIFIED":
                raise HTTPException(status_code=404, detail="Resource not found")
            meta = rev.ProcessingMeta if isinstance(rev.ProcessingMeta, dict) else {}
            if isinstance(meta.get("source_image_path"), str) and meta["source_image_path"].strip():
                storage_path = meta["source_image_path"].strip()
        elif current_rev is None or current_rev.VerificationStatus != "VERIFIED":
            raise HTTPException(status_code=404, detail="Resource not found")

        await self.repo.rollback()
        data = await asyncio.to_thread(
            download_object, storage_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
        )
        return data, _safe_media_type(storage_path)

    async def read_owner_submission_image(
        self, actor_id: UUID, book_id: UUID, submission_id: UUID
    ) -> tuple[bytes, str]:
        """Verify active owner parent + ACTIVE non-suspended book on EVERY request."""
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None or bool(getattr(book, "IsDeleted", False)):
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.ModerationStatus != MODERATION_ACTIVE or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(
                status_code=403,
                detail="Sách riêng đang bị đình chỉ hoặc không còn khả dụng.",
            )
        sub = await self.repo.get_owned_submission(book_id, submission_id, actor_id)
        if sub is None or sub.WorkflowStatus == "CANCELLED":
            raise HTTPException(status_code=404, detail="Resource not found")
        storage_path = sub.SourceStoragePath
        await self.repo.rollback()
        data = await asyncio.to_thread(
            download_object, storage_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
        )
        return data, _safe_media_type(storage_path)

    # ------------------------------------------------------------------
    # Admin "Sách người dùng" Moderation (inside /admin/metadata-quality)
    # ------------------------------------------------------------------
    @staticmethod
    def _classify_admin_queue_status(
        book: Book, subs: list[ParentBookPageSubmission]
    ) -> AdminUserBookQueueFilter | None:
        if book.ModerationStatus == MODERATION_SUSPENDED:
            return "SUSPENDED"
        if any(s.WorkflowStatus == "PENDING_ADMIN" for s in subs):
            return "PENDING_ADMIN"
        if any(s.WorkflowStatus == "NEEDS_ADMIN_REVIEW" for s in subs):
            return "FLAGGED"
        if any(s.WorkflowStatus == "CHECK_FAILED" for s in subs):
            return "CHECK_FAILED"
        if any(
            s.WorkflowStatus == "REJECTED"
            or (s.WorkflowStatus == "NEEDS_RECHECK" and s.AdminDecision == "REQUEST_CHANGES")
            for s in subs
        ):
            return "REJECTED"
        if any(
            s.WorkflowStatus == "APPROVED_READY_TO_ADD"
            or (s.WorkflowStatus == "ADDED_TO_BOOK" and s.ApprovedBy is not None)
            for s in subs
        ):
            return "APPROVED"
        return None

    async def admin_list_user_books(
        self,
        actor_id: UUID,
        *,
        status_filter: AdminUserBookQueueFilter | None = None,
        search: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> AdminUserBookQueuePageRead:
        await self._require_admin(actor_id)
        books = await self.repo.list_all_private_books_for_admin(search=search)
        if not books:
            return AdminUserBookQueuePageRead(
                items=[],
                total=0,
                limit=limit,
                offset=offset,
                summary={
                    "PENDING_ADMIN": 0,
                    "FLAGGED": 0,
                    "CHECK_FAILED": 0,
                    "APPROVED": 0,
                    "REJECTED": 0,
                    "SUSPENDED": 0,
                },
            )

        book_ids = [b.Id for b in books]
        owner_ids = [b.OwnerParentId for b in books if b.OwnerParentId is not None]
        owner_labels = await self.repo.profile_display_map(owner_ids)
        committed_map = await self.repo.committed_page_counts(book_ids)
        all_subs = await self.repo.list_submissions_for_books(book_ids)
        subs_by_book: dict[UUID, list[ParentBookPageSubmission]] = {}
        for sub in all_subs:
            subs_by_book.setdefault(sub.BookId, []).append(sub)

        summary = {
            "PENDING_ADMIN": 0,
            "FLAGGED": 0,
            "CHECK_FAILED": 0,
            "APPROVED": 0,
            "REJECTED": 0,
            "SUSPENDED": 0,
        }
        priority_order = {
            "PENDING_ADMIN": 0,
            "NEEDS_ADMIN_REVIEW": 1,
            "CHECK_FAILED": 2,
            "REJECTED": 3,
            "NEEDS_RECHECK": 4,
            "APPROVED_READY_TO_ADD": 5,
            "ADDED_TO_BOOK": 6,
            "PASSED_READY_TO_ADD": 7,
            "CHECKING": 8,
        }
        selected_rows: list[tuple[Book, list[ParentBookPageSubmission], str, ParentBookPageSubmission | None]] = []
        primary_sub_ids: list[UUID] = []
        for book in books:
            subs = subs_by_book.get(book.Id, [])
            q_status = self._classify_admin_queue_status(book, subs)
            if q_status is None:
                continue
            summary[q_status] += 1
            if status_filter is not None and q_status != status_filter:
                continue

            sorted_subs = sorted(
                subs,
                key=lambda s: (priority_order.get(s.WorkflowStatus, 9), -s.UpdatedAt.timestamp()),
            )
            primary_sub = sorted_subs[0] if sorted_subs else None
            if primary_sub is not None:
                primary_sub_ids.append(primary_sub.Id)
            selected_rows.append((book, subs, q_status, primary_sub))

        open_req_by_sub: dict[UUID, ParentBookModerationRequest] = {}
        if primary_sub_ids and isinstance(getattr(self, "db", None), AsyncSession):
            req_rows = await self.db.execute(
                select(ParentBookModerationRequest)
                .where(
                    ParentBookModerationRequest.SubmissionId.in_(primary_sub_ids),
                    ParentBookModerationRequest.Status == "PENDING_ADMIN",
                )
                .order_by(
                    ParentBookModerationRequest.SubmissionId,
                    ParentBookModerationRequest.CreatedAt.desc(),
                    ParentBookModerationRequest.Id.desc(),
                )
            )
            for req in req_rows.scalars().all():
                open_req_by_sub.setdefault(req.SubmissionId, req)

        queue_items: list[AdminUserBookQueueItemRead] = []
        for book, subs, q_status, primary_sub in selected_rows:
            if primary_sub is None:
                latest_req = None
            elif isinstance(getattr(self, "db", None), AsyncSession):
                latest_req = open_req_by_sub.get(primary_sub.Id)
            else:
                latest_req = await self.repo.get_open_moderation_request(primary_sub.Id)
            queue_items.append(
                AdminUserBookQueueItemRead(
                    book_id=book.Id,
                    book_title=book.Title,
                    book_author=book.Author,
                    owner_label=owner_labels.get(book.OwnerParentId, "Phụ huynh") if book.OwnerParentId else "Phụ huynh",
                    moderation_status=book.ModerationStatus,  # type: ignore[arg-type]
                    queue_status=q_status,
                    pending_count=sum(1 for s in subs if s.WorkflowStatus == "PENDING_ADMIN"),
                    flagged_count=sum(1 for s in subs if s.WorkflowStatus in ("NEEDS_ADMIN_REVIEW", "PENDING_ADMIN") and (s.ToolCheckFindingsJson or s.IsImageOnly)),
                    failed_count=sum(1 for s in subs if s.WorkflowStatus == "CHECK_FAILED"),
                    committed_page_count=committed_map.get(book.Id, 0),
                    latest_submission_id=primary_sub.Id if primary_sub else None,
                    latest_request_id=latest_req.Id if latest_req else None,
                    latest_submission_version=int(primary_sub.SubmissionVersion) if primary_sub else None,
                    latest_submitted_at=primary_sub.UpdatedAt if primary_sub else book.CreatedAt,
                    policy_blocked=any(bool(s.ToolCheckPolicyBlocked) for s in subs),
                )
            )

        queue_items.sort(key=lambda item: item.latest_submitted_at, reverse=True)
        total = len(queue_items)
        return AdminUserBookQueuePageRead(
            items=queue_items[offset : offset + limit],
            total=total,
            limit=limit,
            offset=offset,
            summary=summary,
        )

    @staticmethod
    def _is_submission_in_admin_moderation_scope(
        book: Book,
        sub: ParentBookPageSubmission,
        history_rows: list[ParentBookModerationRequest],
    ) -> bool:
        if book.ModerationStatus == MODERATION_SUSPENDED:
            return True
        if history_rows:
            return True
        if sub.ApprovedBy is not None or sub.AdminDecision is not None:
            return True
        return sub.WorkflowStatus in (
            "PENDING_ADMIN",
            "NEEDS_ADMIN_REVIEW",
            "CHECK_FAILED",
            "REJECTED",
            "APPROVED_READY_TO_ADD",
        )

    async def admin_get_submission_detail(
        self,
        actor_id: UUID,
        submission_id: UUID,
        *,
        base_url: str | None = None,
    ) -> AdminUserBookSubmissionDetailRead:
        await self._require_admin(actor_id)
        sub = await self.repo.get_submission(submission_id)
        if sub is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        book = await self.repo.get_private_book(sub.BookId)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        history_rows = await self.repo.list_moderation_history(sub.Id)
        if not self._is_submission_in_admin_moderation_scope(book, sub, history_rows):
            raise HTTPException(status_code=404, detail="Resource not found")
        open_req = next((r for r in history_rows if r.Status == "PENDING_ADMIN"), None)
        latest_req = open_req or (history_rows[0] if history_rows else None)

        profile_ids = [sub.OwnerParentId] + [
            r.DecidedBy for r in history_rows if r.DecidedBy is not None
        ]
        labels = await self.repo.profile_display_map(profile_ids)

        # Record minimal audit log for Admin inspecting private parent book content (no full text/PII)
        await self.repo.add_audit_log(
            actor_id=actor_id,
            action="parent_private_book.submission.viewed",
            resource_type="parent_book_submission",
            resource_id=sub.Id,
            metadata={
                "book_id": str(book.Id),
                "submission_version": int(sub.SubmissionVersion),
                "workflow_status": sub.WorkflowStatus,
            },
        )
        await self.repo.commit()

        can_approve = True
        approve_blocked_reason: str | None = None
        if book.ModerationStatus == MODERATION_SUSPENDED:
            can_approve = False
            approve_blocked_reason = "Sách riêng đang ở trạng thái đình chỉ."
        elif sub.ToolCheckPolicyBlocked:
            can_approve = False
            approve_blocked_reason = (
                "Nội dung vi phạm mức chặn theo chính sách an toàn trẻ em (HIGH / NOT_RECOMMENDED). "
                "Admin không thể duyệt bỏ qua; phải yêu cầu chỉnh sửa hoặc từ chối."
            )
        elif sub.WorkflowStatus not in ("PENDING_ADMIN", "NEEDS_ADMIN_REVIEW"):
            can_approve = False
            approve_blocked_reason = "Phiên bản trang hiện không ở trạng thái chờ Admin duyệt."
        elif not sub.CandidateHash:
            can_approve = False
            approve_blocked_reason = "Trang chưa có snapshot hash hợp lệ."

        findings_dto = [
            ToolCheckFindingRead.model_validate(item)
            for item in (sub.ToolCheckFindingsJson or [])
            if isinstance(item, dict)
        ]

        sub_id_val = sub.Id
        sub_storage_path = sub.SourceStoragePath
        detail_dto = AdminUserBookSubmissionDetailRead(
            submission_id=sub.Id,
            request_id=latest_req.Id if latest_req else None,
            book_id=book.Id,
            book_title=book.Title,
            book_author=book.Author,
            book_moderation_status=book.ModerationStatus,  # type: ignore[arg-type]
            book_suspended_reason=book.SuspendedReason,
            owner_label=labels.get(sub.OwnerParentId, "Phụ huynh"),
            source_file_name=sub.SourceFileName,
            source_format=sub.SourceFormat,
            source_page_number=int(sub.SourcePageNumber),
            batch_total_pages=int(sub.BatchTotalPages),
            submission_version=int(sub.SubmissionVersion),
            optimistic_lock_version=int(sub.OptimisticLockVersion),
            snapshot_hash=sub.CandidateHash,
            source_sha256=sub.SourceSha256,
            image_width=int(sub.ImageWidth),
            image_height=int(sub.ImageHeight),
            image_url="",
            workflow_status=sub.WorkflowStatus,  # type: ignore[arg-type]
            workflow_status_label=WORKFLOW_STATUS_LABELS.get(sub.WorkflowStatus, sub.WorkflowStatus),
            request_status=latest_req.Status if latest_req else None,
            ocr_status=sub.OcrStatus,
            ocr_text=sub.OcrText,
            ocr_error_code=sub.OcrErrorCode,
            is_image_only=bool(sub.IsImageOnly),
            proofread_status=sub.ProofreadStatus,
            proofread_text=sub.ProofreadText,
            proofread_suggestions=_build_suggestions(sub.ProofreadSuggestionsJson),
            uncertain_word_indices=[int(i) for i in (sub.UncertainWordIndicesJson or []) if isinstance(i, int)],
            proofread_error_code=sub.ProofreadErrorCode,
            candidate_text=sub.CandidateText,
            tool_check_status=sub.ToolCheckStatus,
            tool_check_suitability=sub.ToolCheckSuitability,
            tool_check_scope=_build_scope(sub.ToolCheckScopeJson),
            tool_check_findings=findings_dto,
            tool_check_policy_blocked=bool(sub.ToolCheckPolicyBlocked),
            tool_check_error_code=sub.ToolCheckErrorCode,
            tool_check_workflow_id=sub.ToolCheckWorkflowId,
            provider_events=_build_provider_events(sub),
            source_type=sub.SourceType,  # type: ignore[arg-type]
            source_type_label=SOURCE_TYPE_LABELS.get(sub.SourceType, sub.SourceType),
            source_note=sub.SourceNote,
            parent_request_note=latest_req.ParentRequestNote if latest_req else None,
            can_approve=can_approve,
            approve_blocked_reason=approve_blocked_reason,
            approved_snapshot_hash=sub.ApprovedSnapshotHash,
            approved_submission_version=sub.ApprovedSubmissionVersion,
            admin_decision=sub.AdminDecision,
            admin_decision_reason=sub.AdminDecisionReason,
            history=[
                AdminModerationHistoryItemRead(
                    request_id=h.Id,
                    submission_version=int(h.SubmissionVersion),
                    snapshot_hash=h.SnapshotHash,
                    status=h.Status,
                    previous_status=h.PreviousStatus,
                    parent_source_type=h.ParentSourceType,
                    parent_source_note=h.ParentSourceNote,
                    parent_request_note=h.ParentRequestNote,
                    decision_reason=h.DecisionReason,
                    decided_by_label=labels.get(h.DecidedBy) if h.DecidedBy else None,
                    decided_at=h.DecidedAt,
                    created_at=h.CreatedAt,
                )
                for h in history_rows
            ],
            created_at=sub.CreatedAt,
            updated_at=sub.UpdatedAt,
        )
        rollback_fn = getattr(self.repo, "rollback", None)
        if inspect.iscoroutinefunction(rollback_fn):
            await rollback_fn()
        if admin_submission_image_url is not _ORIGINAL_ADMIN_SUBMISSION_IMAGE_URL:
            resolved_url = await asyncio.to_thread(
                admin_submission_image_url,
                sub_id_val,
                base_url=base_url,
                storage_path=sub_storage_path,
            )
        else:
            resolved_url = await admin_submission_image_url_async(
                sub_id_val,
                base_url=base_url,
                storage_path=sub_storage_path,
            )
        return detail_dto.model_copy(update={"image_url": resolved_url})

    async def admin_read_submission_image(
        self, actor_id: UUID, submission_id: UUID
    ) -> tuple[bytes, str]:
        await self._require_admin(actor_id)
        sub = await self.repo.get_submission(submission_id)
        if sub is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        book = await self.repo.get_private_book(sub.BookId)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        history_rows = await self.repo.list_moderation_history(sub.Id)
        if not self._is_submission_in_admin_moderation_scope(book, sub, history_rows):
            raise HTTPException(status_code=404, detail="Resource not found")
        storage_path = sub.SourceStoragePath
        await self.repo.add_audit_log(
            actor_id=actor_id,
            action="parent_private_book.media.viewed",
            resource_type="parent_book_submission",
            resource_id=sub.Id,
            metadata={"book_id": str(sub.BookId), "submission_version": int(sub.SubmissionVersion)},
        )
        await self.repo.commit()
        data = await asyncio.to_thread(
            download_object, storage_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
        )
        return data, _safe_media_type(storage_path)

    async def _apply_book_suspension(
        self,
        *,
        book: Book,
        actor_id: UUID,
        reason: str,
        now: datetime,
        exclude_submission_id: UUID | None = None,
    ) -> None:
        """Apply full book-wide suspension consistently across both /suspend and /decision(SUSPEND)."""
        book.ModerationStatus = MODERATION_SUSPENDED
        book.SuspendedAt = now
        book.SuspendedBy = actor_id
        book.SuspendedReason = reason

        locked_subs = await self.repo.list_submissions_for_book(book.Id, lock=True)
        for sibling in locked_subs:
            if exclude_submission_id is not None and sibling.Id == exclude_submission_id:
                continue
            sibling.WorkerId = None
            sibling.LeaseExpiresAt = None
            sibling.RetryAfter = None
            sibling.ApprovedSnapshotHash = None
            sibling.ApprovedSubmissionVersion = None
            sibling.ApprovedBy = None
            sibling.ApprovedAt = None
            if sibling.WorkflowStatus not in ("ADDED_TO_BOOK", "CANCELLED"):
                sibling.WorkflowStatus = "REJECTED"
                sibling.AdminDecision = "SUSPEND"
                sibling.AdminDecisionReason = reason
                sibling.OptimisticLockVersion = int(sibling.OptimisticLockVersion) + 1
                sibling.UpdatedAt = now

        await self.repo.suspend_open_moderation_requests_for_book(
            book.Id, actor_id, reason, now
        )
        await self._safe_revoke_flow2_contributions(
            book=book,
            actor_id=actor_id,
            reason=reason,
            consent_event_action="REVOKE_BOOK_SUSPENDED",
        )
        if is_remote_ocr_mode() and isinstance(self.db, AsyncSession):
            await OcrInferenceJobService(self.db).cancel_for_book(book.Id, reason="BOOK_SUSPENDED")

    async def admin_decide_submission(
        self,
        actor_id: UUID,
        submission_id: UUID,
        payload: AdminUserBookDecisionRequest,
    ) -> AdminUserBookDecisionResponse:
        """Apply Admin moderation decision with optimistic lock, snapshot binding, and policy enforcement."""
        await self._require_admin(actor_id)
        # Canonical lock order: Book -> Submission (prevents AB-BA deadlock with parent routes).
        # Query only the scalar BookId before locking so the Submission row is never cached stale in the identity map.
        get_book_id_fn = getattr(self.repo, "get_submission_book_id", None)
        if inspect.iscoroutinefunction(get_book_id_fn):
            preview_book_id = await get_book_id_fn(submission_id)
        else:
            sub_preview = await self.repo.get_submission(submission_id)
            preview_book_id = sub_preview.BookId if sub_preview is not None else None
        if preview_book_id is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        book = await self.repo.get_private_book(preview_book_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        sub = await self.repo.get_submission(submission_id, lock=True)
        if sub is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        history_rows = await self.repo.list_moderation_history(sub.Id)
        if not self._is_submission_in_admin_moderation_scope(book, sub, history_rows):
            raise HTTPException(status_code=404, detail="Resource not found")

        # Prevent concurrent overwrites or stale-revision decisions
        if (
            int(sub.OptimisticLockVersion) != payload.expected_lock_version
            or int(sub.SubmissionVersion) != payload.expected_submission_version
            or sub.CandidateHash != payload.expected_snapshot_hash
        ):
            raise HTTPException(
                status_code=409,
                detail="Phiên bản trang đã thay đổi hoặc vừa được Admin khác xử lý. Hãy tải lại dữ liệu trước khi quyết định.",
            )

        if sub.WorkflowStatus == "CANCELLED":
            raise HTTPException(
                status_code=409,
                detail="Bản nộp trang này đã bị hủy nên không thể ra quyết định duyệt.",
            )
        if sub.WorkflowStatus == "ADDED_TO_BOOK" and payload.decision != "SUSPEND":
            raise HTTPException(
                status_code=409,
                detail="Trang đã được thêm vào sách riêng; không thể đổi sang trạng thái từ chối hoặc yêu cầu sửa đơn lẻ (hãy dùng quyết định Đình chỉ sách nếu phát hiện vi phạm).",
            )

        if payload.decision == "APPROVE":
            if book.ModerationStatus == MODERATION_SUSPENDED:
                raise HTTPException(
                    status_code=409,
                    detail="Không thể phê duyệt trang của sách đang bị đình chỉ.",
                )
            if sub.ToolCheckPolicyBlocked:
                raise HTTPException(
                    status_code=409,
                    detail="Nội dung vi phạm mức chặn theo chính sách an toàn trẻ em không thể duyệt trực tiếp; phải yêu cầu chỉnh sửa hoặc từ chối.",
                )
            if sub.WorkflowStatus not in ("PENDING_ADMIN", "NEEDS_ADMIN_REVIEW"):
                raise HTTPException(
                    status_code=409,
                    detail="Trang hiện không ở trạng thái chờ Admin phê duyệt.",
                )

        open_req = await self.repo.get_open_moderation_request(sub.Id, lock=True)
        previous_status = sub.WorkflowStatus
        now = datetime.now(timezone.utc)

        if payload.decision == "APPROVE":
            sub.WorkflowStatus = "APPROVED_READY_TO_ADD"
            sub.ApprovedSnapshotHash = sub.CandidateHash
            sub.ApprovedSubmissionVersion = int(sub.SubmissionVersion)
            sub.ApprovedBy = actor_id
            sub.ApprovedAt = now
            sub.AdminDecision = "APPROVE"
            sub.AdminDecisionReason = payload.reason
            req_next_status = "APPROVED"
        elif payload.decision == "REQUEST_CHANGES":
            sub.WorkflowStatus = "NEEDS_RECHECK"
            sub.ApprovedSnapshotHash = None
            sub.ApprovedSubmissionVersion = None
            sub.ApprovedBy = None
            sub.ApprovedAt = None
            sub.AdminDecision = "REQUEST_CHANGES"
            sub.AdminDecisionReason = payload.reason
            req_next_status = "CHANGES_REQUESTED"
        elif payload.decision == "REJECT":
            sub.WorkflowStatus = "REJECTED"
            sub.ApprovedSnapshotHash = None
            sub.ApprovedSubmissionVersion = None
            sub.ApprovedBy = None
            sub.ApprovedAt = None
            sub.AdminDecision = "REJECT"
            sub.AdminDecisionReason = payload.reason
            req_next_status = "REJECTED"
        else:  # SUSPEND
            sub.WorkerId = None
            sub.LeaseExpiresAt = None
            sub.RetryAfter = None
            sub.ApprovedSnapshotHash = None
            sub.ApprovedSubmissionVersion = None
            sub.ApprovedBy = None
            sub.ApprovedAt = None
            sub.AdminDecision = "SUSPEND"
            sub.AdminDecisionReason = payload.reason
            if sub.WorkflowStatus != "ADDED_TO_BOOK":
                sub.WorkflowStatus = "REJECTED"
            req_next_status = "SUSPENDED"

        sub.OptimisticLockVersion = int(sub.OptimisticLockVersion) + 1
        sub.UpdatedAt = now

        if open_req is not None:
            open_req.PreviousStatus = open_req.Status
            open_req.Status = req_next_status
            open_req.DecidedBy = actor_id
            open_req.DecidedAt = now
            open_req.DecisionReason = payload.reason
            open_req.OptimisticLockVersion = int(open_req.OptimisticLockVersion) + 1
            open_req.UpdatedAt = now
            if payload.decision == "SUSPEND" and isinstance(self.db, AsyncSession):
                await self.db.flush([open_req])
        else:
            # Record an explicit moderation history row even when Admin acts proactively on a flagged/suspended book
            new_req = ParentBookModerationRequest(
                Id=uuid4(),
                BookId=book.Id,
                SubmissionId=sub.Id,
                OwnerParentId=sub.OwnerParentId,
                SubmissionVersion=int(sub.SubmissionVersion),
                SnapshotHash=sub.CandidateHash or sub.SourceSha256,
                SourceSha256=sub.SourceSha256,
                SourceStoragePath=sub.SourceStoragePath,
                OcrTextSnapshot=sub.OcrText,
                ProofreadTextSnapshot=sub.ProofreadText,
                CandidateTextSnapshot=sub.CandidateText,
                ToolCheckSnapshotJson={
                    "tool_check_status": sub.ToolCheckStatus,
                    "suitability": sub.ToolCheckSuitability,
                    "policy_blocked": bool(sub.ToolCheckPolicyBlocked),
                },
                ParentSourceType=sub.SourceType,
                ParentSourceNote=sub.SourceNote,
                Status=req_next_status,
                PreviousStatus=previous_status,
                PolicyBlocked=bool(sub.ToolCheckPolicyBlocked),
                DecidedBy=actor_id,
                DecidedAt=now,
                DecisionReason=payload.reason,
                OptimisticLockVersion=1,
                CreatedAt=now,
                UpdatedAt=now,
            )
            await self.repo.add_moderation_request(new_req)

        if payload.decision == "SUSPEND":
            await self._apply_book_suspension(
                book=book,
                actor_id=actor_id,
                reason=payload.reason,
                now=now,
                exclude_submission_id=sub.Id,
            )

        audit = await self.repo.add_audit_log(
            actor_id=actor_id,
            action=f"parent_private_book.moderation.{payload.decision.lower()}",
            resource_type="parent_book_submission",
            resource_id=sub.Id,
            metadata={
                "book_id": str(book.Id),
                "decision": payload.decision,
                "reason": payload.reason,
                "previous_status": previous_status,
                "new_status": sub.WorkflowStatus,
                "book_moderation_status": book.ModerationStatus,
                "submission_version": int(sub.SubmissionVersion),
                "snapshot_hash": sub.CandidateHash,
                "visibility_scope": book.VisibilityScope,
            },
        )
        book_id_val = book.Id
        book_mod_status = book.ModerationStatus
        audit_id = audit.Id
        await self.repo.commit()
        await self.db.refresh(sub)

        return AdminUserBookDecisionResponse(
            submission_id=sub.Id,
            book_id=book_id_val,
            decision=payload.decision,
            previous_status=previous_status,
            new_workflow_status=sub.WorkflowStatus,  # type: ignore[arg-type]
            book_moderation_status=book_mod_status,  # type: ignore[arg-type]
            approved_snapshot_hash=sub.ApprovedSnapshotHash,
            approved_submission_version=sub.ApprovedSubmissionVersion,
            optimistic_lock_version=int(sub.OptimisticLockVersion),
            decided_at=now,
            reason=payload.reason,
            audit_log_id=audit_id,
        )

    async def admin_suspend_book(
        self,
        actor_id: UUID,
        book_id: UUID,
        payload: AdminSuspendPrivateBookRequest,
    ) -> dict[str, Any]:
        """Immediately suspend a parent private book, blocking child reading and image proxy access."""
        await self._require_admin(actor_id)
        book = await self.repo.get_private_book(book_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        now = datetime.now(timezone.utc)
        previous_mod = book.ModerationStatus
        await self._apply_book_suspension(
            book=book,
            actor_id=actor_id,
            reason=payload.reason,
            now=now,
        )
        audit = await self.repo.add_audit_log(
            actor_id=actor_id,
            action="parent_private_book.suspended",
            resource_type="book",
            resource_id=book.Id,
            metadata={
                "previous_moderation_status": previous_mod,
                "new_moderation_status": MODERATION_SUSPENDED,
                "reason": payload.reason,
                "visibility_scope": book.VisibilityScope,
            },
        )
        audit_id = audit.Id
        await self.repo.commit()
        result = {
            "book_id": str(book_id),
            "moderation_status": MODERATION_SUSPENDED,
            "suspended_at": now.isoformat(),
            "reason": payload.reason,
            "audit_log_id": str(audit_id),
        }
        await invalidate_tts_cache_best_effort(self.db, book_id=book_id, commit=True)
        return result
