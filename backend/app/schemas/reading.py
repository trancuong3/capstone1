import json

from pydantic import BaseModel, Field, ConfigDict, AwareDatetime, field_validator, model_validator
from typing import Optional, Dict, Any, Literal
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


class ReadingPageWordTimingDTO(BaseModel):
    index: int = Field(ge=0)
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(ge=0, allow_inf_nan=False)


class ReadingDuetSegmentDTO(BaseModel):
    turn_index: int = Field(ge=0)
    role: Literal["PARENT", "CHILD"]
    block_type: str = "STORY_BODY"
    line_indices: list[int] = Field(default_factory=list)
    word_indices: list[int] = Field(default_factory=list)
    text: str


class ReadingPageDTO(BaseModel):
    page_id: UUID
    page_revision_id: UUID
    page_number: int
    # Kept nullable for API compatibility; OCR scores are not page probabilities.
    confidence: Optional[float] = None
    width: int = 1000
    height: int = 1000
    image_url: Optional[str] = None
    # Deterministic public precomputed TTS MP3 URL strictly for verified public catalog pages.
    tts_audio_url: Optional[str] = None
    # Optional precomputed word timings & voice metadata for instant Tier-1 synced playback.
    tts_word_timings: Optional[list[ReadingPageWordTimingDTO]] = None
    tts_voice_id: Optional[str] = None
    tts_cached_speed: Optional[float] = None
    # Legacy or edited geometry has no measured, content-bound proof.
    image_overlay_safe: bool = False
    illustration_url: Optional[str] = None
    illustration_text_free: bool = False
    page_kind: Optional[str] = None
    duet_segments: list[ReadingDuetSegmentDTO] = Field(default_factory=list)
    text: Optional[str] = None
    words: list[ReadingPageWordDTO]
    paragraph_start_line_indices: list[int] = Field(default_factory=list)
    indented_line_indices: list[int] = Field(default_factory=list)

class ReadingAssessmentMetrics(BaseModel):
    first_pass_correct: int = Field(ge=0)
    first_pass_incorrect: int = Field(ge=0)
    self_corrected_words: int = Field(ge=0)
    unresolved_words: int = Field(ge=0)
    retry_attempts: int = Field(ge=0)
    skipped_after_retry_limit: int = Field(ge=0)
    recognition_uncertain: int = Field(ge=0)


class ReadingCompletionSummaryDTO(BaseModel):
    # Null means the current database schema has no persisted evidence for this metric.
    duration_minutes: int | None = Field(default=None, ge=0)
    pages_explored: int | None = Field(default=None, ge=0)
    selected_range_pages: int | None = Field(default=None, ge=0)
    practiced_words: int | None = Field(default=None, ge=0)
    spoken_words: list[str] | None = None
    transcripts: list[str] | None = None
    correct_words: list[str] | None = None
    mispronounced_words: list[str] | None = None
    skipped_words: list[str] | None = None
    score: float | None = Field(default=None, ge=0, le=100)
    assessment: ReadingAssessmentMetrics | None = None

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
    Type: str = Field(..., json_schema_extra={"example": "MISPRONUNCIATION"})
    StartMs: int = Field(..., ge=0, le=2147483647)
    EndMs: Optional[int] = Field(None, ge=0, le=2147483647)
    Confidence: Optional[float] = Field(None, ge=0, le=1)
    Status: str = Field(..., json_schema_extra={"example": "DETECTED"})
    Metadata: Dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_end_after_start(self) -> "ReadingEventBase":
        if self.EndMs is not None and self.EndMs < self.StartMs:
            raise ValueError("EndMs must be greater than or equal to StartMs")
        return self

class ReadingEventCreate(ReadingEventBase):
    SessionId: UUID
    PageId: UUID
    PageRevisionId: UUID
    WordId: Optional[UUID] = None

    @field_validator("Metadata")
    @classmethod
    def bound_write_metadata(cls, value: Dict[str, Any]) -> Dict[str, Any]:
        # Bound new writes only. Historical metadata remains readable through
        # ReadingEventResponse and is never rewritten by this validation.
        try:
            encoded = json.dumps(value, ensure_ascii=False, allow_nan=False,
                                 separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError, RecursionError) as error:
            raise ValueError("Event metadata must be finite JSON data") from error
        if len(encoded) > 64 * 1024:
            raise ValueError("Event metadata must not exceed 64 KiB")
        return value

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
    Score: Optional[float] = Field(None, allow_inf_nan=False)
    Uncertainty: Optional[float] = Field(None, ge=0, le=1, allow_inf_nan=False)

class FluencyAssessmentResponse(FluencyAssessmentBase):
    Id: UUID
    SessionId: UUID
    CreatedAt: datetime
    model_config = ConfigDict(from_attributes=True)


from typing import Literal
from app.schemas.book import CatalogBookResponse

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
    book: CatalogBookResponse | None = None


class SessionHistoryRead(BaseModel):
    sessions: list[HistorySessionSummaryRead]
    next_cursor: str | None


