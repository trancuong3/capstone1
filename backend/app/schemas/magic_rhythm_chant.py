"""Schemas for stateless ephemeral AI Magic Rhythm Chant ('Đồng Dao Phép Thuật 80 BPM')."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

MagicChantProviderTier = Literal["GEMINI", "GROQ", "DETERMINISTIC_FALLBACK"]
MagicChantSourceKind = Literal["WEAK_WORDS", "STARTER_FALLBACK"]


class MagicRhythmChantGenerateRequest(BaseModel):
    focus_words: list[str] = Field(default_factory=list, max_length=12)
    teacher_gender: Literal["female", "male"] | None = None
    refresh: bool = False

    model_config = ConfigDict(extra="forbid")


class MagicRhythmChantLineRead(BaseModel):
    line_number: int = Field(ge=1, le=4)
    line_text: str = Field(min_length=4, max_length=240)
    target_word: str = Field(min_length=1, max_length=120)
    normalized_word: str = Field(min_length=1, max_length=120)
    is_weak_target: bool = True
    phonics_category: str = "general"
    phonics_label_vi: str = "Từ cần ôn"
    beat_count: int = Field(default=4, ge=2, le=8)
    clap_hint_vi: str = Field(min_length=4, max_length=200)


class MagicRhythmChantRead(BaseModel):
    chant_id: UUID
    child_id: UUID
    child_grade: int = Field(ge=1, le=5)
    title_vi: str
    intro_vi: str
    ephemeral_badge_vi: str
    dissolve_message_template_vi: str
    bpm: int = Field(default=80, ge=60, le=120)
    source_kind: MagicChantSourceKind
    provider_tier: MagicChantProviderTier
    target_words: list[str]
    lines: list[MagicRhythmChantLineRead] = Field(min_length=3, max_length=4)
    expires_at: datetime
    chant_exp: int
    chant_sig: str = Field(min_length=64, max_length=64)


class MagicRhythmChantCompleteRequest(BaseModel):
    chant_id: UUID
    chant_exp: int = Field(gt=0)
    chant_sig: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    target_words: list[str] = Field(min_length=1, max_length=6)
    lines_completed: int = Field(ge=1, le=4)
    total_lines: int = Field(ge=3, le=4)
    beat_taps_on_time: int = Field(default=0, ge=0, le=32)
    beat_taps_total: int = Field(default=0, ge=0, le=64)
    spoken_correct_count: int = Field(default=0, ge=0, le=4)
    effort_rescued_count: int = Field(default=0, ge=0, le=4)
    used_phonics_hint: bool = False
    mic_mode: Literal["VOICE", "NO_MIC_FALLBACK"] = "VOICE"
    stars_earned: int = Field(ge=1, le=3)
    duration_seconds: int = Field(default=60, ge=1, le=900)

    model_config = ConfigDict(extra="forbid")


class MagicRhythmChantCompleteRead(BaseModel):
    chant_id: UUID
    child_id: UUID
    recorded_evidence_skills: list[str]
    already_recorded: bool = False
    stars_earned: int = Field(ge=1, le=3)
    ephemeral_cleared: bool = True
