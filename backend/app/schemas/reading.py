from pydantic import BaseModel, Field, ConfigDict, AwareDatetime
from typing import Optional, Dict, Any
from datetime import datetime
from uuid import UUID

# --- READING SESSION ---
class ReadingSessionBase(BaseModel):
    State: str = Field(default="CREATED")
    Mode: str = Field(default="realtime")
    ClientMeta: Dict[str, Any] = Field(default_factory=dict)

class ReadingSessionCreate(ReadingSessionBase):
    ChildId: Optional[UUID] = None
    child_id: Optional[UUID] = None
    BookId: Optional[UUID] = None
    book_id: Optional[UUID] = None
    state: Optional[str] = None
    mode: Optional[str] = None
    SelectedPageId: Optional[UUID] = None
    selected_page_id: Optional[UUID] = None
    SelectedPageRevisionId: Optional[UUID] = None
    selected_page_revision_id: Optional[UUID] = None
    EndPageId: Optional[UUID] = None
    end_page_id: Optional[UUID] = None
    EndedAt: Optional[datetime] = None
    ended_at: Optional[datetime] = None

class ReadingPageWordDTO(BaseModel):
    word_id: UUID
    word_index: int
    text: str
    bbox: tuple[float, float, float, float]
    # Default keeps responses compatible with legacy rows and test fixtures.
    line_index: int = Field(default=0, ge=0)

class ReadingPageDTO(BaseModel):
    page_id: UUID
    page_revision_id: UUID
    page_number: int
    # Optional because legacy OCR rows may not have a genuine confidence score.
    confidence: Optional[float] = None
    width: int = 1000
    height: int = 1000
    image_url: Optional[str] = None
    text: Optional[str] = None
    words: list[ReadingPageWordDTO]
    paragraph_start_line_indices: list[int] = Field(default_factory=list)
    indented_line_indices: list[int] = Field(default_factory=list)

class ReadingCompletionSummaryDTO(BaseModel):
    # Null means the current database schema has no persisted evidence for this metric.
    duration_minutes: int | None = Field(default=None, ge=0)
    pages_explored: int | None = Field(default=None, ge=0)
    selected_range_pages: int | None = Field(default=None, ge=0)
    practiced_words: int | None = Field(default=None, ge=0)
    spoken_words: list[str] | None = None
    transcripts: list[str] | None = None

class ReadingSessionResponse(ReadingSessionBase):
    Id: UUID
    ChildId: UUID
    BookId: UUID
    SelectedPageId: Optional[UUID] = None
    SelectedPageRevisionId: Optional[UUID] = None
    StartPageId: Optional[UUID] = None
    EndPageId: Optional[UUID] = None
    CurrentPageId: Optional[UUID] = None
    StartedAt: datetime
    EndedAt: Optional[datetime] = None
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


class ReadingPageNavigationCreate(BaseModel):
    target_page_id: UUID


class ReadingSessionPageProgressItem(BaseModel):
    page_id: UUID
    page_revision_id: UUID
    page_number: int = Field(ge=1)
    page_order: int = Field(ge=0)
    status: Literal["PENDING", "IN_PROGRESS", "COMPLETED"]
    started_at: datetime | None = None
    completed_at: datetime | None = None


class ReadingSessionPageProgressDTO(BaseModel):
    session_id: UUID
    persisted: bool = True
    start_page_id: UUID
    end_page_id: UUID
    current_page_id: UUID
    start_page_number: int = Field(ge=1)
    end_page_number: int = Field(ge=1)
    current_page_number: int = Field(ge=1)
    current_index: int = Field(ge=0)
    total_pages: int = Field(ge=1)
    completed_pages: int = Field(ge=0)
    pages: list[ReadingSessionPageProgressItem]


class HistorySessionSummaryRead(SessionSummaryRead):
    # History understands persisted session states without changing live reading.
    state: SessionStateRead | Literal["IN_PROGRESS"]
    started_at: AwareDatetime
    ended_at: AwareDatetime | None


class SessionHistoryRead(BaseModel):
    sessions: list[HistorySessionSummaryRead]
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


class HistoryEventRead(SessionEventRead):
    type: Literal["OMISSION", "REPETITION", "LONG_PAUSE", "SUBSTITUTION", "SELF_CORRECTION", "READ_EXAMPLE", "MISPRONUNCIATION"]
    status: Literal["CANDIDATE", "CONFIRMED", "UNCERTAIN", "DISMISSED", "DETECTED", "FEEDBACK_GIVEN", "IGNORED_BY_GATE"]
    end_ms: int | None = Field(ge=0)
    confidence: float | None = Field(ge=0, le=1, allow_inf_nan=False)


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


class HistoryFluencyMetricsRead(SessionFluencyMetricsRead):
    model_config = ConfigDict(allow_inf_nan=False)


class HistoryFluencyRead(SessionFluencyRead):
    metrics: HistoryFluencyMetricsRead | None
    model_config = ConfigDict(allow_inf_nan=False)


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


class HistoryQuestionRead(SessionQuestionRead):
    source_span: SessionSourceSpanRead | None
    difficulty: float | str | None
    model_config = ConfigDict(allow_inf_nan=False)


class HistoryAnswerRead(SessionAnswerRead):
    model_config = ConfigDict(allow_inf_nan=False)


class HistoryComprehensionRead(BaseModel):
    question: HistoryQuestionRead
    answer: HistoryAnswerRead | None


HistorySectionStatus = Literal["absent", "available", "partial", "unsupported"]


class HistoryAvailabilityRead(BaseModel):
    events: HistorySectionStatus
    fluency: HistorySectionStatus
    comprehension: HistorySectionStatus


class SessionDetailRead(HistorySessionSummaryRead):
    selected_page_revision_ids: list[UUID]
    reference_page_revision_ids: list[UUID]
    events: list[HistoryEventRead]
    fluency_assessment: HistoryFluencyRead | None
    comprehension: list[HistoryComprehensionRead]
    availability: HistoryAvailabilityRead
    report_id: UUID | None


class ReadingPageWordRead(BaseModel):
    word_id: UUID
    word_index: int = Field(ge=0)
    text: str
    bbox: tuple[float, float, float, float]


class ReadingPageRead(BaseModel):
    page_id: UUID
    page_revision_id: UUID
    page_number: int = Field(ge=1)
    confidence: float = Field(ge=0, le=1)
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    words: list[ReadingPageWordRead]


class CameraPageMatchRead(BaseModel):
    framing_valid: bool
    matched: bool
    book_id: UUID | None = None  # Bổ sung ID cuốn sách được nhận diện
    status_code: Literal[
        "INVALID_IMAGE",
        "TOO_DARK",
        "TOO_BLURRY",
        "OUT_OF_FRAME",
        "FRAME_OK",
        "MATCHED",
        "LOW_CONFIDENCE",
    ]
    message: str
    confidence: float = Field(ge=0, le=1)
    matched_page: ReadingPageRead | None = None
