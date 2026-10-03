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