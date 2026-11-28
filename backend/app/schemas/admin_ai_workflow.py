from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.schemas.admin_ocr import AdminOcrWordInput


WorkflowStatus = Literal[
    "QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING",
    "READY_FOR_ADMIN_REVIEW", "FAILED",
]
WorkflowStage = Literal[
    "PROOFREADING", "CHILD_SAFETY_SCANNING", "READY_FOR_ADMIN_REVIEW", "FAILED",
]
ImageSafetyStatus = Literal[
    "UNASSESSED_NO_VISION_MODEL",
    "ADMIN_CONFIRMED_SAFE",
    "ADMIN_FLAGGED_UNSAFE",
]


class AdminAiWorkflowCreate(BaseModel):
    page_revision_id: UUID
    idempotency_key: UUID
    draft_text: str = Field(min_length=1, max_length=500_000)
    words: list[AdminOcrWordInput] = Field(min_length=1, max_length=30_000)

    @field_validator("draft_text")
    @classmethod
    def nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("draft_text must not be blank")
        return value


class AdminAiCandidateUpdate(BaseModel):
    expected_candidate_version: int = Field(ge=0)
    candidate_text: str = Field(min_length=1, max_length=500_000)

    @field_validator("candidate_text")
    @classmethod
    def nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("candidate_text must not be blank")
        return value


class AdminAiSafetyDecision(BaseModel):
    confirmed: bool
    expected_candidate_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    reason: str | None = Field(default=None, max_length=500)

    @field_validator("reason")
    @classmethod
    def normalize_reason(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class AdminAiImageSafetyDecision(BaseModel):
    status: Literal["ADMIN_CONFIRMED_SAFE", "ADMIN_FLAGGED_UNSAFE"]
    expected_image_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    reason: str | None = Field(default=None, max_length=500)

    @field_validator("reason")
    @classmethod
    def normalize_reason(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class AdminAiWorkflowRead(BaseModel):
    workflow_id: UUID
    page_id: UUID
    book_id: UUID
    page_revision_id: UUID
    status: WorkflowStatus
    stage: WorkflowStage
    progress: dict[str, int]
    progress_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    attempts: int = Field(ge=0)
    error_code: str | None
    original_ocr_hash: str
    admin_input_hash: str
    proofread_text: str | None
    proofread_output_hash: str | None
    corrections: list[dict[str, Any]] = Field(default_factory=list)
    uncertain_word_indices: list[int] = Field(default_factory=list)
    proofread_metadata: dict[str, Any] = Field(default_factory=dict)
    safety_metadata: dict[str, Any] = Field(default_factory=dict)
    candidate_history: list[dict[str, Any]] = Field(default_factory=list)
    safety_history: list[dict[str, Any]] = Field(default_factory=list)
    review_history: list[dict[str, Any]] = Field(default_factory=list)
    candidate_text: str | None
    candidate_hash: str | None
    candidate_version: int
    safety_input_hash: str | None
    hash_match: bool
    suitability: Literal[
        "SUITABLE", "SUITABLE_WITH_GUIDANCE", "REVIEW_REQUIRED", "NOT_RECOMMENDED"
    ] | None
    safety_status: Literal[
        "PENDING", "STALE", "PROVISIONAL", "CONFIRMED", "AUTO_CONFIRMED", "FAILED"
    ]
    text_safety_status: Literal[
        "PENDING", "STALE", "PROVISIONAL", "CONFIRMED", "AUTO_CONFIRMED", "FAILED"
    ] = "PENDING"
    image_safety_status: ImageSafetyStatus = "UNASSESSED_NO_VISION_MODEL"
    image_safety_reviewed_at: datetime | None = None
    image_safety_reviewed_by: UUID | None = None
    image_safety_image_sha256: str | None = None
    image_safety_reason: str | None = None
    source_image_sha256: str | None = None
    all_chunks_completed: bool = False
    findings: list[dict[str, Any]] = Field(default_factory=list)
    provider_events: list[dict[str, Any]] = Field(default_factory=list)
    ocr_approved_at: datetime | None
    final_approved_text_hash: str | None
    created_at: datetime
    updated_at: datetime
