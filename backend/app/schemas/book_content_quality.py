from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.schemas.admin_ai_workflow import AdminAiWorkflowRead


BookContentIssueType = Literal[
    "BOOK_METADATA_ERROR",
    "SPELLING_ERROR",
    "MISSING_CONTENT",
    "OCR_MISMATCH",
    "IMAGE_QUALITY_ERROR",
    "DUPLICATE_PAGE",
    "PAGE_ORDER_ERROR",
    "CHILD_UNSAFE_CONTENT",
    "COPYRIGHT_CONCERN",
    "OTHER",
]
BookContentReportStatus = Literal["OPEN", "UNDER_REVIEW", "RESOLVED", "REJECTED"]
BookQualityScanStatus = Literal["QUEUED", "RUNNING", "COMPLETED", "PARTIAL", "FAILED"]
BookQualityFindingStatus = Literal["NEEDS_REVIEW", "CONFIRMED", "DISMISSED", "RESOLVED", "STALE"]
ContentRightsStatus = Literal[
    "NOT_ASSESSED",
    "MISSING_EVIDENCE",
    "CONCERNS_FOUND",
    "REVIEWED",
]
ContentRightsUsageBasis = Literal[
    "OWN_ORIGINAL",
    "WRITTEN_LICENSE",
    "PUBLIC_DOMAIN",
    "OPEN_LICENSE",
    "EDUCATIONAL_PERMISSION",
    "UNKNOWN",
    "OTHER",
]
ContentRightsReferenceCheckStatus = Literal[
    "NOT_RUN",
    "NO_MATCH_IN_ALLOWED_CORPUS",
    "OVERLAP_CONCERN",
]
BookQualityIssueFilter = Literal[
    "MISSING_CONTENT",
    "SAFETY_ALERTS",
    "MISSING_RIGHTS",
    "OPEN_REPORTS",
    "READY_FOR_APPROVAL",
]


