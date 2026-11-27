"""Pydantic schemas for compact Musical Karaoke practice persistence and profiles.

Strict privacy & anti-conflation contract:
- Never accepts or stores raw child audio (forbids extra fields and raw audio payload keys).
- Enforces honest scoring mode invariants matching the PostgreSQL check constraints.
"""

from datetime import datetime
import json
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

PracticeMode = Literal["FULL_SONG", "SEGMENT", "RHYTHM_TAP", "LINE_PRACTICE"]
ScoringMode = Literal[
    "FULL_MUSICAL",
    "RHYTHM_AND_LYRICS",
    "LYRICS_ONLY",
    "INSUFFICIENT_EVIDENCE",
]
AudioType = Literal["VOCAL_FULL", "INSTRUMENTAL_ONLY", "DUAL_TRACK", "UNKNOWN"]
ProfileSourceMethod = Literal[
    "ID3_LRC",
    "AUDIO_DSP",
    "WHISPER_DRAFT",
    "MANUAL_TAP",
    "LYRICS_TIMING",
]
SegmentStatus = Literal["GREAT", "GOOD", "PRACTICE"]

MAX_REPORT_PAYLOAD_BYTES = 32_768
FORBIDDEN_AUDIO_KEYS = frozenset(
    {
        "audio",
        "raw_audio",
        "audio_base64",
        "audio_b64",
        "audio_bytes",
        "audio_blob",
        "audio_data",
        "pcm",
        "pcm_data",
        "pcm_samples",
        "wav",
        "mp3",
        "recording",
        "recording_base64",
        "waveform_samples",
    }
)


def _contains_forbidden_audio_key(value: Any, *, depth: int = 0) -> str | None:
    if depth > 6:
        return "nested_depth_exceeded"
    if isinstance(value, dict):
        for key, nested in value.items():
            normalized = str(key).strip().lower()
            if normalized in FORBIDDEN_AUDIO_KEYS:
                return normalized
            found = _contains_forbidden_audio_key(nested, depth=depth + 1)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _contains_forbidden_audio_key(item, depth=depth + 1)
            if found:
                return found
    return None


class SegmentReportItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line_index: int = Field(..., ge=0, le=500)
    line_id: str | None = Field(default=None, max_length=64)
    start_ms: int = Field(..., ge=0, le=300_000)
    end_ms: int = Field(..., gt=0, le=300_000)
    text: str = Field(..., min_length=1, max_length=300)
    rhythm_score: int | None = Field(default=None, ge=0, le=100)
    pitch_score: int | None = Field(default=None, ge=0, le=100)
    lyrics_score: int | None = Field(default=None, ge=0, le=100)
    status: SegmentStatus
    tip_vi: str = Field(default="", max_length=300)

    @model_validator(mode="after")
    def _validate_span(self) -> "SegmentReportItem":
        if self.end_ms <= self.start_ms:
            raise ValueError("segment end_ms must be greater than start_ms")
        return self


class KaraokePracticeSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    child_id: UUID
    song_id: UUID
    song_version_id: UUID | None = None
    practice_mode: PracticeMode = "FULL_SONG"
    scoring_mode: ScoringMode
    playback_rate: float = Field(default=1.0, ge=0.5, le=1.5)
    headphone_mode: bool = False
    overall_score: int | None = Field(default=None, ge=0, le=100)
    rhythm_score: int | None = Field(default=None, ge=0, le=100)
    pitch_score: int | None = Field(default=None, ge=0, le=100)
    lyrics_score: int | None = Field(default=None, ge=0, le=100)
    fluency_score: int | None = Field(default=None, ge=0, le=100)
    stars: int = Field(default=0, ge=0, le=3)
    segment_start_ms: int | None = Field(default=None, ge=0, le=300_000)
    segment_end_ms: int | None = Field(default=None, gt=0, le=300_000)
    report_payload: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate_contract(self) -> "KaraokePracticeSessionCreate":
        if (self.segment_start_ms is None) != (self.segment_end_ms is None):
            raise ValueError(
                "segment_start_ms and segment_end_ms must both be provided or both omitted"
            )
        if (
            self.segment_start_ms is not None
            and self.segment_end_ms is not None
            and self.segment_end_ms <= self.segment_start_ms
        ):
            raise ValueError("segment_end_ms must be greater than segment_start_ms")

        if self.scoring_mode == "INSUFFICIENT_EVIDENCE":
            if self.overall_score is not None or self.stars != 0:
                raise ValueError(
                    "INSUFFICIENT_EVIDENCE must not claim an overall_score or stars"
                )
            if any(
                s is not None
                for s in (
                    self.rhythm_score,
                    self.pitch_score,
                    self.lyrics_score,
                    self.fluency_score,
                )
            ):
                raise ValueError(
                    "INSUFFICIENT_EVIDENCE must not report non-null sub-scores"
                )
        elif self.scoring_mode == "LYRICS_ONLY":
            if self.pitch_score is not None or self.rhythm_score is not None:
                raise ValueError(
                    "LYRICS_ONLY must not report pitch_score or rhythm_score"
                )
        elif self.scoring_mode == "RHYTHM_AND_LYRICS":
            if self.pitch_score is not None:
                raise ValueError("RHYTHM_AND_LYRICS must not report pitch_score")

        bad_key = _contains_forbidden_audio_key(self.report_payload)
        if bad_key is not None:
            raise ValueError(
                f"Raw audio payloads are strictly forbidden in report_payload ({bad_key})"
            )
        encoded = json.dumps(self.report_payload, ensure_ascii=False).encode("utf-8")
        if len(encoded) > MAX_REPORT_PAYLOAD_BYTES:
            raise ValueError("report_payload exceeds 32 KiB compact summary limit")
        return self


class KaraokePracticeSessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    child_id: UUID
    song_id: UUID
    song_version_id: UUID | None = None
    practice_mode: PracticeMode
    scoring_mode: ScoringMode
    playback_rate: float
    headphone_mode: bool
    overall_score: int | None = None
    rhythm_score: int | None = None
    pitch_score: int | None = None
    lyrics_score: int | None = None
    fluency_score: int | None = None
    stars: int
    segment_start_ms: int | None = None
    segment_end_ms: int | None = None
    report_payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    persisted: bool = True
    storage_notice: str | None = None


class KaraokePracticeHistoryResponse(BaseModel):
    child_id: UUID
    song_id: UUID | None = None
    best_full_song_score: int | None = None
    best_full_song_stars: int = 0
    total_sessions: int = 0
    items: list[KaraokePracticeSessionRead] = Field(default_factory=list)
    storage_ready: bool = True


class PitchContourPointRead(BaseModel):
    time_ms: int = Field(..., ge=0)
    hz: float = Field(..., gt=0)
    midi: float | None = None


class MusicalProfileRead(BaseModel):
    song_id: UUID
    song_version_id: UUID
    bpm: float | None = None
    audio_type: AudioType = "UNKNOWN"
    has_pitch_contour: bool = False
    has_beat_grid: bool = False
    source_method: ProfileSourceMethod = "LYRICS_TIMING"
    beat_grid_ms: list[int] = Field(default_factory=list)
    pitch_contour: list[PitchContourPointRead] = Field(default_factory=list)
    phrase_windows: list[dict[str, int]] = Field(default_factory=list)
    updated_at: datetime | None = None
