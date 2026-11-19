from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, Field

PracticeStatusLiteral = Literal[
    "NOT_PRACTICED",
    "IN_PROGRESS",
    "NEEDS_MORE_PRACTICE",
    "COMPLETED",
]

PracticeAssessmentStatusLiteral = Literal[
    "CORRECT",
    "INCORRECT",
    "UNCERTAIN",
    "NO_CLEAR_AUDIO",
    "ENGINE_ERROR",
]

PracticeRecognitionSourceLiteral = Literal[
    "SERVER_STT",
    "SERVER_STT_KEYTERM",
    "BROWSER_SPEECH",
    "AUDIO_QUALITY_GATE",
    "ENGINE_ERROR",
]


class DifficultWordPracticeStartRequest(BaseModel):
    request_id: UUID
    normalized_word: str = Field(min_length=1, max_length=120)
    display_text: str | None = Field(default=None, max_length=120)
    evidence_word_ids: list[UUID] = Field(default_factory=list, max_length=50)
    book_id: UUID | None = None
    session_id: UUID | None = None
    page_id: UUID | None = None
    page_revision_id: UUID | None = None
    word_id: UUID | None = None


class DifficultWordPracticeCompleteRequest(BaseModel):
    completion_request_id: UUID
    assessment_status: PracticeAssessmentStatusLiteral
    recognition_source: PracticeRecognitionSourceLiteral
    spoken_transcript: str | None = Field(default=None, max_length=160)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0, allow_inf_nan=False)
    audio_duration_ms: int | None = Field(default=None, ge=0, le=60_000)


class DifficultWordProgressSummaryRead(BaseModel):
    normalized_word: str
    practice_status: PracticeStatusLiteral
    practice_attempts_count: int = Field(ge=0)
    practice_correct_count: int = Field(ge=0)
    practice_incorrect_count: int = Field(ge=0)
    practice_uncertain_count: int = Field(ge=0)
    consecutive_correct_count: int = Field(ge=0)
    required_consecutive_correct: int = Field(default=1, ge=1)
    last_practiced_at: AwareDatetime | None = None
    last_practice_status: PracticeAssessmentStatusLiteral | None = None


class DifficultWordPracticeAttemptRead(BaseModel):
    attempt_id: UUID
    child_id: UUID
    normalized_word: str
    display_text: str
    attempt_number: int = Field(ge=1)
    state: Literal["STARTED", "COMPLETED"]
    assessment_status: PracticeAssessmentStatusLiteral | None = None
    recognition_source: PracticeRecognitionSourceLiteral | None = None
    spoken_transcript: str | None = None
    confidence: float | None = None
    audio_duration_ms: int | None = None
    assessment_version: int = Field(default=1, ge=1)
    evidence_word_ids: list[UUID] = Field(default_factory=list)
    book_id: UUID | None = None
    session_id: UUID | None = None
    page_id: UUID | None = None
    page_revision_id: UUID | None = None
    word_id: UUID | None = None
    resolved_in_session: bool = False
    persistence_backend: Literal[
        "PRACTICE_TABLE_AND_EVENT",
        "PRACTICE_TABLE",
        "READING_EVENT",
    ] | None = None
    started_at: AwareDatetime
    completed_at: AwareDatetime | None = None
    feedback_message: str | None = None
    word_progress: DifficultWordProgressSummaryRead
    next_recommended_word: str | None = None
    evidence_count_unchanged: Literal[True] = True


class DifficultWordPracticeHistoryItemRead(BaseModel):
    attempt_id: UUID
    normalized_word: str
    display_text: str
    attempt_number: int = Field(ge=1)
    state: Literal["STARTED", "COMPLETED"]
    assessment_status: PracticeAssessmentStatusLiteral | None = None
    recognition_source: PracticeRecognitionSourceLiteral | None = None
    spoken_transcript: str | None = None
    confidence: float | None = None
    audio_duration_ms: int | None = None
    assessment_version: int = Field(default=1, ge=1)
    started_at: AwareDatetime
    completed_at: AwareDatetime | None = None


class DifficultWordPracticeHistoryRead(BaseModel):
    storage_ready: bool
    items: list[DifficultWordPracticeHistoryItemRead]
