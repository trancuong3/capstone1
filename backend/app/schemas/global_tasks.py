"""Pydantic schemas for Unified Global AI Task Center & Durable Studio Jobs (/studio/tasks)."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

SmartJobType = Literal[
    "OCR_EXTRACT",
    "COVER_GENERATE",
    "ILLUSTRATION_EXTRACT",
    "ILLUSTRATION_GENERATE",
    "STYLE_BIBLE",
    "BATCH_BOOK_IMPORT",
]

GlobalTaskSource = Literal[
    "smart_studio_job",
    "ocr_inference_job",
    "admin_ai_workflow",
    "parent_submission",
]

GlobalTaskStatus = Literal[
    "QUEUED",
    "RUNNING",
    "WAITING_FOR_WORKER",
    "WAITING_FOR_QUOTA",
    "WAITING_FOR_REVIEW",
    "RETRY_SCHEDULED",
    "PARTIAL_SUCCESS",
    "SUCCEEDED",
    "FAILED",
    "CANCEL_REQUESTED",
    "CANCELLED",
    "STALE",
]

ActorRole = Literal["admin", "parent"]


class GlobalTaskCreateRequest(BaseModel):
    job_type: SmartJobType
    book_id: UUID | None = None
    book_page_id: UUID | None = None
    source_revision_id: UUID | None = None
    input_hash: str = Field(..., min_length=8, max_length=64)
    idempotency_key: str = Field(..., min_length=1, max_length=128)
    priority: int = Field(default=50, ge=0, le=100)
    max_attempts: int = Field(default=3, ge=1, le=10)
    progress_completed: int | None = Field(default=None, ge=0)
    progress_total: int | None = Field(default=None, ge=0)
    progress_unit: str | None = Field(default=None, max_length=24)
    initial_checkpoints: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate_honest_progress(self) -> "GlobalTaskCreateRequest":
        if (self.progress_completed is None) != (self.progress_total is None):
            raise ValueError(
                "progress_completed and progress_total must both be set or both be null"
            )
        if (
            self.progress_completed is not None
            and self.progress_total is not None
            and self.progress_completed > self.progress_total
        ):
            raise ValueError("progress_completed cannot exceed progress_total")
        encoded_checkpoints = json.dumps(self.initial_checkpoints, ensure_ascii=False).encode("utf-8")
        if len(encoded_checkpoints) > 16384:
            raise ValueError("initial_checkpoints payload exceeds 16 KiB limit")
        return self


class GlobalTaskItem(BaseModel):
    id: UUID
    source: GlobalTaskSource
    job_type: str
    title_vi: str
    book_id: UUID | None = None
    book_page_id: UUID | None = None
    book_title: str | None = None
    page_number: int | None = None
    source_revision_id: UUID | None = None
    actor_role: ActorRole
    status: GlobalTaskStatus
    status_label_vi: str
    stage: str
    stage_label_vi: str
    priority: int
    attempt_count: int = 0
    max_attempts: int = 3
    progress_completed: int | None = None
    progress_total: int | None = None
    progress_unit: str | None = None
    progress_pct: float | None = None
    is_indeterminate: bool = True
    can_retry: bool = False
    can_cancel: bool = False
    result_href: str | None = None
    result_ref: dict[str, Any] = Field(default_factory=dict)
    checkpoints: dict[str, Any] = Field(default_factory=dict)
    error_code: str | None = None
    error_message_vi: str | None = None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None


class GlobalTaskListResponse(BaseModel):
    actor_id: UUID
    actor_role: ActorRole
    active_count: int = 0
    waiting_review_count: int = 0
    failed_count: int = 0
    completed_count: int = 0
    worker_online: bool | None = None
    recommended_poll_ms: int | None = None
    tasks: list[GlobalTaskItem] = Field(default_factory=list)


class GlobalTaskActionResponse(BaseModel):
    task: GlobalTaskItem
    action: str
    deduplicated: bool = False
    message_vi: str


class ReconcileTasksResponse(BaseModel):
    reclaimed_studio_jobs: int = 0
    failed_studio_jobs: int = 0
    cancelled_expired_studio_jobs: int = 0
    stale_fenced_jobs: int = 0
    reclaimed_parent_submissions: int = 0
    failed_parent_submissions: int = 0


class ProviderCapabilitySummary(BaseModel):
    provider_id: str
    family: str
    model_id: str
    quota_group: str | None = None
    is_local: bool = False
    enabled: bool = False
    capabilities: list[str] = Field(default_factory=list)
    max_attempt_timeout_seconds: float
    provider_circuit_state: str
    quota_group_circuit_state: str
    available_now: bool = False
    notes: str = ""


class CapabilitiesHealthResponse(BaseModel):
    feature_flags: dict[str, Any] = Field(default_factory=dict)
    providers: list[ProviderCapabilitySummary] = Field(default_factory=list)
    circuit_breakers: dict[str, Any] = Field(default_factory=dict)
    cache_entries: int = 0
    scheduler: dict[str, Any] = Field(default_factory=dict)
