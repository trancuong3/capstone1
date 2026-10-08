from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any
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


class ProgressRead(ProgressPeriodRead):
    child_id: UUID
    period_start: date
    period_end: date
    difficult_words: list[DifficultWordRead]
    previous_period: ProgressPeriodRead | None
    trend_deltas: ProgressTrendRead


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


class AdminHealthItemRead(BaseModel):
    id: str
    label: str
    status: Literal["HEALTHY", "DEGRADED", "UNAVAILABLE"]
    checked_at: datetime
    safe_message: str


class AdminHealthRead(BaseModel):
    overall_status: Literal["HEALTHY", "DEGRADED", "UNAVAILABLE"]
    checked_at: datetime
    services: list[AdminHealthItemRead]
