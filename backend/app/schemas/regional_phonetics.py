"""Pydantic schemas for Feature #3: Regional Phonetic Profile & Ear-Before-Voice Minimal-Pair Trainer."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# ─── Enums ────────────────────────────────────────────────────────────────────

PhoneticProfile = Literal[
    "STRICT_SGK",
    "NORTH_TOLERANT",
    "CENTRAL_TOLERANT",
    "SOUTH_TOLERANT",
]

VALID_PHONETIC_PROFILES: tuple[PhoneticProfile, ...] = (
    "STRICT_SGK",
    "NORTH_TOLERANT",
    "CENTRAL_TOLERANT",
    "SOUTH_TOLERANT",
)

EarTrainerPhase = Literal["TAI_THINH", "MIENG_XINH"]
EarTrainerCompletionMode = Literal["VOICE_ECHO", "CALM_TAP"]
DialectVisibility = Literal["PARENT_PRIVATE"]


# ─── Profile ──────────────────────────────────────────────────────────────────


class RegionalPhoneticProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    child_id: UUID
    phonetic_profile: PhoneticProfile = "STRICT_SGK"
    visibility: DialectVisibility = "PARENT_PRIVATE"


class RegionalPhoneticProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phonetic_profile: PhoneticProfile = Field(
        ...,
        description="STRICT_SGK | NORTH_TOLERANT | CENTRAL_TOLERANT | SOUTH_TOLERANT",
    )


# ─── Alignment evaluation ─────────────────────────────────────────────────────


class AlignmentEvaluateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reference_text: str = Field(..., min_length=1, max_length=2000)
    spoken_text: str = Field(default="", max_length=2000)
    phonetic_profile_override: PhoneticProfile | None = Field(
        default=None,
        description="Optional override for live parent dual-score fairness preview without mutating saved profile.",
    )


class RegionalVariantMatch(BaseModel):
    reference_word: str
    spoken_word: str
    variant_rule: str  # e.g. "NORTH:onset_l_n", "CENTRAL:tone_hoi_nga"
    book_index: int | None = None


class AlignmentEvaluateResponse(BaseModel):
    phonetic_profile: PhoneticProfile
    strict_sgk_accuracy: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Chuẩn chính tả SGK — strict orthographic match accuracy",
    )
    regional_tolerant_accuracy: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Khoan dung vùng miền — accuracy under regional phonetic equivalences",
    )
    total_reference_words: int = Field(..., ge=0)
    regional_variant_matches: list[RegionalVariantMatch] = Field(default_factory=list)
    true_error_words: list[str] = Field(default_factory=list)
    visibility: DialectVisibility = "PARENT_PRIVATE"


# ─── Ear Trainer ──────────────────────────────────────────────────────────────


class MinimalPairRound(BaseModel):
    round_index: int = Field(..., ge=0)
    target_word: str
    distractor_word: str
    options: list[str] = Field(default_factory=list)
    tts_text: str
    contrastive_keyterms: list[str] = Field(default_factory=list)
    phonics_category: str = "general"
    phonics_category_label_vi: str = "Từ cần ôn"


class EarTrainer30sResponse(BaseModel):
    child_id: UUID
    phonetic_profile: PhoneticProfile
    rounds: list[MinimalPairRound]
    total_rounds: int = 3
    duration_seconds: int = 30
    focus_weak_categories: list[str] = Field(default_factory=list)
    visibility: DialectVisibility = "PARENT_PRIVATE"


class EarTrainerCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rounds_attempted: int = Field(default=3, ge=1, le=10)
    rounds_correct: int = Field(default=0, ge=0, le=10)
    phase_b_spoken: bool = Field(
        default=False,
        description="Whether child attempted Phase B (Miệng Xinh) spoken echo",
    )
    practiced_words: list[str] = Field(default_factory=list, max_length=12)


class EarTrainerCompleteResponse(BaseModel):
    child_id: UUID
    phonetic_profile: PhoneticProfile = "STRICT_SGK"
    rounds_attempted: int
    rounds_correct: int
    accuracy: float = Field(..., ge=0.0, le=1.0)
    phase_b_spoken: bool = False
    completion_mode: EarTrainerCompletionMode = "CALM_TAP"
    xp_earned: int = Field(..., ge=0)
    message_vi: str
    message_en: str
    visibility: DialectVisibility = "PARENT_PRIVATE"
