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


from typing import Literal

SessionStateRead = Literal["CREATED", "PAGE_READY", "LISTENING", "PAUSED", "RECONNECTING", "QUESTIONING", "FINISHED", "ABORTED"]


class SessionSummaryRead(BaseModel):
    id: UUID
    child_id: UUID
    book_id: UUID
    state: SessionStateRead
    started_at: datetime
    ended_at: datetime | None
    duration_ms: int | None = Field(ge=0)


class SessionHistoryRead(BaseModel):
    sessions: list[SessionSummaryRead]
    next_cursor: str | None


class SessionEventRead(BaseModel):
    id: UUID
    session_id: UUID
    page_id: UUID
    page_revision_id: UUID
    page_revision_word_id: UUID | None
    type: Literal["OMISSION", "REPETITION", "LONG_PAUSE", "SUBSTITUTION", "SELF_CORRECTION", "READ_EXAMPLE"]
    start_ms: int = Field(ge=0)
    end_ms: int | None
    confidence: float | None
    status: Literal["CANDIDATE", "CONFIRMED", "UNCERTAIN", "DISMISSED"]
    metadata: dict[str, object]


class SessionFluencyMetricsRead(BaseModel):
    active_reading_ms: int = Field(ge=0)
    reference_words_attempted: int = Field(ge=0)
    confirmed_error_words: int = Field(ge=0)
    accuracy_percent: float | None
    reading_wpm: float | None
    repetition_rate: float | None
    long_pause_rate: float | None
    mean_pause_ms: float | None
    median_pause_ms: float | None


class SessionFluencyRead(BaseModel):
    metrics: SessionFluencyMetricsRead
    score: float | None
    uncertainty: float | None
    model_version: str


class SessionSourceSpanRead(BaseModel):
    start_word_index: int = Field(ge=0)
    end_word_index_exclusive: int = Field(ge=0)
    sentence_index: int | None


class SessionQuestionRead(BaseModel):
    id: UUID
    type: Literal["FACTUAL", "CLOZE", "VOCABULARY"]
    prompt: str
    page_revision_id: UUID
    source_span: SessionSourceSpanRead
    difficulty: float
    answered: bool


class SessionAnswerRead(BaseModel):
    answer_id: UUID
    question_id: UUID
    submitted_answer: str
    is_correct: bool | None
    score: float | None
    feedback_code: str | None


class SessionComprehensionRead(BaseModel):
    question: SessionQuestionRead
    answer: SessionAnswerRead | None


class SessionDetailRead(SessionSummaryRead):
    selected_page_revision_ids: list[UUID]
    reference_page_revision_ids: list[UUID]
    events: list[SessionEventRead]
    fluency_assessment: SessionFluencyRead | None
    comprehension: list[SessionComprehensionRead]
    report_id: UUID | None
