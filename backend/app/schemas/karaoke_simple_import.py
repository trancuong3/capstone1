"""Strict contracts for Admin Karaoke One-File Simple Mode import, pipeline bridge & publish."""
import math
from typing import Literal
from uuid import UUID

from pydantic import Field, StrictBool, StrictInt, field_validator, model_validator

from app.schemas.karaoke import AdminDetail, Contract, Lyrics, clean_text
from app.schemas.karaoke_processing_types import (
    ProcessingMode,
    ProcessingStage,
    ProcessingStatus,
    QualityFlag,
    RetryPolicy,
    SafeError,
    SourceKind,
)

AudioType = Literal["VOCAL_FULL", "INSTRUMENTAL_ONLY", "DUAL_TRACK", "UNKNOWN"]
LyricsSource = Literal[
    "EMBEDDED_SYNCED",
    "EMBEDDED_UNSYNCED",
    "ADMIN_TEXT",
    "GROQ_WHISPER",
    "NONE",
]
FlagKind = Literal["NEEDS_REVIEW", "NEEDS_TIMING_CHECK"]
SimplePipelineLifecycleState = Literal[
    "UPLOADED",
    "QUEUED",
    "SEPARATING_AUDIO",
    "TRANSCRIBING_LYRICS",
    "ALIGNING_LYRICS",
    "ANALYZING_RHYTHM",
    "ANALYZING_MELODY",
    "READY_FOR_REVIEW",
    "NEEDS_REVIEW",
    "FAILED",
]


class FlaggedLyricLine(Contract):
    line_id: UUID
    line_index: int = Field(ge=0)
    text: str
    flag: FlagKind
    reason: str
    avg_logprob: float | None = None
    no_speech_prob: float | None = None


class SimpleImportResult(Contract):
    song_id: UUID
    version_id: UUID
    revision: int = Field(ge=1)
    title: str
    author: str
    duration_ms: int = Field(ge=1)
    has_cover: bool
    audio_type: AudioType
    bpm: float | None = None
    lyrics_source: LyricsSource
    lyrics_line_count: int = Field(ge=0)
    flagged_lines: list[FlaggedLyricLine] = Field(default_factory=list)
    requires_lyrics_input: bool
    guidance_vi: str
    ready_to_publish: bool
    missing_checks: list[str] = Field(default_factory=list)
    lifecycle_state: SimplePipelineLifecycleState = "UPLOADED"
    worker_online: bool = False
    processing_queued: bool = False
    processing_job_id: UUID | None = None
    processing_notice: str | None = None
    song: AdminDetail


class SimpleProcessingStartRequest(Contract):
    expected_revision: StrictInt = Field(ge=1)
    draft_version_id: UUID
    idempotency_key: UUID | None = None
    mode: ProcessingMode = "VOCAL_TRACK"
    source_kind: SourceKind = "DRAFT_AUDIO"
    audio_type: AudioType | None = None
    bpm: float | None = Field(default=None, ge=30.0, le=240.0)
    lyrics: Lyrics | None = None

    @field_validator("bpm", mode="before")
    @classmethod
    def validate_bpm(cls, value):
        if value is None:
            return None
        if isinstance(value, bool):
            raise ValueError("BPM must be a number")
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError("BPM must be finite")
        return parsed


class SimpleProcessingApplyRequest(Contract):
    expected_revision: StrictInt = Field(ge=1)
    draft_version_id: UUID
    job_id: UUID
    audio_type: AudioType | None = None
    bpm: float | None = Field(default=None, ge=30.0, le=240.0)

    @field_validator("bpm", mode="before")
    @classmethod
    def validate_bpm(cls, value):
        if value is None:
            return None
        if isinstance(value, bool):
            raise ValueError("BPM must be a number")
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError("BPM must be finite")
        return parsed


class SimpleProcessingStatusRead(Contract):
    song_id: UUID
    draft_version_id: UUID | None = None
    revision: int = Field(ge=1)
    lifecycle_state: SimplePipelineLifecycleState
    worker_online: bool
    processing_enabled: bool
    processing_configured: bool
    job_id: UUID | None = None
    job_status: ProcessingStatus | None = None
    job_stage: ProcessingStage | None = None
    can_apply: bool = False
    review_required: bool = False
    reviewed: bool = False
    has_beat_grid: bool = False
    has_pitch_contour: bool = False
    bpm: float | None = None
    safe_error_code: SafeError | None = None
    retry_policy: RetryPolicy | None = None
    quality_flags: list[QualityFlag] = Field(default_factory=list, max_length=301)
    guidance_vi: str
    song: AdminDetail


class SimplePublishRequest(Contract):
    expected_revision: StrictInt = Field(ge=1)
    draft_version_id: UUID
    rights_confirmed: StrictBool = False
    child_safe_confirmed: StrictBool = False
    title: str | None = Field(default=None, max_length=200)
    author: str | None = Field(default=None, max_length=200)
    min_grade: StrictInt | None = Field(default=None, ge=1, le=5)
    max_grade: StrictInt | None = Field(default=None, ge=1, le=5)
    source_note: str | None = Field(default=None, max_length=1000)
    usage_note: str | None = Field(default=None, max_length=1000)
    lyrics: Lyrics | None = None

    @field_validator("title", "author", "source_note", "usage_note")
    @classmethod
    def normalize_optional(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return clean_text(value)

    @model_validator(mode="after")
    def validate_grade_pair(self):
        if (
            self.min_grade is not None
            and self.max_grade is not None
            and self.min_grade > self.max_grade
        ):
            raise ValueError("Invalid grade range")
        return self