class SessionEventRead(BaseModel):
    id: UUID
    session_id: UUID
    page_id: UUID
    page_revision_id: UUID
    page_revision_word_id: UUID | None
    type: Literal["OMISSION", "REPETITION", "LONG_PAUSE", "SUBSTITUTION", "SELF_CORRECTION", "READ_EXAMPLE","WORD_RETRY"]
    start_ms: int = Field(ge=0)
    end_ms: int | None
    confidence: float | None
    status: Literal["CANDIDATE", "CONFIRMED", "FAILED", "UNCERTAIN", "DISMISSED"]
    metadata: dict[str, object]


class HistoryEventRead(SessionEventRead):
    type: Literal["OMISSION", "REPETITION", "LONG_PAUSE", "SUBSTITUTION", "SELF_CORRECTION", "READ_EXAMPLE", "MISPRONUNCIATION","WORD_RETRY"]
    status: Literal["CANDIDATE", "CONFIRMED", "FAILED", "UNCERTAIN", "DISMISSED", "DETECTED", "FEEDBACK_GIVEN", "IGNORED_BY_GATE"]
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
    assessment: ReadingAssessmentMetrics | None = None
    selected_range_pages: int | None = Field(default=None, ge=0)
    pages_completed: int | None = Field(default=None, ge=0)
    selected_page_revision_ids: list[UUID]
    reference_page_revision_ids: list[UUID]
    events: list[HistoryEventRead]
    fluency_assessment: HistoryFluencyRead | None
    comprehension: list[HistoryComprehensionRead]
    availability: HistoryAvailabilityRead
    report_id: UUID | None


MAX_COMPARE_TRANSCRIPT_CHARS = 10_000
MAX_COMPARE_WORDS = 2_000


class WordTimestamp(BaseModel):
    text: str = Field(..., max_length=120)
    start: float = Field(..., ge=0, allow_inf_nan=False)
    end: float = Field(..., ge=0, allow_inf_nan=False)


class InitialWordAssessment(BaseModel):
    word_id: UUID
    status: Literal["CORRECT", "MISPRONUNCIATION", "OMISSION", "UNCERTAIN"]


class StoredInitialWordAssessment(InitialWordAssessment):
    word_index: int = Field(ge=0)
    text: str = Field(min_length=1)


class PracticePageRead(BaseModel):
    page_id: UUID
    page_revision_id: UUID
    page_number: int = Field(gt=0)
    transcript: str
    initial_assessment: list[StoredInitialWordAssessment]


class PracticeWordRead(BaseModel):
    page_id: UUID
    page_revision_id: UUID
    word_id: UUID
    retry_attempt_count: int = Field(ge=0)
    incorrect_retry_count: int = Field(ge=0, le=3)
    resolution_status: Literal["RETRYING", "SELF_CORRECTED", "UNRESOLVED"]


class ReadingPracticeStateRead(BaseModel):
    session_id: UUID
    legacy_evidence_present: bool = False
    pages: list[PracticePageRead]
    words: list[PracticeWordRead]


class CompareReadingRequest(BaseModel):
    transcript: str = Field(..., min_length=1, max_length=MAX_COMPARE_TRANSCRIPT_CHARS)
    words: list[WordTimestamp] | None = Field(default=None, max_length=MAX_COMPARE_WORDS)
    # New clients bind each transcript to the immutable page snapshot they read.
    # Both fields remain optional for backward compatibility with legacy callers.
    page_id: UUID | None = None
    page_revision_id: UUID | None = None
    # Only final page snapshots participate in first-pass/retry metrics.
    # Existing ad-hoc comparison clients retain their previous behavior.
    finalize: bool = False
    initial_assessment: list[InitialWordAssessment] | None = None


class ReadingComparisonReportRead(BaseModel):
    report_id: UUID
    session_id: UUID
    page_id: UUID
    page_revision_id: UUID
    transcript: str
    distance: int
    alignment: list[dict[str, Any]]
    summary: dict[str, Any]
    created_at: datetime
    self_corrected_word_ids: list[UUID] = Field(default_factory=list)


class ReadingSessionReportsRead(BaseModel):
    assessment: ReadingAssessmentMetrics | None = None
    session_id: UUID
    total: int = Field(ge=0)
    reports: list[ReadingComparisonReportRead]


class ReadingPageWordRead(BaseModel):
    word_id: UUID
    word_index: int = Field(ge=0)
    text: str
    bbox: tuple[float, float, float, float]
    line_index: int = Field(default=0, ge=0)


class ReadingPageRead(BaseModel):
    page_id: UUID
    page_revision_id: UUID
    page_number: int = Field(ge=1)
    confidence: float = Field(ge=0, le=1)
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    words: list[ReadingPageWordRead]


class CameraSpotlightLineRead(BaseModel):
    line_index: int = Field(ge=0)
    text: str
    word_count: int = Field(ge=1)
    points: list[tuple[float, float]] = Field(min_length=4, max_length=4)


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
    homography_matrix: list[float] | None = None
    page_quad: list[tuple[float, float]] | None = None
    spotlight_lines: list[CameraSpotlightLineRead] = Field(default_factory=list)


