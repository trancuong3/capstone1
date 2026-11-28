"""Pydantic schemas for Feature #8 Offline Reading Pack Manifest & Outbox Sync."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.reading import ReadingPageWordTimingDTO

OfflinePackVisibilityScope = Literal["CATALOG", "PARENT_PRIVATE"]
OfflineSyncEventKind = Literal[
    "SESSION_START",
    "PAGE_READ",
    "WORD_ATTEMPT",
    "SESSION_FINISH",
]
OfflineReadingEventType = Literal[
    "OMISSION",
    "REPETITION",
    "LONG_PAUSE",
    "MISPRONUNCIATION",
    "SUBSTITUTION",
    "SELF_CORRECTION",
    "READ_EXAMPLE",
    "WORD_RETRY",
]
OfflineReadingEventStatus = Literal[
    "DETECTED",
    "IGNORED_BY_GATE",
    "FEEDBACK_GIVEN",
    "CANDIDATE",
    "CONFIRMED",
    "FAILED",
    "UNCERTAIN",
    "DISMISSED",
]


class OfflinePackWordDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    word_id: UUID
    word_index: int = Field(ge=0)
    line_index: int = Field(default=0, ge=0)
    text: str = Field(min_length=1, max_length=120)
    normalized_text: str = Field(default="", max_length=120)
    bbox: tuple[float, float, float, float]


class OfflinePackPageTtsDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cached: bool = False
    cache_scope: Literal["CATALOG", "PRIVATE"]
    voice_id: str
    model_version: str | None = None
    speed: float = Field(default=1.0, gt=0.0, le=2.0, allow_inf_nan=False)
    audio_format: str | None = None
    byte_size: int = Field(default=0, ge=0)
    duration_seconds: float | None = Field(default=None, ge=0.0, allow_inf_nan=False)
    audio_url: str | None = None
    inline_audio_base64: str | None = None
    word_timings: list[ReadingPageWordTimingDTO] | None = None


class OfflinePackPageManifestDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_id: UUID
    page_number: int = Field(ge=1)
    page_revision_id: UUID
    width: int = Field(default=1000, ge=1)
    height: int = Field(default=1000, ge=1)
    verified_text: str = Field(min_length=1)
    words: list[OfflinePackWordDTO]
    phonics_keyterms: list[str] = Field(default_factory=list)
    image_url: str | None = None
    tts_audio: OfflinePackPageTtsDTO | None = None


class OfflineReadingPackManifestResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    manifest_version: int = 1
    parent_account_id: UUID
    child_profile_id: UUID
    book_id: UUID
    title: str
    author: str | None = None
    grade: int = Field(ge=1, le=5)
    min_grade: int = Field(ge=1, le=5)
    max_grade: int = Field(ge=1, le=5)
    visibility_scope: OfflinePackVisibilityScope
    cover_url: str | None = None
    voice_id: str
    estimated_bytes: int = Field(ge=0)
    tts_budget_bytes: int = Field(ge=0)
    generated_at: datetime
    pages: list[OfflinePackPageManifestDTO]


class OfflineSyncEventItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_event_id: UUID
    client_session_id: UUID
    book_id: UUID
    page_id: UUID
    page_revision_id: UUID
    event_kind: OfflineSyncEventKind = "WORD_ATTEMPT"
    occurred_at: datetime | None = None
    word_id: UUID | None = None
    word_text: str | None = Field(default=None, max_length=120)
    transcript: str | None = Field(default=None, max_length=10_000)
    reading_event_type: OfflineReadingEventType | None = None
    reading_event_status: OfflineReadingEventStatus | None = None
    is_correct: bool | None = None
    score: float | None = Field(default=None, ge=0.0, le=100.0, allow_inf_nan=False)
    start_ms: int = Field(default=0, ge=0, le=2147483647)
    end_ms: int | None = Field(default=None, ge=0, le=2147483647)
    duration_ms: int | None = Field(default=None, ge=0, le=86_400_000)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0, allow_inf_nan=False)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("metadata")
    @classmethod
    def validate_bounded_metadata(cls, value: dict[str, Any]) -> dict[str, Any]:
        try:
            encoded = json.dumps(
                value,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError, RecursionError) as exc:
            raise ValueError("Offline sync metadata must be finite JSON") from exc
        if len(encoded) > 16 * 1024:
            raise ValueError("Offline sync metadata must not exceed 16 KiB")
        return value

    @model_validator(mode="after")
    def validate_timing_bounds(self) -> "OfflineSyncEventItem":
        if self.end_ms is not None and self.end_ms < self.start_ms:
            raise ValueError("end_ms must be greater than or equal to start_ms")
        return self


class OfflineSyncOutboxRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    events: list[OfflineSyncEventItem] = Field(..., min_length=1, max_length=200)


class OfflineSyncEventResultDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_event_id: UUID
    client_session_id: UUID
    server_session_id: UUID
    applied: bool
    deduplicated: bool
    stale_revision_reconciled: bool
    original_page_revision_id: UUID
    effective_page_revision_id: UUID | None = None
    reading_event_id: UUID | None = None
    fluency_assessment_id: UUID | None = None


class OfflineSyncOutboxResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    child_id: UUID
    batch_idempotency_key: str | None = None
    total_received: int = Field(ge=0)
    applied_count: int = Field(ge=0)
    deduplicated_count: int = Field(ge=0)
    reconciled_stale_count: int = Field(ge=0)
    session_ids: list[UUID] = Field(default_factory=list)
    results: list[OfflineSyncEventResultDTO] = Field(default_factory=list)
