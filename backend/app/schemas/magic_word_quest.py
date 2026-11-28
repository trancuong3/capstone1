"""Schemas for stateless ephemeral AI Magic Word Quest ('Nhiệm vụ Phép Thuật 60s')."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

MagicQuestProviderTier = Literal["GEMINI", "GROQ", "DETERMINISTIC_FALLBACK"]
MagicQuestSourceKind = Literal["WEAK_WORDS", "STARTER_FALLBACK"]


class MagicQuestGenerateRequest(BaseModel):
    focus_words: list[str] = Field(default_factory=list, max_length=12)
    teacher_gender: Literal["female", "male"] | None = None
    refresh: bool = False

    model_config = ConfigDict(extra="forbid")


class MagicQuestPromptSlotRead(BaseModel):
    position: int = Field(ge=0)
    text: str | None = None
    is_blank: bool = False
    is_target_word: bool = False


class MagicQuestChoiceTokenRead(BaseModel):
    id: UUID
    text: str
    is_target: bool = False


class MagicQuestRoundRead(BaseModel):
    round_number: int = Field(ge=1, le=4)
    target_word: str = Field(min_length=1, max_length=120)
    normalized_word: str = Field(min_length=1, max_length=120)
    is_weak_target: bool = True
    phonics_category: str = "general"
    phonics_label_vi: str = "Từ cần ôn"
    sentence_text: str = Field(min_length=4, max_length=240)
    prompt_hint_vi: str = Field(min_length=4, max_length=200)
    prompt_slots: list[MagicQuestPromptSlotRead]
    choices: list[MagicQuestChoiceTokenRead] = Field(min_length=2, max_length=4)
    expected_choice_id: UUID


class MagicWordQuestRead(BaseModel):
    quest_id: UUID
    child_id: UUID
    child_grade: int = Field(ge=1, le=5)
    title_vi: str
    intro_vi: str
    ephemeral_badge_vi: str
    dissolve_message_template_vi: str
    source_kind: MagicQuestSourceKind
    provider_tier: MagicQuestProviderTier
    target_words: list[str]
    rounds: list[MagicQuestRoundRead] = Field(min_length=3, max_length=4)
    expires_at: datetime
    quest_exp: int
    quest_sig: str = Field(min_length=64, max_length=64)


class MagicQuestCompleteRequest(BaseModel):
    quest_id: UUID
    quest_exp: int = Field(gt=0)
    quest_sig: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    target_words: list[str] = Field(min_length=1, max_length=6)
    rounds_completed: int = Field(ge=1, le=4)
    total_rounds: int = Field(ge=3, le=4)
    tap_correct_count: int = Field(default=0, ge=0, le=16)
    tap_mistake_count: int = Field(default=0, ge=0, le=40)
    spoken_correct_count: int = Field(default=0, ge=0, le=4)
    effort_rescued_count: int = Field(default=0, ge=0, le=4)
    used_phonics_hint: bool = False
    mic_mode: Literal["VOICE", "NO_MIC_FALLBACK"] = "VOICE"
    stars_earned: int = Field(ge=1, le=3)
    duration_seconds: int = Field(default=60, ge=1, le=900)

    model_config = ConfigDict(extra="forbid")


class MagicQuestCompleteRead(BaseModel):
    quest_id: UUID
    child_id: UUID
    recorded_evidence_skills: list[str]
    already_recorded: bool = False
    stars_earned: int = Field(ge=1, le=3)
    ephemeral_cleared: bool = True
