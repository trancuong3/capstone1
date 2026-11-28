from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

ThemeKey = Literal[
    "sunny_garden",
    "happy_classroom",
    "mid_autumn_yard",
    "seaside_morning",
    "countryside_pond",
    "friendly_market",
]

ThemeSelection = Literal[
    "random",
    "sunny_garden",
    "happy_classroom",
    "mid_autumn_yard",
    "seaside_morning",
    "countryside_pond",
    "friendly_market",
]

TimerMode = Literal["10S", "20S", "30S", "60S", "90S", "120S", "UNLIMITED"]
RecallMode = Literal["FREE_RECALL", "GUIDED_RECALL"]
MemorySessionStatus = Literal["OBSERVING", "RECALLING", "CREATIVE", "COMPLETED"]
MemoryAttemptStage = Literal["RECALL", "CREATIVE"]
MemoryInputMode = Literal["VOICE", "TEXT"]
PositionZone = Literal["trên trái", "trên phải", "giữa", "dưới trái", "dưới phải"]
CanonicalColorVi = Literal["đỏ", "xanh dương", "vàng", "xanh lá", "cam", "tím"]
ColorShapeCue = Literal["circle", "square", "star", "triangle", "diamond", "hexagon"]


class SceneBBox(BaseModel):
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    w: float = Field(..., gt=0.0, le=1.0)
    h: float = Field(..., gt=0.0, le=1.0)


class ObjectHintTiers(BaseModel):
    tier_1: str = Field(..., min_length=1, max_length=240)
    tier_2: str = Field(..., min_length=1, max_length=240)
    tier_3: str = Field(..., min_length=1, max_length=240)


class SceneObjectSpec(BaseModel):
    id: str = Field(..., min_length=1, max_length=64)
    sprite_key: str = Field(..., min_length=1, max_length=64)
    name_vi: str = Field(..., min_length=1, max_length=80)
    category_vi: str = Field(..., min_length=1, max_length=80)
    aliases_vi: list[str] = Field(default_factory=list)
    color_vi: CanonicalColorVi
    color_hex: str = Field(..., min_length=4, max_length=16)
    color_stroke_hex: str = Field(..., min_length=4, max_length=16)
    color_light_hex: str = Field(..., min_length=4, max_length=16)
    shape_cue: ColorShapeCue
    count: int = Field(..., ge=1, le=3)
    position_zone: PositionZone
    bbox: SceneBBox
    action_vi: str = Field(..., min_length=1, max_length=160)
    hint_tiers: ObjectHintTiers
    is_focus_word: bool = False


class SceneBackdropSpec(BaseModel):
    theme_key: ThemeKey
    sky_top_hex: str
    sky_bottom_hex: str
    horizon_hex: str
    ground_hex: str
    accent_hex: str
    mood_vi: str


class SceneSpec(BaseModel):
    schema_version: str = "v4.0"
    theme_key: ThemeKey
    theme_name_vi: str
    child_grade: int = Field(..., ge=1, le=5)
    difficulty_level: int = Field(..., ge=1, le=5)
    scene_seed: int = Field(..., ge=0)
    canvas_width: int = 800
    canvas_height: int = 500
    backdrop: SceneBackdropSpec
    objects: list[SceneObjectSpec]
    observation_tips_vi: list[str] = Field(default_factory=list)
    guided_questions_vi: list[str] = Field(default_factory=list)
    creative_prompt_vi: str
    focus_words: list[str] = Field(default_factory=list)
    matched_focus_words: list[str] = Field(default_factory=list)


class MemoryThemeRead(BaseModel):
    theme_key: ThemeKey
    name_vi: str
    description_vi: str
    badge_vi: str
    accent_hex: str
    sprite_count: int
    sample_items_vi: list[str]


class TimerOptionRead(BaseModel):
    mode: TimerMode
    seconds: int | None
    label_vi: str
    recommended_for_vi: str


class GradeRecommendationRead(BaseModel):
    grade: int = Field(..., ge=1, le=5)
    min_objects: int
    max_objects: int
    recommended_timer: TimerMode
    recommended_recall_mode: RecallMode
    recommended_difficulty: int
    note_vi: str


class MemoryThemesCatalogRead(BaseModel):
    themes: list[MemoryThemeRead]
    timer_options: list[TimerOptionRead]
    grade_recommendations: list[GradeRecommendationRead]
    total_sprites: int


class MemorySessionCreate(BaseModel):
    child_id: UUID
    theme_key: ThemeSelection | None = None
    timer_mode: TimerMode = "30S"
    recall_mode: RecallMode = "FREE_RECALL"
    difficulty_level: int | None = Field(default=None, ge=1, le=5)
    scene_seed: int | None = Field(default=None, ge=0, le=2_147_483_647)
    focus_words: list[str] = Field(default_factory=list, max_length=12)


