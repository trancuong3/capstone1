# file: backend/app/schemas/reading.py
from pydantic import BaseModel, UUID4, Field
from typing import Optional, Dict, Any
from datetime import datetime

# --- READING SESSION ---
class ReadingSessionBase(BaseModel):
    State: str = Field(..., example="IN_PROGRESS")
    Mode: str = Field(default="realtime")
    ClientMeta: Dict[str, Any] = Field(default_factory=dict)

class ReadingSessionCreate(ReadingSessionBase):
    ChildId: UUID4
    BookId: UUID4
    SelectedPageId: Optional[UUID4] = None
    SelectedPageRevisionId: Optional[UUID4] = None
    EndedAt: Optional[datetime] = None

class ReadingSessionResponse(ReadingSessionBase):
    Id: UUID4
    ChildId: UUID4
    BookId: UUID4
    SelectedPageId: Optional[UUID4]
    SelectedPageRevisionId: Optional[UUID4]
    StartedAt: datetime
    EndedAt: Optional[datetime]
    class Config:
        from_attributes = True

# --- READING EVENT ---
class ReadingEventBase(BaseModel):
    Type: str = Field(..., example="MISPRONUNCIATION")
    StartMs: int = Field(..., ge=0)
    EndMs: Optional[int] = None
    Confidence: Optional[float] = Field(None, ge=0, le=1)
    Status: str = Field(..., example="DETECTED")
    Metadata: Dict[str, Any] = Field(default_factory=dict)

class ReadingEventCreate(ReadingEventBase):
    SessionId: UUID4
    PageId: UUID4
    PageRevisionId: UUID4
    WordId: Optional[UUID4] = None

class ReadingEventResponse(ReadingEventBase):
    Id: UUID4
    SessionId: UUID4
    PageId: UUID4
    PageRevisionId: UUID4
    WordId: Optional[UUID4]
    CreatedAt: datetime
    class Config:
        from_attributes = True

# --- FLUENCY ASSESSMENT ---
class FluencyAssessmentBase(BaseModel):
    Metrics: Dict[str, Any]
    Score: Optional[float] = None
    Uncertainty: Optional[float] = Field(None, ge=0, le=1)
    ModelVersion: str

class FluencyAssessmentCreate(FluencyAssessmentBase):
    SessionId: UUID4

class FluencyAssessmentResponse(FluencyAssessmentBase):
    Id: UUID4
    SessionId: UUID4
    CreatedAt: datetime
    class Config:
        from_attributes = True