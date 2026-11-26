from pydantic import BaseModel, Field, ConfigDict, AwareDatetime
from typing import Optional, Dict, Any, Literal
from datetime import datetime, date
from uuid import UUID

# --- PROGRESS REPORT ---
class ProgressReportBase(BaseModel):
    PeriodStart: date
    PeriodEnd: date
    Summary: Dict[str, Any]

class ProgressReportCreate(ProgressReportBase):
    ChildId: UUID

class ProgressReportResponse(ProgressReportBase):
    Id: UUID
    ChildId: UUID
    GeneratedAt: datetime
    model_config = ConfigDict(from_attributes=True)

# --- CONSENT RECORD ---
class ConsentRecordBase(BaseModel):
    Scope: str
    Granted: bool
    GrantedAt: Optional[datetime] = None
    RevokedAt: Optional[datetime] = None

class ConsentRecordCreate(ConsentRecordBase):
    ParentId: UUID
    ChildId: UUID

class ConsentRecordResponse(ConsentRecordBase):
    Id: UUID
    ParentId: UUID
    ChildId: UUID
    model_config = ConfigDict(from_attributes=True)

# --- AUDIT LOG ---
class AuditLogBase(BaseModel):
    Action: str
    ResourceType: str
    RequestId: str
    Metadata: Dict[str, Any] = Field(default_factory=dict)

class AuditLogCreate(AuditLogBase):
    ActorId: UUID
    ResourceId: UUID

class AuditLogResponse(AuditLogBase):
    Id: UUID
    ActorId: UUID
    ResourceId: UUID
    CreatedAt: datetime
    model_config = ConfigDict(from_attributes=True)


class DifficultWordSourceRead(BaseModel):
    book_id: UUID | None = None
    book_title: str | None = None
    book_author: str | None = None
    min_grade: int | None = None
    max_grade: int | None = None
    book_cover_url: str | None = None
    session_id: UUID | None = None
    page_id: UUID | None = None
    page_revision_id: UUID | None = None
    page_number: int | None = None
    word_id: UUID | None = None
    context_phrase: str | None = None
    last_seen_at: datetime


class DifficultWordRead(BaseModel):
    normalized_word: str
    display_text: str
    difficulty_score: float
    omission_count: int = Field(ge=0)
    repetition_count: int = Field(ge=0)
    long_pause_count: int = Field(ge=0)
    read_example_count: int = Field(ge=0)
    session_count: int = Field(ge=0)
    last_seen_at: datetime
    evidence_word_ids: list[UUID]
    mispronunciation_count: int = Field(default=0, ge=0)
    encounter_count: int = Field(default=0, ge=0)
    practice_status: Literal[
        "NOT_PRACTICED",
        "IN_PROGRESS",
        "NEEDS_MORE_PRACTICE",
        "COMPLETED",
    ] = "NOT_PRACTICED"
    practice_attempts_count: int = Field(default=0, ge=0)
    practice_correct_count: int = Field(default=0, ge=0)
    practice_incorrect_count: int = Field(default=0, ge=0)
    practice_uncertain_count: int = Field(default=0, ge=0)
    consecutive_correct_count: int = Field(default=0, ge=0)
    last_practiced_at: datetime | None = None
    last_practice_status: Literal[
        "CORRECT",
        "INCORRECT",
        "UNCERTAIN",
        "NO_CLEAR_AUDIO",
        "ENGINE_ERROR",
    ] | None = None
    sources: list[DifficultWordSourceRead] = Field(default_factory=list)


class ProgressPeriodRead(BaseModel):
    completed_sessions: int = Field(ge=0)
    reading_duration_ms: int = Field(ge=0)
    omission_count: int = Field(ge=0)
    repetition_count: int = Field(ge=0)
    long_pause_count: int = Field(ge=0)
    omission_rate: float | None
    repetition_rate: float | None
    long_pause_rate: float | None
    comprehension_accuracy: float | None


class ProgressTrendRead(BaseModel):
    completed_sessions: float | None
    reading_duration_ms: float | None
    omission_rate: float | None
    repetition_rate: float | None
    long_pause_rate: float | None
    comprehension_accuracy: float | None


class SavedProgressPeriodRead(BaseModel):
    completed_sessions: int | None = Field(default=None, ge=0, strict=True)
    reading_duration_ms: int | None = Field(default=None, ge=0, strict=True)
    omission_count: int | None = Field(default=None, ge=0, strict=True)
    repetition_count: int | None = Field(default=None, ge=0, strict=True)
    long_pause_count: int | None = Field(default=None, ge=0, strict=True)
    omission_rate: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False, strict=True)
    repetition_rate: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False, strict=True)
    long_pause_rate: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False, strict=True)
    comprehension_accuracy: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False, strict=True)


