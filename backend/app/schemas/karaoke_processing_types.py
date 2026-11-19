"""Small shared admin DTOs, independent of the lyric and request modules."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

ProcessingStatus = Literal["QUEUED", "RUNNING", "READY", "NEEDS_REVIEW", "FAILED", "CANCELLED", "STALE", "APPLIED"]
ProcessingStage = Literal["QUEUED", "VALIDATING_INPUT", "PREPARING_AUDIO", "ALIGNING_LYRICS", "VALIDATING_RESULT", "COMPLETE"]
ProcessingMode = Literal["VOCAL_TRACK", "INSTRUMENTAL_WITH_REFERENCE"]
SourceKind = Literal["DRAFT_AUDIO", "ORIGINAL_RECORDING"]
RetryPolicy = Literal["NONE", "SAFE_RETRY", "NEEDS_INPUT_CHANGE", "EXPLICIT_COST_ACK"]
QualityCode = Literal["LOW_ALIGNMENT_SUPPORT", "LYRIC_MISMATCH", "AMBIGUOUS_REPEAT", "UNALIGNED_SYLLABLES", "HELD_NOTE_UNCERTAIN", "BACKGROUND_ARTIFACT"]
SafeError = Literal[
    "NO_USABLE_VOCALS", "REFERENCE_TIMELINE_MISMATCH", "LYRICS_NOT_MATCHED",
    "PROVIDER_QUOTA_EXCEEDED", "PROVIDER_TIMEOUT", "PROVIDER_OUTCOME_UNKNOWN",
    "INVALID_PROVIDER_RESULT", "MEDIA_UNAVAILABLE", "ACTOR_UNAVAILABLE",
    "PROCESSING_CONFIGURATION_INVALID",
]


class ProcessingContract(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class QualityFlag(ProcessingContract):
    id: UUID
    codes: list[QualityCode] = Field(min_length=1, max_length=6)
    line_id: UUID | None = None
    syllable_ids: list[UUID] = Field(default_factory=list, max_length=10)
    affected_syllable_count: StrictInt = Field(ge=0, le=10000)
    message_key: QualityCode

    @model_validator(mode="after")
    def message_matches(self):
        if self.message_key not in self.codes or len(set(self.codes)) != len(self.codes):
            raise ValueError("Invalid quality flag")
        if len(set(self.syllable_ids)) != len(self.syllable_ids):
            raise ValueError("Duplicate syllable IDs")
        return self


class ProcessingSummary(ProcessingContract):
    job_id: UUID
    draft_version_id: UUID
    status: ProcessingStatus
    stage: ProcessingStage
    safe_error_code: SafeError | None = None
    retry_policy: RetryPolicy
    updated_at: datetime


class ProcessingReviewRead(ProcessingContract):
    required: bool = False
    current_content_fingerprint: str | None = None
    reviewed: bool = False
    reviewed_at: datetime | None = None
    quality_flags: list[QualityFlag] = Field(default_factory=list, max_length=301)
