"""Schemas for ViRead V4.0 Adaptive Learning Engine and Parent Learning Analytics."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

SkillDomain = Literal[
    "READING_WORDS",
    "LANGUAGE_GRAMMAR",
    "OBSERVATION_MEMORY_CREATIVITY",
    "MUSIC_RHYTHM",
]
SkillStatus = Literal["OBSERVED", "ESTIMATED", "UNKNOWN"]
SourceModule = Literal[
    "READING",
    "DIFFICULT_WORD",
    "PICTURE_DESCRIPTION",
    "SENTENCE_SHOOTER",
    "KARAOKE",
    "MEMORY_GAME",
]
GameKey = Literal[
    "PICTURE_DESCRIPTION",
    "SENTENCE_SHOOTER",
    "KARAOKE",
    "MEMORY_GAME",
]
DifficultyDirection = Literal["INCREASE", "HOLD", "DECREASE"]


class SkillTaxonomyItem(BaseModel):
    skill_key: str
    label_vi: str
    domain: SkillDomain
    description_vi: str


class SkillMasteryRead(BaseModel):
    skill_key: str
    label_vi: str
    domain: SkillDomain
    status: SkillStatus
    mastery_pct: int | None = Field(default=None, ge=0, le=100)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    evidence_count: int = Field(default=0, ge=0)
    high_confidence_count: int = Field(default=0, ge=0)
    last_observed_at: datetime | None = None
    source_modules: list[SourceModule] = Field(default_factory=list)


class ModuleDifficultyPlan(BaseModel):
    game_key: GameKey
    recommended_difficulty: int = Field(ge=1, le=5)
    baseline_grade_difficulty: int = Field(ge=1, le=5)
    direction: DifficultyDirection
    high_confidence_attempts: int = Field(default=0, ge=0)
    requires_more_evidence: bool = True
    reason_vi: str


class SpacedDifficultWordRead(BaseModel):
    normalized_word: str
    display_text: str
    priority_score: float = Field(ge=0.0)
    practice_count: int = Field(default=0, ge=0)
    last_practiced_at: datetime | None = None
    days_since_practice: int | None = None
    recommended_game: GameKey
    reason_vi: str


class CrossGameRecommendationRead(BaseModel):
    game_key: GameKey
    zone_title_vi: str
    game_title_vi: str
    reason_vi: str
    suggested_mode: str
    suggested_difficulty: int = Field(ge=1, le=5)
    target_words: list[str] = Field(default_factory=list)
    href: str
    priority: int = Field(ge=1, le=10)


class AdaptiveProfileRead(BaseModel):
    child_id: UUID
    child_alias: str
    child_grade: int = Field(ge=1, le=5)
    is_diagnostic: bool = False
    disclaimer_vi: str
    observed_skills_count: int = Field(ge=0)
    estimated_skills_count: int = Field(ge=0)
    unknown_skills_count: int = Field(ge=0)
    skills: list[SkillMasteryRead]
    difficulty_plans: list[ModuleDifficultyPlan]
    spaced_difficult_words: list[SpacedDifficultWordRead]
    recommendations: list[CrossGameRecommendationRead]
    generated_at: datetime


class EntertainmentRecommendationsRead(BaseModel):
    child_id: UUID
    child_alias: str
    child_grade: int = Field(ge=1, le=5)
    mascot_greeting_vi: str
    natural_break_reminder_vi: str
    today_activities_count: int = Field(default=0, ge=0)
    focus_difficult_words: list[str] = Field(default_factory=list)
    primary_recommendation: CrossGameRecommendationRead
    recommendations: list[CrossGameRecommendationRead]


class ModuleActivitySummaryRead(BaseModel):
    game_key: GameKey
    title_vi: str
    sessions_count: int = Field(default=0, ge=0)
    recent_average_pct: int | None = Field(default=None, ge=0, le=100)
    highlight_vi: str


class KaraokeWeakSegmentSummaryRead(BaseModel):
    song_id: UUID
    line_text: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    tip_vi: str


class ParentEntertainmentAnalyticsRead(BaseModel):
    child_id: UUID
    child_alias: str
    child_grade: int = Field(ge=1, le=5)
    window_days: int = Field(default=30, ge=7, le=90)
    is_diagnostic: bool = False
    disclaimer_vi: str
    observed_skills_count: int = Field(ge=0)
    estimated_skills_count: int = Field(ge=0)
    unknown_skills_count: int = Field(ge=0)
    skills: list[SkillMasteryRead]
    practiced_difficult_words: list[SpacedDifficultWordRead]
    module_activities: list[ModuleActivitySummaryRead]
    karaoke_weak_segments: list[KaraokeWeakSegmentSummaryRead]
    home_support_tips_vi: list[str]
    generated_at: datetime


class SkillEvidenceCreate(BaseModel):
    skill_key: str = Field(min_length=2, max_length=64)
    source_module: SourceModule
    source_record_id: str | None = Field(default=None, max_length=64)
    evidence_type: Literal["OBSERVED", "ESTIMATED"] = "OBSERVED"
    score_normalized: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(default=0.75, ge=0.0, le=1.0)
    difficulty_level: int = Field(default=1, ge=1, le=5)
    practice_words: list[str] = Field(default_factory=list, max_length=20)
    metadata_json: dict = Field(default_factory=dict)


class SkillEvidenceRead(BaseModel):
    id: UUID
    child_id: UUID
    skill_key: str
    source_module: SourceModule
    score_normalized: float
    confidence: float
    difficulty_level: int
    created_at: datetime


class WarmupMicroStoryRead(BaseModel):
    child_id: UUID
    local_date: date
    has_due_words: bool = False
    target_words: list[str] = Field(default_factory=list)
    title_vi: str
    sentences: list[str] = Field(default_factory=list)
    full_text: str
    source: Literal["AI", "RULE_BASED"] = "RULE_BASED"
    cached: bool = False
