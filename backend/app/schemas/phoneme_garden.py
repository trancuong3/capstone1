"""Pydantic V2 schemas for Feature #7: 7-Bed Vietnamese Phoneme Garden & Book Stamp Passport.

Strictly `PARENT_PRIVATE` and designed around Calm, Zero-Dark-Pattern Pedagogy:
- No coins, no competitive leaderboards/rankings, no streak-loss penalties or wilting plants.
- Every phonics flower bed and commemorative stamp progresses monotonically from genuine
  Vietnamese reading and phonics practice.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

PhonicsBedKey = Literal[
    "l_n",
    "s_x",
    "tr_ch",
    "r_d_gi",
    "hoi_nga",
    "coda_n_ng_t_c",
    "compound_reduplicative",
]

BedStage = Literal["SEED", "SPROUT", "BUD", "BLOOM"]

PlantSymbolKey = Literal[
    "lotus",
    "apricot",
    "bamboo",
    "sunflower",
    "chrysanthemum",
    "peach",
    "flamboyant",
]

BookStampMotif = Literal[
    "LOTUS_SEAL",
    "BAMBOO_SCROLL",
    "STARLIGHT_LANTERN",
    "SUNRISE_KITE",
    "BANYAN_LEAF",
]

MilestoneStampKey = Literal[
    "first_session",
    "five_sessions",
    "ten_sessions",
    "first_mastered_bed",
]

MilestoneCategory = Literal["CALM_CYCLE", "PHONEME_BLOOM"]


class PhonemeBedRead(BaseModel):
    """One of the 7 culturally warm Vietnamese phonics flower beds."""

    model_config = ConfigDict(populate_by_name=True)

    bed_key: PhonicsBedKey
    phonics_label_vi: str
    plant_name_vi: str
    plant_symbol: PlantSymbolKey
    stage: BedStage
    stage_index: int = Field(ge=0, le=3)
    practiced_words_count: int = Field(ge=0)
    mastered_words_count: int = Field(ge=0)
    mastered_words: list[str] = Field(default_factory=list)
    practiced_words: list[str] = Field(default_factory=list)
    next_stage: BedStage | None = None
    words_to_next_stage: int = Field(default=0, ge=0)
    encouragement_vi: str


class BookStampRead(BaseModel):
    """Unique commemorative stamp awarded once per distinct completed book."""

    model_config = ConfigDict(populate_by_name=True)

    stamp_key: str
    book_id: UUID
    book_title: str
    completed_at: datetime
    completed_sessions_count: int = Field(default=1, ge=1)
    motif: BookStampMotif = "LOTUS_SEAL"


class MilestoneStampRead(BaseModel):
    """Cumulative calm reading journey stamp — never penalizes missed days."""

    model_config = ConfigDict(populate_by_name=True)

    stamp_key: MilestoneStampKey
    category: MilestoneCategory
    title_vi: str
    description_vi: str
    unlocked: bool
    progress_current: int = Field(ge=0)
    progress_target: int = Field(ge=1)
    unlocked_at: datetime | None = None


class PhonemeGardenSummaryResponse(BaseModel):
    """PARENT_PRIVATE summary of a child's 7-Bed Phoneme Garden & Book Stamp Album."""

    model_config = ConfigDict(populate_by_name=True)

    visibility: Literal["PARENT_PRIVATE"] = "PARENT_PRIVATE"
    child_id: UUID
    child_alias: str
    child_grade: int = Field(ge=1, le=5)
    beds: list[PhonemeBedRead]
    book_stamps: list[BookStampRead]
    milestone_stamps: list[MilestoneStampRead]
    bloomed_beds_count: int = Field(ge=0, le=7)
    total_practiced_words: int = Field(ge=0)
    total_mastered_words: int = Field(ge=0)
    total_completed_books: int = Field(ge=0)
    total_completed_sessions: int = Field(ge=0)
    unlocked_milestone_stamps_count: int = Field(ge=0)
    gentle_message_vi: str
    calm_pedagogy_note_vi: str
