from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Dict, Any
from datetime import datetime
from uuid import UUID

# --- READING SESSION ---
class ReadingSessionBase(BaseModel):
    State: str = Field(..., example="IN_PROGRESS")
    Mode: str = Field(default="realtime")
    ClientMeta: Dict[str, Any] = Field(default_factory=dict)

class ReadingSessionCreate(ReadingSessionBase):
    ChildId: UUID
    BookId: UUID
    SelectedPageId: Optional[UUID] = None
    SelectedPageRevisionId: Optional[UUID] = None
    EndedAt: Optional[datetime] = None

class ReadingSessionResponse(ReadingSessionBase):
    Id: UUID
    ChildId: UUID
    BookId: UUID
    SelectedPageId: Optional[UUID]
    SelectedPageRevisionId: Optional[UUID]
    StartedAt: datetime
    EndedAt: Optional[datetime]
    model_config = ConfigDict(from_attributes=True)

# --- READING EVENT ---
class ReadingEventBase(BaseModel):
    Type: str = Field(..., example="MISPRONUNCIATION")
    StartMs: int = Field(..., ge=0)
    EndMs: Optional[int] = None
    Confidence: Optional[float] = Field(None, ge=0, le=1)
    Status: str = Field(..., example="DETECTED")
    Metadata: Dict[str, Any] = Field(default_factory=dict)

class ReadingEventCreate(ReadingEventBase):
    SessionId: UUID
    PageId: UUID
    PageRevisionId: UUID
    WordId: Optional[UUID] = None

class ReadingEventResponse(ReadingEventBase):
    Id: UUID
    SessionId: UUID
    PageId: UUID
    PageRevisionId: UUID
    WordId: Optional[UUID]
    CreatedAt: datetime
    model_config = ConfigDict(from_attributes=True)

# --- FLUENCY ASSESSMENT ---
class FluencyAssessmentBase(BaseModel):
    Metrics: Dict[str, Any]
    Score: Optional[float] = None
    Uncertainty: Optional[float] = Field(None, ge=0, le=1)
    ModelVersion: str

class FluencyAssessmentCreate(FluencyAssessmentBase):
    SessionId: UUID

class FluencyAssessmentResponse(FluencyAssessmentBase):
    Id: UUID
    SessionId: UUID
    CreatedAt: datetime
    model_config = ConfigDict(from_attributes=True)