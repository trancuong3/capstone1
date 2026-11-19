"""Strict, admin-only automatic karaoke contracts. No Storage paths are public."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, StrictBool, model_validator

from app.schemas.karaoke import Contract, DraftRequest, Lyrics
from app.schemas.karaoke_processing_types import (
    ProcessingMode, ProcessingStage, ProcessingStatus, QualityFlag,
    ProcessingReviewRead, ProcessingSummary, RetryPolicy, SafeError, SourceKind,
)

class ProcessingStart(DraftRequest):
    idempotency_key: UUID
    mode: ProcessingMode = "VOCAL_TRACK"
    source_kind: SourceKind = "DRAFT_AUDIO"


class ProcessingRetry(DraftRequest):
    idempotency_key: UUID
    acknowledge_possible_charge: StrictBool = False


class ProcessingCancel(Contract):
    draft_version_id: UUID


class ProcessingReview(DraftRequest):
    content_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirmed_listened: StrictBool
    acknowledged_flag_ids: list[UUID] = Field(default_factory=list, max_length=301)

    @model_validator(mode="after")
    def unique_acknowledgments(self):
        if len(set(self.acknowledged_flag_ids)) != len(self.acknowledged_flag_ids):
            raise ValueError("Duplicate flag IDs")
        return self


class ProcessingLimits(Contract):
    max_audio_bytes: int
    max_duration_ms: int
    max_lyric_lines: int = 300
    max_lyric_characters: int = 50000


class ProcessingCapabilities(Contract):
    enabled: bool
    configured: bool
    supported_modes: list[ProcessingMode]
    unavailable_reason: Literal["DISABLED", "PROVIDER_NOT_CONFIGURED"] | None
    limits: ProcessingLimits
    queue_warning_after_seconds: int


class JobRead(Contract):
    id: UUID
    song_id: UUID
    draft_version_id: UUID
    base_revision: int = Field(gt=0)
    mode: ProcessingMode
    source_kind: SourceKind
    status: ProcessingStatus
    stage: ProcessingStage
    input_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None = None
    applied_at: datetime | None = None
    applied_revision: int | None = None
    safe_error_code: SafeError | None = None
    retry_policy: RetryPolicy
    can_apply: bool
    quality_flags: list[QualityFlag] = Field(default_factory=list, max_length=301)


class JobList(Contract):
    items: list[JobRead]
    total: int
    limit: int
    offset: int


class ProcessingPreview(Contract):
    job_id: UUID
    song_id: UUID
    draft_version_id: UUID
    base_revision: int
    input_fingerprint: str
    title: str
    author: str
    duration_ms: int
    audio_url: str
    audio_url_expires_at: datetime
    cover_url: str | None
    reference_audio_url: str | None
    reference_audio_url_expires_at: datetime | None
    lyrics: Lyrics
    quality_flags: list[QualityFlag]


class DraftReferencePreview(Contract):
    song_id: UUID
    draft_version_id: UUID
    revision: int
    content_fingerprint: str
    reference_audio_url: str
    reference_audio_url_expires_at: datetime