class OfflineReadingPackBookRead(BaseModel):
    book_id: UUID
    title: str
    author: str | None = None
    min_grade: int = Field(ge=1, le=5)
    max_grade: int = Field(ge=1, le=5)
    visibility_scope: Literal["CATALOG", "PARENT_PRIVATE"] = "CATALOG"
    page_count: int = Field(ge=1)


class OfflineReadingPackResponse(BaseModel):
    pack_version: int = 1
    generated_at: datetime
    book: OfflineReadingPackBookRead
    pages: list[ReadingPageDTO]


class OfflineReadingSyncPageInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_id: UUID
    page_revision_id: UUID
    completed: bool = True
    transcript: str | None = Field(default=None, max_length=12000)
    started_at: datetime | None = None
    completed_at: datetime | None = None


class OfflineReadingSyncEventInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_id: UUID
    page_revision_id: UUID
    word_id: UUID | None = None
    type: Literal[
        "OMISSION",
        "REPETITION",
        "LONG_PAUSE",
        "MISPRONUNCIATION",
        "SUBSTITUTION",
        "SELF_CORRECTION",
        "READ_EXAMPLE",
        "WORD_RETRY",
    ] = "WORD_RETRY"
    status: Literal[
        "DETECTED",
        "IGNORED_BY_GATE",
        "FEEDBACK_GIVEN",
        "CANDIDATE",
        "CONFIRMED",
        "FAILED",
        "UNCERTAIN",
        "DISMISSED",
    ] = "CONFIRMED"
    start_ms: int = Field(default=0, ge=0, le=2147483647)
    end_ms: int | None = Field(default=None, ge=0, le=2147483647)
    confidence: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_bounds(self) -> "OfflineReadingSyncEventInput":
        if self.end_ms is not None and self.end_ms < self.start_ms:
            raise ValueError("end_ms must be greater than or equal to start_ms")
        encoded = json.dumps(
            self.metadata,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(encoded) > 16 * 1024:
            raise ValueError("Offline event metadata must not exceed 16 KiB")
        return self


class OfflineReadingSyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_sync_id: str = Field(min_length=4, max_length=128)
    child_id: UUID
    book_id: UUID
    started_at: datetime
    ended_at: datetime | None = None
    pages: list[OfflineReadingSyncPageInput] = Field(min_length=1, max_length=120)
    events: list[OfflineReadingSyncEventInput] = Field(default_factory=list, max_length=500)

    @field_validator("client_sync_id")
    @classmethod
    def normalize_client_sync_id(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned or any(ord(ch) < 32 or ord(ch) == 127 for ch in cleaned):
            raise ValueError("Invalid client_sync_id")
        return cleaned


class OfflineReadingSyncResponse(BaseModel):
    session_id: UUID
    idempotent_replay: bool = False
    synced_pages_count: int = Field(ge=0)
    synced_reports_count: int = Field(ge=0)
    synced_events_count: int = Field(ge=0)
    skipped_page_ids: list[UUID] = Field(default_factory=list)


class LocalOcrWordRead(BaseModel):
    word_index: int = Field(ge=0)
    line_index: int = Field(ge=0)
    text: str
    normalized_text: str
    bbox: tuple[float, float, float, float]
    ocr_confidence: float | None = Field(default=None, ge=0, le=1)


class LocalOcrProvenanceRead(BaseModel):
    engine: str
    device: Literal["cuda", "cpu", "unknown"]
    engine_statuses: dict[str, str]
    model_profile: str | None = None
    checkpoint_sha256: str | None = None
    model_load_status: str | None = None
    cloud_ocr_used: bool = False
    elapsed_ms: int = Field(ge=0)


class LocalOcrPageScanRead(BaseModel):
    scan_job_id: UUID
    request_id: str
    idempotency_key: UUID | None = None
    status: Literal["SUCCEEDED"] = "SUCCEEDED"
    ocr_text: str
    word_count: int = Field(ge=0)
    words: list[LocalOcrWordRead]
    provenance: LocalOcrProvenanceRead
    matched: bool
    matched_book_id: UUID | None = None
    matched_book_title: str | None = None
    match_confidence: float = Field(ge=0, le=1)
    matched_page: ReadingPageRead | None = None
    message: str


class LocalOcrPageScanJobRead(BaseModel):
    job_id: UUID
    status: Literal[
        "QUEUED",
        "CLAIMED",
        "RUNNING",
        "FAILED_RETRYABLE",
        "SUCCEEDED",
        "DEAD_LETTER",
        "CANCELLED",
    ]
    worker_online: bool
    created_at: datetime
    updated_at: datetime
    file_name: str | None = None
    queue_position: int | None = Field(default=None, ge=1)
    progress_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    worker_phase: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    result: LocalOcrPageScanRead | None = None


class LocalOcrPageScanJobListRead(BaseModel):
    worker_online: bool
    jobs: list[LocalOcrPageScanJobRead]



