"""Strict Pydantic request/response contracts for Parent Private Books and Admin User-Books moderation."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SourceUsageType = Literal[
    "SELF_AUTHORED",
    "OWNED_PHYSICAL_BOOK",
    "PUBLIC_DOMAIN",
    "LICENSED_OR_PERMISSION",
    "OTHER",
]

SubmissionWorkflowStatus = Literal[
    "CHECKING",
    "PASSED_READY_TO_ADD",
    "NEEDS_ADMIN_REVIEW",
    "CHECK_FAILED",
    "PENDING_ADMIN",
    "APPROVED_READY_TO_ADD",
    "REJECTED",
    "NEEDS_RECHECK",
    "ADDED_TO_BOOK",
    "CANCELLED",
]

AdminUserBookQueueFilter = Literal[
    "PENDING_ADMIN",
    "FLAGGED",
    "CHECK_FAILED",
    "APPROVED",
    "REJECTED",
    "SUSPENDED",
]

AdminUserBookDecisionType = Literal[
    "APPROVE",
    "REQUEST_CHANGES",
    "REJECT",
    "SUSPEND",
]

WORKFLOW_STATUS_LABELS: dict[str, str] = {
    "CHECKING": "Đang kiểm tra",
    "PASSED_READY_TO_ADD": "Đạt — có thể thêm trang",
    "NEEDS_ADMIN_REVIEW": "Cần Admin duyệt",
    "CHECK_FAILED": "Kiểm tra lỗi — có thể thử lại",
    "PENDING_ADMIN": "Đang chờ Admin",
    "APPROVED_READY_TO_ADD": "Đã duyệt — có thể thêm trang",
    "REJECTED": "Bị từ chối",
    "NEEDS_RECHECK": "Cần kiểm tra lại",
    "ADDED_TO_BOOK": "Đã thêm vào sách",
    "CANCELLED": "Đã hủy",
}

SOURCE_TYPE_LABELS: dict[str, str] = {
    "SELF_AUTHORED": "Tự biên soạn / gia đình tự viết",
    "OWNED_PHYSICAL_BOOK": "Sách giấy gia đình đã mua để con luyện đọc tại nhà",
    "PUBLIC_DOMAIN": "Tác phẩm thuộc phạm vi công cộng",
    "LICENSED_OR_PERMISSION": "Có giấy phép hoặc sự đồng ý của tác giả/nhà xuất bản",
    "OTHER": "Nguồn khác (cần ghi rõ căn cứ)",
}


# ---------------------------------------------------------------------------
# Parent Private Book write requests (strict extra="forbid" — rejects spoofed owner/visibility/approval)
# ---------------------------------------------------------------------------
class ParentPrivateBookCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., min_length=1, max_length=200)
    author: str | None = Field(default=None, max_length=150)
    min_grade: int = Field(default=1, ge=1, le=5)
    max_grade: int = Field(default=5, ge=1, le=5)
    source_type: SourceUsageType = Field(default="OWNED_PHYSICAL_BOOK")
    source_note: str | None = Field(default=None, max_length=1000)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Tên sách không được để trống.")
        return cleaned

    @field_validator("author", "source_note")
    @classmethod
    def clean_optional(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @model_validator(mode="after")
    def check_grades(self) -> "ParentPrivateBookCreate":
        if self.min_grade > self.max_grade:
            raise ValueError("Lớp tối thiểu không được lớn hơn lớp tối đa.")
        return self


class ParentPrivateBookUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)
    author: str | None = Field(default=None, max_length=150)
    min_grade: int | None = Field(default=None, ge=1, le=5)
    max_grade: int | None = Field(default=None, ge=1, le=5)
    source_type: SourceUsageType | None = None
    source_note: str | None = Field(default=None, max_length=1000)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Tên sách không được để trống.")
        return cleaned

    @field_validator("author", "source_note")
    @classmethod
    def clean_optional(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class ParentPrivatePageEditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_text: str | None = Field(default=None, max_length=30000)
    page_number: int | None = Field(default=None, ge=1, le=32767)
    source_type: SourceUsageType | None = None
    source_note: str | None = Field(default=None, max_length=1000)
    auto_recheck: bool = True

    @field_validator("source_note")
    @classmethod
    def clean_source_note(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class ParentSubmissionEditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_text: str | None = Field(default=None, max_length=30000)
    source_type: SourceUsageType | None = None
    source_note: str | None = Field(default=None, max_length=1000)
    expected_lock_version: int | None = Field(default=None, ge=1)
    auto_recheck: bool = True

    @field_validator("source_note")
    @classmethod
    def clean_source_note(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class ParentAcceptSpellingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_submission_version: int = Field(..., ge=1)
    expected_candidate_hash: str = Field(..., min_length=8, max_length=128)


class ParentRetrySubmissionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stage: Literal["AUTO", "OCR", "PROOFREADING", "TOOL_CHECK"] = "AUTO"


class ParentRequestAdminReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_submission_version: int = Field(..., ge=1)
    expected_candidate_hash: str = Field(..., min_length=8, max_length=128)
    source_type: SourceUsageType | None = None
    source_note: str | None = Field(default=None, max_length=1000)
    request_note: str | None = Field(default=None, max_length=2000)

    @field_validator("source_note", "request_note")
    @classmethod
    def clean_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class ParentAddPageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_submission_version: int = Field(..., ge=1)
    expected_candidate_hash: str = Field(..., min_length=8, max_length=128)
    target_page_number: int | None = Field(default=None, ge=1, le=32767)
    accept_spelling: bool = False


# ---------------------------------------------------------------------------
# Shared structured Tool Check & Submission DTOs
# ---------------------------------------------------------------------------
class ToolCheckScopeRead(BaseModel):
    modality: str = "TEXT_ONLY_WITH_OCR_IMAGE_PROOFREAD"
    covers_all_chunks: bool = False
    chunks_checked: int = 0
    total_chunks: int = 0
    image_visual_safety_checked: bool = False
    requires_admin_visual_review: bool = False
    copyright_scanner_status: str = "NOT_CONFIGURED"
    local_ai_enforced: bool = True


class ProofreadSuggestionRead(BaseModel):
    word_index: int = Field(ge=0)
    original: str
    suggested: str
    uncertain: bool = False


class ProviderEventSummaryRead(BaseModel):
    provider: str
    model: str | None = None
    stage: str
    chunk_id: int | None = None
    availability: bool | None = None
    error_code: str | None = None
    duration_ms: int | None = None


class ToolCheckFindingRead(BaseModel):
    finding_id: str | None = None
    source: str
    category: str
    severity: str
    content_type: str | None = None
    excerpt: str
    explanation: str
    recommendation: str | None = None


class ParentPrivatePageRead(BaseModel):
    page_id: UUID
    page_number: int
    current_verified_revision_id: UUID | None = None
    verified_text: str = ""
    verified_text_preview: str = ""
    image_url: str
    created_at: datetime


class ParentPageSubmissionRead(BaseModel):
    id: UUID
    book_id: UUID
    batch_id: UUID
    batch_total_pages: int
    source_page_number: int
    target_page_number: int | None = None
    source_file_name: str
    source_format: str
    image_width: int
    image_height: int
    image_url: str
    source_type: SourceUsageType
    source_type_label: str
    source_note: str | None = None
    submission_version: int
    optimistic_lock_version: int
    workflow_status: SubmissionWorkflowStatus
    workflow_status_label: str
    progress_pct: float = Field(default=0.0, ge=0.0, le=100.0)

    ocr_status: str
    ocr_text: str | None = None
    ocr_error_code: str | None = None
    is_image_only: bool = False

    proofread_status: str
    proofread_text: str | None = None
    proofread_suggestions: list[ProofreadSuggestionRead] = Field(default_factory=list)
    uncertain_word_indices: list[int] = Field(default_factory=list)
    proofread_error_code: str | None = None
    spelling_accepted: bool = False

    candidate_text: str | None = None
    candidate_hash: str | None = None

    tool_check_status: str
    tool_check_suitability: str | None = None
    tool_check_scope: ToolCheckScopeRead
    tool_check_findings_count: int = 0
    tool_check_parent_notice: str | None = None
    tool_check_policy_blocked: bool = False
    tool_check_workflow_id: UUID | None = None
    tool_check_error_code: str | None = None
    provider_events: list[ProviderEventSummaryRead] = Field(default_factory=list)

    can_add_to_book: bool = False
    can_request_admin_review: bool = False
    can_retry: bool = False

    admin_decision: str | None = None
    admin_decision_reason: str | None = None
    approved_snapshot_hash: str | None = None
    approved_submission_version: int | None = None
    committed_page_id: UUID | None = None
    committed_revision_id: UUID | None = None

    created_at: datetime
    updated_at: datetime


class ParentPrivateBookSummaryRead(BaseModel):
    id: UUID
    title: str
    author: str | None = None
    min_grade: int
    max_grade: int
    lifecycle_status: Literal["ACTIVE", "RETIRED"]
    visibility_scope: Literal["PARENT_PRIVATE"] = "PARENT_PRIVATE"
    moderation_status: Literal["ACTIVE", "SUSPENDED"]
    suspended_reason: str | None = None
    source_declaration: str | None = None
    committed_page_count: int = 0
    pending_submission_count: int = 0
    flagged_submission_count: int = 0
    failed_submission_count: int = 0
    ready_to_add_count: int = 0
    readable_for_children: bool = False
    has_held_multipage_batch: bool = False
    privacy_notice: str = "Chỉ bạn và các hồ sơ trẻ của bạn có thể đọc sách này sau khi trang được kiểm tra. Sách mặc định không được dùng để đóng góp dữ liệu cải thiện nhận diện chữ."
    ocr_contribution: "ParentOcrContributionStateRead | None" = None
    created_at: datetime


class ParentPrivateBookPageRead(BaseModel):
    items: list[ParentPrivateBookSummaryRead] = Field(default_factory=list)
    total: int = 0
    limit: int = 9
    offset: int = 0


class ParentPrivateBookDetailRead(BaseModel):
    book: ParentPrivateBookSummaryRead
    pages: list[ParentPrivatePageRead] = Field(default_factory=list)
    submissions: list[ParentPageSubmissionRead] = Field(default_factory=list)


class ParentSubmitPagesResponse(BaseModel):
    book_id: UUID
    batch_id: UUID
    source_format: str
    total_pages: int
    replayed_idempotency: bool = False
    submissions: list[ParentPageSubmissionRead]


class ParentAddPageResponse(BaseModel):
    book_id: UUID
    page_id: UUID
    page_number: int
    revision_id: UUID
    submission: ParentPageSubmissionRead
    book_readable_for_children: bool


ScanSaveMode = Literal["create_book", "append_page"]


class ParentSaveFromScanResponse(BaseModel):
    book_id: UUID
    page_id: UUID
    page_number: int
    revision_id: UUID
    title: str
    visibility_scope: Literal["PARENT_PRIVATE"] = "PARENT_PRIVATE"
    reader_href: str


class ParentDeletePrivateBookResponse(BaseModel):
    status: Literal["deleted"] = "deleted"
    book_id: UUID
    retired_pages_count: int = 0
    cancelled_submissions_count: int = 0


class ParentDeletePrivatePageResponse(BaseModel):
    status: Literal["deleted"] = "deleted"
    book_id: UUID
    page_id: UUID
    committed_page_count: int = 0
    readable_for_children: bool = False


class ParentCancelSubmissionResponse(BaseModel):
    status: Literal["cancelled"] = "cancelled"
    submission_id: UUID


# ---------------------------------------------------------------------------
# Admin "Sách người dùng" Moderation Schemas
# ---------------------------------------------------------------------------
class AdminUserBookQueueItemRead(BaseModel):
    book_id: UUID
    book_title: str
    book_author: str | None = None
    owner_label: str
    moderation_status: Literal["ACTIVE", "SUSPENDED"]
    queue_status: AdminUserBookQueueFilter
    pending_count: int = 0
    flagged_count: int = 0
    failed_count: int = 0
    committed_page_count: int = 0
    latest_submission_id: UUID | None = None
    latest_request_id: UUID | None = None
    latest_submission_version: int | None = None
    latest_submitted_at: datetime
    policy_blocked: bool = False


class AdminUserBookQueuePageRead(BaseModel):
    items: list[AdminUserBookQueueItemRead]
    total: int
    limit: int
    offset: int
    summary: dict[str, int]


class AdminModerationHistoryItemRead(BaseModel):
    request_id: UUID
    submission_version: int
    snapshot_hash: str
    status: str
    previous_status: str | None = None
    parent_source_type: str
    parent_source_note: str | None = None
    parent_request_note: str | None = None
    decision_reason: str | None = None
    decided_by_label: str | None = None
    decided_at: datetime | None = None
    created_at: datetime


class AdminUserBookSubmissionDetailRead(BaseModel):
    submission_id: UUID
    request_id: UUID | None = None
    book_id: UUID
    book_title: str
    book_author: str | None = None
    book_moderation_status: Literal["ACTIVE", "SUSPENDED"]
    book_suspended_reason: str | None = None
    owner_label: str
    source_file_name: str
    source_format: str
    source_page_number: int
    batch_total_pages: int
    submission_version: int
    optimistic_lock_version: int
    snapshot_hash: str | None = None
    source_sha256: str
    image_width: int
    image_height: int
    image_url: str

    workflow_status: SubmissionWorkflowStatus
    workflow_status_label: str
    progress_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    request_status: str | None = None

    ocr_status: str
    ocr_text: str | None = None
    ocr_error_code: str | None = None
    is_image_only: bool = False

    proofread_status: str
    proofread_text: str | None = None
    proofread_suggestions: list[ProofreadSuggestionRead] = Field(default_factory=list)
    uncertain_word_indices: list[int] = Field(default_factory=list)
    proofread_error_code: str | None = None

    candidate_text: str | None = None

    tool_check_status: str
    tool_check_suitability: str | None = None
    tool_check_scope: ToolCheckScopeRead
    tool_check_findings: list[ToolCheckFindingRead] = Field(default_factory=list)
    tool_check_policy_blocked: bool = False
    tool_check_error_code: str | None = None
    tool_check_workflow_id: UUID | None = None
    provider_events: list[ProviderEventSummaryRead] = Field(default_factory=list)

    source_type: SourceUsageType
    source_type_label: str
    source_note: str | None = None
    parent_request_note: str | None = None

    can_approve: bool = False
    approve_blocked_reason: str | None = None
    approved_snapshot_hash: str | None = None
    approved_submission_version: int | None = None
    admin_decision: str | None = None
    admin_decision_reason: str | None = None

    history: list[AdminModerationHistoryItemRead] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class AdminUserBookDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: AdminUserBookDecisionType
    reason: str = Field(..., min_length=5, max_length=2000)
    expected_submission_version: int = Field(..., ge=1)
    expected_snapshot_hash: str = Field(..., min_length=8, max_length=128)
    expected_lock_version: int = Field(..., ge=1)

    @field_validator("reason")
    @classmethod
    def clean_reason(cls, value: str) -> str:
        cleaned = value.strip()
        if len(cleaned) < 5:
            raise ValueError("Vui lòng nhập lý do quyết định (tối thiểu 5 ký tự).")
        return cleaned


class AdminSuspendPrivateBookRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(..., min_length=5, max_length=2000)

    @field_validator("reason")
    @classmethod
    def clean_reason(cls, value: str) -> str:
        cleaned = value.strip()
        if len(cleaned) < 5:
            raise ValueError("Vui lòng nhập lý do đình chỉ (tối thiểu 5 ký tự).")
        return cleaned


class AdminSuspendPrivateBookResponse(BaseModel):
    book_id: UUID
    moderation_status: Literal["SUSPENDED"] = "SUSPENDED"
    suspended_at: datetime
    reason: str
    audit_log_id: UUID


class AdminUserBookDecisionResponse(BaseModel):
    submission_id: UUID
    book_id: UUID
    decision: AdminUserBookDecisionType
    previous_status: str
    new_workflow_status: SubmissionWorkflowStatus
    book_moderation_status: Literal["ACTIVE", "SUSPENDED"]
    approved_snapshot_hash: str | None = None
    approved_submission_version: int | None = None
    optimistic_lock_version: int
    decided_at: datetime
    reason: str
    audit_log_id: UUID


# ---------------------------------------------------------------------------
# Parent Private Book -> Flow 2 (Admin Verified) OCR Contribution Schemas
# ---------------------------------------------------------------------------
OcrContributionConsentStatus = Literal["OPTED_OUT", "OPTED_IN", "REVOKED"]

Flow2CandidateStatus = Literal[
    "PENDING_VERIFICATION",
    "VERIFIED",
    "SYNC_QUEUED",
    "SYNCED",
    "REJECTED",
    "REVOKED",
]

Flow2CandidateRejectionCode = Literal[
    "BLURRY_OR_TRUNCATED",
    "LABEL_IMAGE_MISMATCH",
    "DIACRITIC_ERROR",
    "CONTAINS_PII",
    "UNCLEAR_RIGHTS",
    "OTHER",
]

FLOW2_CANDIDATE_STATUS_LABELS: dict[str, str] = {
    "PENDING_VERIFICATION": "Chờ xác minh mẫu",
    "VERIFIED": "Đã xác minh nhãn",
    "SYNC_QUEUED": "Chờ đồng bộ Drive",
    "SYNCED": "Đã đồng bộ Flow 2",
    "REJECTED": "Bị từ chối",
    "REVOKED": "Đã thu hồi",
}

FLOW2_REJECTION_CODE_LABELS: dict[str, str] = {
    "BLURRY_OR_TRUNCATED": "Ảnh mờ, thiếu nét hoặc cắt cụt chữ",
    "LABEL_IMAGE_MISMATCH": "Nhãn không khớp chữ in thật trên ảnh",
    "DIACRITIC_ERROR": "Sai dấu tiếng Việt, chữ đ/Đ hoặc thứ tự chữ",
    "CONTAINS_PII": "Chứa thông tin cá nhân / riêng tư",
    "UNCLEAR_RIGHTS": "Chưa rõ căn cứ quyền sử dụng cho huấn luyện",
    "OTHER": "Lý do khác",
}

OCR_CONTRIBUTION_NOTICE_VERSION = "v1-2026-11-22"


class ParentOcrContributionStateRead(BaseModel):
    book_id: UUID
    enabled: bool = False
    status: OcrContributionConsentStatus = "OPTED_OUT"
    purpose: Literal["FLOW2_ADMIN_VERIFIED_OCR"] = "FLOW2_ADMIN_VERIFIED_OCR"
    consent_version: int = 0
    notice_version: str = OCR_CONTRIBUTION_NOTICE_VERSION
    rights_confirmed: bool = False
    consented_at: datetime | None = None
    revoked_at: datetime | None = None
    revoke_reason: str | None = None
    rights_basis: SourceUsageType = "OWNED_PHYSICAL_BOOK"
    rights_eligible_for_training: bool = False
    rights_ineligible_reason: str | None = None
    pending_verification_count: int = 0
    sync_queued_count: int = 0
    synced_count: int = 0
    rejected_count: int = 0
    revoked_count: int = 0
    last_recruitment_skipped_pages: int = 0
    status_notice: str


class ParentOcrContributionUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    rights_confirmed: bool = False
    notice_version: str = Field(default=OCR_CONTRIBUTION_NOTICE_VERSION, min_length=3, max_length=64)
    revoke_reason: str | None = Field(default=None, max_length=500)

    @field_validator("notice_version")
    @classmethod
    def clean_notice_version(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Phiên bản thông báo đồng ý không hợp lệ.")
        return cleaned

    @field_validator("revoke_reason")
    @classmethod
    def clean_revoke_reason(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class AdminFlow2CandidateRead(BaseModel):
    """Privacy-minimized candidate view for Admin line-label verification (no email, no child profile)."""

    id: UUID
    book_id: UUID
    book_title: str
    page_id: UUID
    page_number: int
    revision_id: UUID
    line_index: int
    consent_version: int
    crop_image_url: str
    image_sha256: str
    proposed_label: str
    verified_label: str | None = None
    rights_basis: Literal["SELF_AUTHORED", "PUBLIC_DOMAIN", "LICENSED_OR_PERMISSION"]
    rights_basis_label: str
    pii_check_status: Literal["CLEAR", "FLAGGED_PII"]
    pii_flags: list[str] = Field(default_factory=list)
    quality_metrics: dict[str, Any] = Field(default_factory=dict)
    status: Flow2CandidateStatus
    status_label: str
    verified_at: datetime | None = None
    rejection_code: str | None = None
    rejection_reason: str | None = None
    outbox_event_id: UUID | None = None
    sample_id: UUID | None = None
    revoked_at: datetime | None = None
    revoke_reason: str | None = None
    created_at: datetime
    updated_at: datetime


class AdminFlow2CandidatePageRead(BaseModel):
    items: list[AdminFlow2CandidateRead]
    total: int
    limit: int
    offset: int
    summary: dict[str, int]


class AdminFlow2CandidateDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["APPROVE", "REJECT"]
    verified_label: str | None = Field(default=None, max_length=300)
    rejection_code: Flow2CandidateRejectionCode | None = None
    reason: str | None = Field(default=None, max_length=1000)

    @field_validator("verified_label", "reason")
    @classmethod
    def clean_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class AdminFlow2CandidateDecisionResponse(BaseModel):
    candidate_id: UUID
    book_id: UUID
    page_id: UUID
    revision_id: UUID
    decision: Literal["APPROVE", "REJECT"]
    status: Flow2CandidateStatus
    verified_label: str | None = None
    outbox_event_id: UUID | None = None
    rejection_code: str | None = None
    rejection_reason: str | None = None
    decided_at: datetime
    audit_log_id: UUID


ParentPrivateBookSummaryRead.model_rebuild()
