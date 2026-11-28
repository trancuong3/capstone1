"""Pydantic schemas for Feature #5: Prosody, Punctuation-Pause & Intonation Coach."""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

GradeBandVerdict = Literal["EXCELLENT", "GOOD", "DEVELOPING", "NEEDS_PRACTICE"]
PunctuationKind = Literal["COMMA", "PERIOD", "QUESTION", "EXCLAMATION", "NONE"]
BreathingCueType = Literal[
    "COMMA_PAUSE",
    "PERIOD_PAUSE",
    "QUESTION_RISE",
    "EXCLAMATION_ENERGY",
]


class WordTiming(BaseModel):
    """Word-level timing entry from STT / forced alignment."""

    model_config = ConfigDict(populate_by_name=True)

    word: str = Field(min_length=1, max_length=120, description="Surface word string")
    start_ms: int = Field(ge=0, le=600_000, description="Word start timestamp in ms")
    end_ms: int = Field(ge=0, le=600_000, description="Word end timestamp in ms")

    @model_validator(mode="after")
    def _validate_span(self) -> WordTiming:
        if self.end_ms < self.start_ms:
            self.end_ms = self.start_ms
        return self


class ClauseBreakdownResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    clause_index: int = Field(ge=0)
    clause_text: str
    start_word_idx: int = Field(ge=0)
    end_word_idx: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    terminal_punct: str | None = None
    punctuation_kind: PunctuationKind = "NONE"
    observed_pause_ms: float | None = None
    relative_pause_ratio: float | None = None
    expected_pause_ratio: float
    pause_score: float = Field(ge=0, le=100)
    terminal_f0_delta_semitones: float | None = None
    intonation_score: float | None = Field(default=None, ge=0, le=100)


class AnalyzeProsodyRequest(BaseModel):
    """Request body for POST /fluency/children/{child_id}/sessions/{session_id}/analyze-prosody."""

    model_config = ConfigDict(populate_by_name=True)

    reference_text: str = Field(
        min_length=1,
        max_length=8000,
        description="Punctuated Vietnamese reference text for the reading page/passage",
    )
    word_timings: list[WordTiming] = Field(
        default_factory=list,
        max_length=2000,
        description="Word-level timing array (optional when running sample/event-derived check)",
    )
    audio_wav_base64: str | None = Field(
        default=None,
        max_length=16_000_000,
        description="Optional base64-encoded 16kHz mono WAV/PCM audio for YIN F0 & RMS extraction",
    )
    sample_rate: int | None = Field(
        default=None,
        ge=8_000,
        le=48_000,
        description="Optional sample rate hint when raw PCM bytes are supplied",
    )
    f0_frames: list[float | None] | None = Field(
        default=None,
        max_length=15_000,
        description="Optional pre-extracted per-frame F0 array in Hz (null/NaN for unvoiced)",
    )
    rms_frames: list[float] | None = Field(
        default=None,
        max_length=15_000,
        description="Optional pre-extracted short-time RMS energy array",
    )
    hop_ms: int = Field(
        default=20,
        ge=10,
        le=100,
        description="Frame hop duration in milliseconds",
    )


class ProsodyAnalysisResponse(BaseModel):
    """Structured prosody coaching output (strictly PARENT_PRIVATE)."""

    model_config = ConfigDict(populate_by_name=True)

    child_id: UUID
    session_id: UUID
    visibility_scope: Literal["PARENT_PRIVATE"] = "PARENT_PRIVATE"
    comma_pause_score: float = Field(ge=0, le=100)
    period_pause_score: float = Field(ge=0, le=100)
    intonation_contour_score: float = Field(ge=0, le=100)
    overall_prosody_score: float = Field(ge=0, le=100)
    grade_band_verdict: GradeBandVerdict
    coaching_tip_vi: str
    clauses: list[ClauseBreakdownResponse]
    median_inter_word_gap_ms: float = Field(ge=0)
    noise_floor_rms: float = Field(ge=0)
    audio_analyzed: bool
    model_version: str
    persisted: bool


class BreathingCueTokenResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    text: str
    punctuation: str | None = None
    cue_symbol: Literal["•", "••", "↗", "✦"] | None = None
    cue_type: BreathingCueType | None = None
    pause_beats: int = Field(default=0, ge=0, le=4)


class AnnotateCuesRequest(BaseModel):
    """Request body for POST /fluency/annotate-cues."""

    model_config = ConfigDict(populate_by_name=True)

    text: str = Field(
        min_length=1,
        max_length=8000,
        description="Punctuated Vietnamese reading passage text",
    )


class AnnotateCuesResponse(BaseModel):
    """Visual breathing & intonation cue breakdown for Grade 2–5 readers."""

    model_config = ConfigDict(populate_by_name=True)

    original_text: str
    annotated_text: str
    tokens: list[BreathingCueTokenResponse]
    cue_counts: dict[str, int]
    cue_legend: dict[str, str]