class ProgressLegacyRead(BaseModel):
    avg_fluency: float | None = Field(default=None, allow_inf_nan=False, strict=True)
    total_books: int | None = Field(default=None, ge=0, strict=True)


class ProgressPeriodOptionRead(BaseModel):
    id: UUID
    child_id: UUID
    period_start: date
    period_end: date
    generated_at: AwareDatetime


class ProgressPeriodsRead(BaseModel):
    items: list[ProgressPeriodOptionRead]
    next_cursor: str | None


from app.schemas.reading import ReadingAssessmentMetrics


class AssessmentCoverage(BaseModel):
    assessed_sessions: int = Field(ge=0)
    total_sessions: int = Field(ge=0)


class ProgressRead(SavedProgressPeriodRead, ProgressPeriodOptionRead):
    # Derived read-only from finalized session evidence within this saved period.
    assessment: ReadingAssessmentMetrics | None = None
    assessment_coverage: AssessmentCoverage | None = None
    difficult_words: list[DifficultWordRead] | None
    previous_period: ProgressPeriodRead | None
    trend_deltas: ProgressTrendRead | None
    legacy: ProgressLegacyRead | None
    data_status: Literal["complete", "partial", "unsupported"]
    availability: dict[str, Literal["available", "absent", "partial", "unsupported"]]


# Read DTOs match the existing Admin UI contract, not the legacy CRUD payload.
from typing import Literal


class AdminAuditLogRead(BaseModel):
    id: UUID
    actor_id: UUID | None
    action: str
    resource_type: str
    resource_id: UUID | None
    request_id: str | None
    created_at: datetime
    metadata: dict[str, object]


class AdminAuditPageRead(BaseModel):
    items: list[AdminAuditLogRead]
    next_cursor: str | None


OperationalState = Literal[
    "Healthy",
    "Degraded",
    "Offline",
    "Queued",
    "Quota exhausted",
    "Unsupported",
    "Unknown",
    "Standby",
    "Scheduled",
    "Local only",
]

HealthDetailStatus = Literal[
    "installed",
    "initialized",
    "loaded",
    "healthy",
    "failed",
    "unknown",
    "disabled",
    "standby",
    "cached",
    "client_side",
    "cloud_ready",
    "scheduled",
    "remote_delegated",
    "local_only",
]

HealthServiceGroup = Literal["core", "voice", "ocr", "workers"]

HealthExecutionMode = Literal[
    "always_on",
    "in_process",
    "on_demand",
    "cron_scheduled",
    "remote_worker",
    "remote_delegated",
    "precomputed_cache",
    "browser_wasm",
    "cloud_ai",
    "local_only",
    "disabled_opt_in",
]

HealthCriticality = Literal["core", "important", "optional"]


class AdminAudioCacheSummaryRead(BaseModel):
    entry_count: int = Field(ge=0)
    storage_used_bytes: int = Field(ge=0)
    storage_quota_bytes: int = Field(ge=0)
    daily_egress_bytes: int = Field(ge=0)
    daily_egress_limit_bytes: int = Field(ge=0)
    cache_hit_ratio: float | None = Field(default=None, ge=0.0, le=1.0)
    quota_exhausted: bool = False


class AdminHealthItemRead(BaseModel):
    id: str
    label: str
    status: Literal["HEALTHY", "DEGRADED", "UNAVAILABLE"]
    operational_state: OperationalState | None = None
    checked_at: datetime
    safe_message: str
    detail_status: HealthDetailStatus | None = None
    last_success_at: datetime | None = None
    oldest_pending_job_age_seconds: float | None = None
    queue_depth: int | None = None
    last_error: str | None = None
    service_group: HealthServiceGroup | None = None
    execution_mode: HealthExecutionMode | None = None
    criticality: HealthCriticality | None = None
    action_hint: str | None = None
    can_wake: bool = False


class AdminHealthRead(BaseModel):
    overall_status: Literal["HEALTHY", "DEGRADED", "UNAVAILABLE"]
    checked_at: datetime
    services: list[AdminHealthItemRead]
    audio_cache: AdminAudioCacheSummaryRead | None = None
    audio_cache_error: str | None = None


class AdminOcrWorkerWakeupResponse(BaseModel):
    status: Literal["woken", "unconfigured", "failed"]
    woken: bool
    detail: str
