export type MemoryThemeKey =
  | "sunny_garden"
  | "happy_classroom"
  | "mid_autumn_yard"
  | "seaside_morning"
  | "countryside_pond"
  | "friendly_market";

export type MemoryThemeSelection = "random" | MemoryThemeKey;

export type MemoryTimerMode =
  "10S" | "20S" | "30S" | "60S" | "90S" | "120S" | "UNLIMITED";

export type MemoryRecallMode = "FREE_RECALL" | "GUIDED_RECALL";

export type MemorySessionStatus =
  "OBSERVING" | "RECALLING" | "CREATIVE" | "COMPLETED";

export type MemoryAttemptStage = "RECALL" | "CREATIVE";
export type MemoryInputMode = "VOICE" | "TEXT";

export type MemoryPositionZone =
  "trên trái" | "trên phải" | "giữa" | "dưới trái" | "dưới phải";

export type MemoryCanonicalColorVi =
  "đỏ" | "xanh dương" | "vàng" | "xanh lá" | "cam" | "tím";

export type MemoryColorShapeCue =
  "circle" | "square" | "star" | "triangle" | "diamond" | "hexagon";

export interface SceneBBoxDTO {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ObjectHintTiersDTO {
  readonly tier_1: string;
  readonly tier_2: string;
  readonly tier_3: string;
}

export interface SceneObjectSpecDTO {
  readonly id: string;
  readonly sprite_key: string;
  readonly name_vi: string;
  readonly category_vi: string;
  readonly aliases_vi: readonly string[];
  readonly color_vi: MemoryCanonicalColorVi;
  readonly color_hex: string;
  readonly color_stroke_hex: string;
  readonly color_light_hex: string;
  readonly shape_cue: MemoryColorShapeCue;
  readonly count: number;
  readonly position_zone: MemoryPositionZone;
  readonly bbox: SceneBBoxDTO;
  readonly action_vi: string;
  readonly hint_tiers: ObjectHintTiersDTO;
  readonly is_focus_word: boolean;
}

export interface SceneBackdropSpecDTO {
  readonly theme_key: MemoryThemeKey;
  readonly sky_top_hex: string;
  readonly sky_bottom_hex: string;
  readonly horizon_hex: string;
  readonly ground_hex: string;
  readonly accent_hex: string;
  readonly mood_vi: string;
}

export interface SceneSpecDTO {
  readonly schema_version: string;
  readonly theme_key: MemoryThemeKey;
  readonly theme_name_vi: string;
  readonly child_grade: number;
  readonly difficulty_level: number;
  readonly scene_seed: number;
  readonly canvas_width: number;
  readonly canvas_height: number;
  readonly backdrop: SceneBackdropSpecDTO;
  readonly objects: readonly SceneObjectSpecDTO[];
  readonly observation_tips_vi: readonly string[];
  readonly guided_questions_vi: readonly string[];
  readonly creative_prompt_vi: string;
  readonly matched_focus_words: readonly string[];
}

export interface MemoryThemeDTO {
  readonly theme_key: MemoryThemeKey;
  readonly name_vi: string;
  readonly description_vi: string;
  readonly badge_vi: string;
  readonly accent_hex: string;
  readonly sprite_count: number;
  readonly sample_items_vi: readonly string[];
}

export interface MemoryTimerOptionDTO {
  readonly mode: MemoryTimerMode;
  readonly seconds: number | null;
  readonly label_vi: string;
  readonly recommended_for_vi: string;
}

export interface MemoryGradeRecommendationDTO {
  readonly grade: number;
  readonly min_objects: number;
  readonly max_objects: number;
  readonly recommended_timer: MemoryTimerMode;
  readonly recommended_recall_mode: MemoryRecallMode;
  readonly recommended_difficulty: number;
  readonly note_vi: string;
}

export interface MemoryThemesCatalogDTO {
  readonly themes: readonly MemoryThemeDTO[];
  readonly timer_options: readonly MemoryTimerOptionDTO[];
  readonly grade_recommendations: readonly MemoryGradeRecommendationDTO[];
  readonly total_sprites: number;
}

export interface MatchedFactDTO {
  readonly object_id: string;
  readonly sprite_key: string;
  readonly name_vi: string;
  readonly color_vi: string;
  readonly count: number;
  readonly position_zone: MemoryPositionZone;
  readonly matched_attributes: readonly string[];
  readonly detail_vi: string;
  readonly bbox: SceneBBoxDTO;
}

export interface MissedFactDTO {
  readonly object_id: string;
  readonly sprite_key: string;
  readonly name_vi: string;
  readonly color_vi: string;
  readonly count: number;
  readonly position_zone: MemoryPositionZone;
  readonly detail_vi: string;
  readonly hint_tier_1: string;
  readonly bbox: SceneBBoxDTO;
}

export interface MemoryEvaluationDTO {
  readonly stage: MemoryAttemptStage;
  readonly factual_score: number;
  readonly creative_score: number;
  readonly stars: number;
  readonly matched_facts: readonly MatchedFactDTO[];
  readonly missed_facts: readonly MissedFactDTO[];
  readonly creative_highlights: readonly string[];
  readonly story_anchors: readonly string[];
  readonly praise_message_vi: string;
  readonly story_praise_vi: string;
  readonly next_tip_vi: string;
  readonly creative_followup_vi: string;
  readonly support_summary_vi: string | null;
  readonly used_focus_words: readonly string[];
  readonly ai_provider: string;
}

export interface MemoryAttemptDTO {
  readonly id: string;
  readonly session_id: string;
  readonly attempt_number: number;
  readonly stage: MemoryAttemptStage;
  readonly input_mode: MemoryInputMode;
  readonly response_text: string;
  readonly factual_score: number;
  readonly creative_score: number;
  readonly stars: number;
  readonly evaluation: MemoryEvaluationDTO;
  readonly ai_provider: string | null;
  readonly created_at: string;
}

export interface MemorySessionDTO {
  readonly id: string;
  readonly child_id: string;
  readonly child_grade: number;
  readonly theme_key: MemoryThemeKey;
  readonly theme_name_vi: string;
  readonly difficulty_level: number;
  readonly scene_seed: number;
  readonly timer_mode: MemoryTimerMode;
  readonly timer_seconds: number | null;
  readonly recall_mode: MemoryRecallMode;
  readonly status: MemorySessionStatus;
  readonly hints_used: number;
  readonly peek_count: number;
  readonly best_factual_score: number;
  readonly best_creative_score: number;
  readonly stars: number;
  readonly attempts_count: number;
  readonly scene_spec: SceneSpecDTO;
  readonly attempts: readonly MemoryAttemptDTO[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MemoryAttemptSubmitDTO {
  readonly attempt: MemoryAttemptDTO;
  readonly session: MemorySessionDTO;
}

export interface MemoryHintDTO {
  readonly session_id: string;
  readonly hints_used: number;
  readonly object_id: string | null;
  readonly tier: number;
  readonly hint_text_vi: string;
  readonly remaining_unmentioned_count: number;
  readonly has_more_tiers: boolean;
}

export interface MemoryPeekDTO {
  readonly session_id: string;
  readonly peek_count: number;
  readonly peek_duration_seconds: number;
  readonly message_vi: string;
}

export interface MemorySessionSummaryDTO {
  readonly id: string;
  readonly child_id: string;
  readonly child_grade: number;
  readonly theme_key: MemoryThemeKey;
  readonly theme_name_vi: string;
  readonly difficulty_level: number;
  readonly timer_mode: MemoryTimerMode;
  readonly timer_seconds: number | null;
  readonly recall_mode: MemoryRecallMode;
  readonly status: MemorySessionStatus;
  readonly hints_used: number;
  readonly peek_count: number;
  readonly best_factual_score: number;
  readonly best_creative_score: number;
  readonly stars: number;
  readonly attempts_count: number;
  readonly object_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}