class MemoryHintRequest(BaseModel):
    mentioned_text: str = Field(default="", max_length=1500)
    mentioned_object_ids: list[str] = Field(default_factory=list)
    target_object_id: str | None = Field(default=None, max_length=64)
    requested_tier: int | None = Field(default=None, ge=1, le=3)


class MemoryHintRead(BaseModel):
    session_id: UUID
    hints_used: int = Field(..., ge=0)
    object_id: str | None
    tier: int = Field(..., ge=1, le=3)
    hint_text_vi: str
    remaining_unmentioned_count: int = Field(..., ge=0)
    has_more_tiers: bool


class MemoryPeekRead(BaseModel):
    session_id: UUID
    peek_count: int = Field(..., ge=0)
    peek_duration_seconds: int = 3
    message_vi: str


class MemoryAttemptCreate(BaseModel):
    stage: MemoryAttemptStage = "RECALL"
    input_mode: MemoryInputMode = "TEXT"
    response_text: str = Field(..., min_length=1, max_length=2000)
    teacher_gender: Literal["female", "male"] | None = None


class MatchedFactRead(BaseModel):
    object_id: str
    sprite_key: str
    name_vi: str
    color_vi: str
    count: int = Field(..., ge=1, le=3)
    position_zone: PositionZone
    matched_attributes: list[str] = Field(default_factory=list)
    detail_vi: str
    bbox: SceneBBox


class MissedFactRead(BaseModel):
    object_id: str
    sprite_key: str
    name_vi: str
    color_vi: str
    count: int = Field(..., ge=1, le=3)
    position_zone: PositionZone
    detail_vi: str
    hint_tier_1: str
    bbox: SceneBBox


class MemoryEvaluationRead(BaseModel):
    stage: MemoryAttemptStage
    factual_score: int = Field(..., ge=0, le=100)
    creative_score: int = Field(..., ge=0, le=100)
    stars: int = Field(..., ge=0, le=3)
    matched_facts: list[MatchedFactRead] = Field(default_factory=list)
    missed_facts: list[MissedFactRead] = Field(default_factory=list)
    creative_highlights: list[str] = Field(default_factory=list)
    story_anchors: list[str] = Field(default_factory=list)
    praise_message_vi: str
    story_praise_vi: str
    next_tip_vi: str
    creative_followup_vi: str
    support_summary_vi: str | None = None
    used_focus_words: list[str] = Field(default_factory=list)
    focus_word_feedback_vi: str | None = None
    ai_provider: str = "deterministic-v4"


class MemoryAttemptRead(BaseModel):
    id: UUID
    session_id: UUID
    attempt_number: int = Field(..., ge=1)
    stage: MemoryAttemptStage
    input_mode: MemoryInputMode
    response_text: str
    factual_score: int = Field(..., ge=0, le=100)
    creative_score: int = Field(..., ge=0, le=100)
    stars: int = Field(..., ge=0, le=3)
    evaluation: MemoryEvaluationRead
    ai_provider: str | None = None
    created_at: datetime


class MemorySessionRead(BaseModel):
    id: UUID
    child_id: UUID
    child_grade: int = Field(..., ge=1, le=5)
    theme_key: ThemeKey
    theme_name_vi: str
    difficulty_level: int = Field(..., ge=1, le=5)
    scene_seed: int
    timer_mode: TimerMode
    timer_seconds: int | None
    recall_mode: RecallMode
    status: MemorySessionStatus
    hints_used: int = Field(..., ge=0)
    peek_count: int = Field(..., ge=0)
    best_factual_score: int = Field(..., ge=0, le=100)
    best_creative_score: int = Field(..., ge=0, le=100)
    stars: int = Field(..., ge=0, le=3)
    attempts_count: int = Field(..., ge=0)
    focus_words: list[str] = Field(default_factory=list)
    scene_spec: SceneSpec
    attempts: list[MemoryAttemptRead] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class MemoryAttemptSubmitRead(BaseModel):
    attempt: MemoryAttemptRead
    session: MemorySessionRead


class MemorySessionSummaryRead(BaseModel):
    id: UUID
    child_id: UUID
    child_grade: int = Field(..., ge=1, le=5)
    theme_key: ThemeKey
    theme_name_vi: str
    difficulty_level: int = Field(..., ge=1, le=5)
    timer_mode: TimerMode
    timer_seconds: int | None
    recall_mode: RecallMode
    status: MemorySessionStatus
    hints_used: int = Field(..., ge=0)
    peek_count: int = Field(..., ge=0)
    best_factual_score: int = Field(..., ge=0, le=100)
    best_creative_score: int = Field(..., ge=0, le=100)
    stars: int = Field(..., ge=0, le=3)
    attempts_count: int = Field(..., ge=0)
    object_count: int = Field(..., ge=0)
    created_at: datetime
    updated_at: datetime
