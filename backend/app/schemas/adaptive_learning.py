"""Schemas for ViRead V4.0 Adaptive Learning Engine and Parent Learning Analytics."""

from __future__ import annotations

from datetime import datetime
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
    phonics_category: str = "general"
    phonics_label_vi: str = "Từ cần ôn"
    is_due: bool = True


class CrossGameRecommendationRead(BaseModel):
    game_key: GameKey
    zone_title_vi: str
    game_title_vi: str
    reason_vi: str
    suggested_mode: str
    suggested_difficulty: int = Field(ge=1, le=5)
    target_words: list[str] = Field(default_factory=list)
    href: str
    quick_play_href: str | None = None
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
    reading_misread_words_reinforced: int = Field(default=0, ge=0)
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


TrainInteractionMode = Literal["VOICE", "NO_MIC_TOUCH", "MIXED"]
TrainCar2GameKey = Literal["SENTENCE_SHOOTER", "PICTURE_DESCRIPTION"]
TrainCar3FinishMode = Literal["SHORT_PASSAGE", "SLOW_KARAOKE_085X"]


class TrainWarmupWordItemRead(BaseModel):
    normalized_word: str
    display_text: str
    phonics_category: str = "general"
    phonics_label_vi: str = "Từ cần ôn"
    syllable_hint_vi: str
    sample_sentence_vi: str
    source: Literal["SPACED_DIFFICULT_WORD", "COLD_START_GRADE"]


class TrainCar1WarmupRead(BaseModel):
    car_number: Literal[1] = 1
    car_key: Literal["WARMUP_WORDS"] = "WARMUP_WORDS"
    title_vi: str
    subtitle_vi: str
    estimated_seconds: int = Field(default=90, ge=30, le=180)
    dominant_phonics_category: str
    dominant_phonics_label_vi: str
    target_words: list[TrainWarmupWordItemRead] = Field(min_length=2, max_length=3)


class TrainCar2GameRoundRead(BaseModel):
    car_number: Literal[2] = 2
    car_key: Literal["CONTEXT_GAME"] = "CONTEXT_GAME"
    title_vi: str
    subtitle_vi: str
    estimated_seconds: int = Field(default=120, ge=45, le=240)
    game_key: TrainCar2GameKey
    suggested_mode: str
    recommended_difficulty: int = Field(ge=1, le=5)
    seeded_words: list[str] = Field(min_length=2, max_length=3)
    prompt_vi: str
    sentence_tokens: list[str] = Field(min_length=3, max_length=24)
    distractor_tokens: list[str] = Field(default_factory=list, max_length=6)
    deep_link_href: str


class TrainCar3FluencyFinishRead(BaseModel):
    car_number: Literal[3] = 3
    car_key: Literal["FLUENCY_FINISH"] = "FLUENCY_FINISH"
    title_vi: str
    subtitle_vi: str
    estimated_seconds: int = Field(default=90, ge=30, le=180)
    finish_mode: TrainCar3FinishMode
    playback_speed: float = Field(default=0.85, ge=0.5, le=1.2)
    phonics_category: str
    phonics_label_vi: str
    passage_title_vi: str
    text_vi: str
    featured_words: list[str] = Field(default_factory=list)
    coaching_tip_vi: str


class DailyFiveMinuteTrainRead(BaseModel):
    train_id: str
    visibility: Literal["PARENT_PRIVATE"] = "PARENT_PRIVATE"
    child_id: UUID
    child_alias: str
    child_grade: int = Field(ge=1, le=5)
    total_estimated_seconds: int = Field(default=300, ge=120, le=600)
    is_cold_start: bool = False
    completed_today: bool = False
    today_completed_count: int = Field(default=0, ge=0)
    greeting_vi: str
    no_mic_support_note_vi: str
    natural_break_cue_vi: str
    disclaimer_vi: str
    car_1_warmup: TrainCar1WarmupRead
    car_2_game: TrainCar2GameRoundRead
    car_3_fluency: TrainCar3FluencyFinishRead
    generated_at: datetime


class DailyFiveMinuteTrainCompleteRequest(BaseModel):
    train_id: str = Field(min_length=3, max_length=120)
    client_completion_id: str | None = Field(default=None, max_length=64)
    interaction_mode: TrainInteractionMode = "VOICE"
    duration_seconds: int = Field(default=300, ge=10, le=1800)
    practiced_words: list[str] = Field(default_factory=list, max_length=10)
    car_2_game_key: TrainCar2GameKey = "SENTENCE_SHOOTER"
    car_3_finish_mode: TrainCar3FinishMode = "SHORT_PASSAGE"
    car_1_completed: bool = True
    car_2_completed: bool = True
    car_3_completed: bool = True
    car_scores: dict[str, float] = Field(default_factory=dict)


class DailyFiveMinuteTrainCompleteResponse(BaseModel):
    visibility: Literal["PARENT_PRIVATE"] = "PARENT_PRIVATE"
    train_id: str
    child_id: UUID
    child_alias: str
    interaction_mode: TrainInteractionMode
    recorded_evidence_count: int = Field(ge=0)
    evidence_items: list[SkillEvidenceRead] = Field(default_factory=list)
    today_completed_trains_count: int = Field(ge=1)
    celebration_title_vi: str
    natural_break_cue_vi: str
    completed_at: datetime