class BookContentReportCreate(BaseModel):
    idempotency_key: UUID
    issue_type: BookContentIssueType
    description: str = Field(min_length=1, max_length=4000)
    page_id: UUID | None = None
    reported_text: str | None = Field(default=None, max_length=1200)
    suggested_correction: str | None = Field(default=None, max_length=1200)

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Description must not be blank")
        return normalized

    @field_validator("reported_text", "suggested_correction")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class BookContentReportStatusUpdate(BaseModel):
    status: BookContentReportStatus
    resolution_note: str | None = Field(default=None, max_length=2000)

    @field_validator("resolution_note")
    @classmethod
    def normalize_note(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class BookQualityFindingUpdate(BaseModel):
    status: Literal["NEEDS_REVIEW", "CONFIRMED", "DISMISSED", "RESOLVED"]
    review_note: str | None = Field(default=None, max_length=2000)

    @field_validator("review_note")
    @classmethod
    def normalize_review_note(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class BookContentReportRead(BaseModel):
    id: UUID
    book_id: UUID | None
    book_title: str
    reporter_name: str | None = None
    page_id: UUID | None
    page_number: int | None
    page_revision_id: UUID | None
    issue_type: BookContentIssueType
    description: str
    reported_text: str | None
    suggested_correction: str | None
    status: BookContentReportStatus
    scan_run_id: UUID | None
    created_at: datetime
    updated_at: datetime


class BookContentReportHistoryRead(BaseModel):
    actor_name: str | None
    from_status: BookContentReportStatus | None
    to_status: BookContentReportStatus
    note: str | None
    created_at: datetime


class BookQualityFindingRead(BaseModel):
    id: UUID
    page_scan_id: UUID
    book_id: UUID | None
    page_id: UUID | None
    page_number: int
    page_revision_id: UUID | None
    issue_type: str
    severity: Literal["LOW", "MEDIUM", "HIGH"]
    original_excerpt: str
    excerpt_start: int
    excerpt_end: int
    suggested_correction: str | None
    explanation: str
    detection_source: Literal["RULE", "OLLAMA_TEXT"]
    model_name: str | None
    confidence: float | None
    status: BookQualityFindingStatus
    review_note: str | None
    created_at: datetime


class BookContentReportDetail(BookContentReportRead):
    reporter_id: UUID | None
    reporter_name: str | None
    verified_text_snapshot: str | None
    content_hash_snapshot: str | None
    current_page_revision_id: UUID | None = None
    page_revision_changed: bool = False
    admin_resolution_note: str | None
    reviewed_by: UUID | None
    reviewed_by_name: str | None
    resolved_at: datetime | None
    history: list[BookContentReportHistoryRead] = Field(default_factory=list)
    related_findings: list[BookQualityFindingRead] = Field(default_factory=list)


class BookContentReportPage(BaseModel):
    items: list[BookContentReportRead]
    total: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)


class BookQualityPageScanRead(BaseModel):
    id: UUID
    page_id: UUID | None
    page_number: int
    page_lifecycle_status: str
    page_revision_id: UUID | None
    content_hash: str | None
    status: str
    rule_check_status: str
    ai_analysis_status: str
    rejected_ai_finding_count: int
    error_code: str | None
    error_summary: str | None
    findings: list[BookQualityFindingRead] = Field(default_factory=list)


class BookQualityScanRead(BaseModel):
    id: UUID
    book_id: UUID | None
    book_title: str
    trigger_type: str
    scope: Literal["BOOK", "PAGE"]
    target_page_id: UUID | None
    status: BookQualityScanStatus
    total_pages: int
    completed_pages: int
    skipped_pages: int
    failed_pages: int
    ai_completed_pages: int
    ai_unavailable_pages: int
    error_summary: str | None
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime


class BookQualityScanDetail(BookQualityScanRead):
    pages: list[BookQualityPageScanRead]


class BookQualityReportAdminPage(BaseModel):
    items: list[BookContentReportRead]
    total: int
    summary: dict[str, int]
    limit: int
    offset: int


class BookContentRightsProfileUpsert(BaseModel):
    status: ContentRightsStatus
    source_name: str | None = Field(default=None, max_length=300)
    rights_holder: str | None = Field(default=None, max_length=300)
    usage_basis: ContentRightsUsageBasis | None = None
    evidence_url: str | None = Field(default=None, max_length=1000)
    evidence_reference: str | None = Field(default=None, max_length=500)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator(
        "source_name", "rights_holder", "evidence_url", "evidence_reference", "notes"
    )
    @classmethod
    def normalize_optional_field(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed or None


class BookContentRightsProfileRead(BaseModel):
    id: UUID | None = None
    book_id: UUID
    page_id: UUID | None = None
    scope: Literal["BOOK", "PAGE_OVERRIDE"] = "BOOK"
    status: ContentRightsStatus = "NOT_ASSESSED"
    source_name: str | None = None
    rights_holder: str | None = None
    usage_basis: str | None = None
    evidence_url: str | None = None
    evidence_reference: str | None = None
    notes: str | None = None
    source_fingerprint: str | None = None
    profile_version: int = 0
    reference_check_status: ContentRightsReferenceCheckStatus = "NOT_RUN"
    reference_check_evidence: list[dict] = Field(default_factory=list)
    reviewed_by: UUID | None = None
    reviewed_by_name: str | None = None
    reviewed_at: datetime | None = None
    history: list[dict] = Field(default_factory=list)
    updated_at: datetime | None = None


class BookExpectedPageCountUpdate(BaseModel):
    expected_page_count: int | None = Field(default=None, ge=1, le=5000)


class BookQualityPageItemRead(BaseModel):
    page_id: UUID
    page_number: int
    lifecycle_status: str
    content_type: Literal["CONTENT", "COVER_OR_IMAGE_ONLY"] = "CONTENT"
    current_verified_revision_id: UUID | None = None
    latest_revision_id: UUID | None = None
    verification_status: str = "MISSING"
    content_issues: list[str] = Field(default_factory=list)
    proofreading_status: str = "NOT_STARTED"
    uncertain_word_count: int = 0
    safety_status: str = "NOT_STARTED"
    safety_suitability: str | None = None
    safety_finding_count: int = 0
    high_finding_count: int = 0
    image_safety_status: str = "NOT_REVIEWED"
    rights_status: ContentRightsStatus = "NOT_ASSESSED"
    has_rights_override: bool = False
    open_report_count: int = 0
    latest_workflow_id: UUID | None = None
    has_issues: bool = False


class BookQualityBookSummary(BaseModel):
    book_id: UUID
    book_title: str
    report_count: int
    open_report_count: int
    open_safety_report_count: int = 0
    finding_count: int
    needs_review_finding_count: int
    verified_page_count: int = 0
    issue_page_count: int = 0
    has_missing_content: bool = False
    has_safety_alerts: bool = False
    has_missing_rights: bool = False
    ready_for_approval: bool = False
    latest_scan: BookQualityScanRead | None
    assessment: "BookApprovalAssessment"


class BookApprovalAssessment(BaseModel):
    status: Literal[
        "PROCESSING",
        "SCAN_FAILED",
        "PENDING_ADMIN_REVIEW",
        "READY_FOR_CHILDREN",
        "PUBLISHED",
        "APPROVED_BY_ADMIN",
        "REJECTED_FOR_CHILDREN",
        "STALE",
    ]
    page_count: int
    ocr_completed_pages: int
    ocr_approval_valid_pages: int
    proofreading_status: str
    proofreading_completed_pages: int
    proofreading_suggestion_count: int
    child_safety_status: str
    child_safety_completed_pages: int
    processing_pages: int
    failed_pages: int
    stale_pages: int
    copyright_status: str
    copyright_finding_count: int | None = None
    rights_profile_status: ContentRightsStatus = "NOT_ASSESSED"
    rights_profile_version: int | None = None
    rights_profile_hash: str | None = None
    legacy_published_needs_rights_review: bool = False
    expected_page_count: int | None = None
    expected_page_count_status: Literal[
        "MATCHED", "UNDER_EXPECTED", "OVER_EXPECTED", "UNKNOWN_SOURCE_PAGE_COUNT"
    ] = "UNKNOWN_SOURCE_PAGE_COUNT"
    missing_page_numbers: list[int] = Field(default_factory=list)
    duplicate_page_numbers: list[int] = Field(default_factory=list)
    empty_ocr_page_numbers: list[int] = Field(default_factory=list)
    missing_image_page_numbers: list[int] = Field(default_factory=list)
    image_only_page_numbers: list[int] = Field(default_factory=list)
    finding_count: int
    high_finding_count: int
    medium_finding_count: int
    warning_page_count: int
    failed_or_unscanned_page_count: int
    finding_groups: list[dict] = Field(default_factory=list)
    assessment_hash: str
    assessed_at: datetime
    admin_approved_at: datetime | None = None
    admin_approved_by: UUID | None = None
    admin_approved_by_name: str | None = None
    admin_reason: str | None = None
    publication_source: Literal["AUTO_APPROVAL", "ADMIN_APPROVAL"] | None = None
    rights_confirmed: bool = False
    blockers: list[str] = Field(default_factory=list)


BookQualityBookSummary.model_rebuild()


class BookQualityBookPage(BaseModel):
    items: list[BookQualityBookSummary]
    total: int
    limit: int
    offset: int
    summary: dict[str, int] = Field(default_factory=dict)
    alert_summary: dict[str, int] = Field(default_factory=dict)
    issue_filter_summary: dict[str, int] = Field(default_factory=dict)


class BookQualityBookDetail(BaseModel):
    book_id: UUID
    book_title: str
    expected_page_count: int | None = None
    reports: list[BookContentReportRead]
    scans: list[BookQualityScanRead]
    latest_scan_detail: BookQualityScanDetail | None
    ai_workflows: list[AdminAiWorkflowRead] = Field(default_factory=list)
    ai_workflow_summary: dict[str, int] = Field(default_factory=dict)
    rights_profile: BookContentRightsProfileRead | None = None
    page_rights_overrides: list[BookContentRightsProfileRead] = Field(default_factory=list)
    pages: list[BookQualityPageItemRead] = Field(default_factory=list)
    assessment: BookApprovalAssessment
    decision_history: list[dict] = Field(default_factory=list)


class BookQualityBookDecisionRequest(BaseModel):
    decision: Literal["APPROVE", "REJECT", "REQUEST_RESCAN", "FALSE_POSITIVE"]
    reason: str = Field(min_length=1, max_length=2000)
    rights_confirmed: bool = False
    category: str | None = Field(default=None, max_length=80)

    @field_validator("reason")
    @classmethod
    def normalize_reason(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Reason is required")
        return normalized

    @field_validator("category")
    @classmethod
    def normalize_category(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().upper()
        return normalized or None


class BookQualityBookDecisionRead(BaseModel):
    book_id: UUID
    assessment: BookApprovalAssessment
    decision_history: list[dict] = Field(default_factory=list)
