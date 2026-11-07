from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


BookContentIssueType = Literal[
    "BOOK_METADATA_ERROR",
    "SPELLING_ERROR",
    "MISSING_CONTENT",
    "OCR_MISMATCH",
    "IMAGE_QUALITY_ERROR",
    "DUPLICATE_PAGE",
    "PAGE_ORDER_ERROR",
    "OTHER",
]
BookContentReportStatus = Literal["OPEN", "UNDER_REVIEW", "RESOLVED", "REJECTED"]
BookQualityScanStatus = Literal["QUEUED", "RUNNING", "COMPLETED", "PARTIAL", "FAILED"]
BookQualityFindingStatus = Literal["NEEDS_REVIEW", "CONFIRMED", "DISMISSED", "RESOLVED", "STALE"]


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


class BookContentReportDetail(BookContentReportRead):
    reporter_id: UUID | None
    reporter_name: str | None
    verified_text_snapshot: str | None
    content_hash_snapshot: str | None
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


class BookQualityBookSummary(BaseModel):
    book_id: UUID
    book_title: str
    report_count: int
    open_report_count: int
    finding_count: int
    needs_review_finding_count: int
    latest_scan: BookQualityScanRead | None


class BookQualityBookPage(BaseModel):
    items: list[BookQualityBookSummary]
    total: int
    limit: int
    offset: int


class BookQualityBookDetail(BaseModel):
    book_id: UUID
    book_title: str
    reports: list[BookContentReportRead]
    scans: list[BookQualityScanRead]
    latest_scan_detail: BookQualityScanDetail | None
