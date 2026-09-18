# file: backend/app/schemas/system.py
from pydantic import BaseModel, UUID4, Field
from typing import Optional, Dict, Any
from datetime import datetime, date

# --- PROGRESS REPORT ---
class ProgressReportBase(BaseModel):
    PeriodStart: date
    PeriodEnd: date
    Summary: Dict[str, Any]

class ProgressReportCreate(ProgressReportBase):
    ChildId: UUID4

class ProgressReportResponse(ProgressReportBase):
    Id: UUID4
    ChildId: UUID4
    GeneratedAt: datetime
    class Config:
        from_attributes = True

# --- CONSENT RECORD ---
class ConsentRecordBase(BaseModel):
    Scope: str
    Granted: bool
    GrantedAt: Optional[datetime] = None
    RevokedAt: Optional[datetime] = None

class ConsentRecordCreate(ConsentRecordBase):
    ParentId: UUID4
    ChildId: UUID4

class ConsentRecordResponse(ConsentRecordBase):
    Id: UUID4
    ParentId: UUID4
    ChildId: UUID4
    class Config:
        from_attributes = True

# --- AUDIT LOG ---
class AuditLogBase(BaseModel):
    Action: str
    ResourceType: str
    RequestId: str
    Metadata: Dict[str, Any] = Field(default_factory=dict)

class AuditLogCreate(AuditLogBase):
    ActorId: UUID4
    ResourceId: UUID4

class AuditLogResponse(AuditLogBase):
    Id: UUID4
    ActorId: UUID4
    ResourceId: UUID4
    CreatedAt: datetime
    class Config:
        from_attributes = True