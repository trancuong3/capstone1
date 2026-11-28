export type SkillDomain =
  | "READING_WORDS"
  | "LANGUAGE_GRAMMAR"
  | "OBSERVATION_MEMORY_CREATIVITY"
  | "MUSIC_RHYTHM";

export type SkillStatus = "OBSERVED" | "ESTIMATED" | "UNKNOWN";

export type GameKey =
  "PICTURE_DESCRIPTION" | "SENTENCE_SHOOTER" | "KARAOKE" | "MEMORY_GAME";

export interface SkillMasteryDTO {
  skill_key: string;
  label_vi: string;
  domain: SkillDomain;
  status: SkillStatus;
  mastery_pct: number | null;
  confidence: number;
  evidence_count: number;
  high_confidence_count: number;
  last_observed_at: string | null;
  source_modules: string[];
}

export interface SpacedDifficultWordDTO {
  normalized_word: string;
  display_text: string;
  phonics_category?: string;
  phonics_label_vi?: string;
  priority_score: number;
  practice_count: number;
  last_practiced_at: string | null;
  days_since_practice: number | null;
  recommended_game: GameKey;
  reason_vi: string;
}

export interface CrossGameRecommendationDTO {
  game_key: GameKey;
  zone_title_vi: string;
  game_title_vi: string;
  reason_vi: string;
  suggested_mode: string;
  suggested_difficulty: number;
  target_words: string[];
  href: string;
  priority: number;
}

export interface EntertainmentRecommendationsDTO {
  child_id: string;
  child_alias: string;
  child_grade: number;
  mascot_greeting_vi: string;
  natural_break_reminder_vi: string;
  today_activities_count: number;
  focus_difficult_words: string[];
  primary_recommendation: CrossGameRecommendationDTO;
  recommendations: CrossGameRecommendationDTO[];
}

export interface ModuleActivitySummaryDTO {
  game_key: GameKey;
  title_vi: string;
  sessions_count: number;
  recent_average_pct: number | null;
  highlight_vi: string;
}

export interface KaraokeWeakSegmentSummaryDTO {
  song_id: string;
  line_text: string;
  start_ms: number;
  end_ms: number;
  tip_vi: string;
}

export interface ParentEntertainmentAnalyticsDTO {
  child_id: string;
  child_alias: string;
  child_grade: number;
  window_days: number;
  is_diagnostic: boolean;
  disclaimer_vi: string;
  observed_skills_count: number;
  estimated_skills_count: number;
  unknown_skills_count: number;
  skills: SkillMasteryDTO[];
  practiced_difficult_words: SpacedDifficultWordDTO[];
  module_activities: ModuleActivitySummaryDTO[];
  karaoke_weak_segments: KaraokeWeakSegmentSummaryDTO[];
  home_support_tips_vi: string[];
  generated_at: string;
}

export type TrainInteractionMode = "VOICE" | "NO_MIC_TOUCH" | "MIXED";
export type TrainCar2GameKey = "SENTENCE_SHOOTER" | "PICTURE_DESCRIPTION";
export type TrainCar3FinishMode = "SHORT_PASSAGE" | "SLOW_KARAOKE_085X";

export interface TrainWarmupWordItemDTO {
  normalized_word: string;
  display_text: string;
  phonics_category: string;
  phonics_label_vi: string;
  syllable_hint_vi: string;
  sample_sentence_vi: string;
  source: "SPACED_DIFFICULT_WORD" | "COLD_START_GRADE";
}

export interface TrainCar1WarmupDTO {
  car_number: 1;
  car_key: "WARMUP_WORDS";
  title_vi: string;
  subtitle_vi: string;
  estimated_seconds: number;
  dominant_phonics_category: string;
  dominant_phonics_label_vi: string;
  target_words: TrainWarmupWordItemDTO[];
}

export interface TrainCar2GameRoundDTO {
  car_number: 2;
  car_key: "CONTEXT_GAME";
  title_vi: string;
  subtitle_vi: string;
  estimated_seconds: number;
  game_key: TrainCar2GameKey;
  suggested_mode: string;
  recommended_difficulty: number;
  seeded_words: string[];
  prompt_vi: string;
  sentence_tokens: string[];
  distractor_tokens: string[];
  deep_link_href: string;
}

export interface TrainCar3FluencyFinishDTO {
  car_number: 3;
  car_key: "FLUENCY_FINISH";
  title_vi: string;
  subtitle_vi: string;
  estimated_seconds: number;
  finish_mode: TrainCar3FinishMode;
  playback_speed: number;
  phonics_category: string;
  phonics_label_vi: string;
  passage_title_vi: string;
  text_vi: string;
  featured_words: string[];
  coaching_tip_vi: string;
}

export interface DailyFiveMinuteTrainDTO {
  train_id: string;
  visibility: "PARENT_PRIVATE";
  child_id: string;
  child_alias: string;
  child_grade: number;
  total_estimated_seconds: number;
  is_cold_start: boolean;
  completed_today: boolean;
  today_completed_count: number;
  greeting_vi: string;
  no_mic_support_note_vi: string;
  natural_break_cue_vi: string;
  disclaimer_vi: string;
  car_1_warmup: TrainCar1WarmupDTO;
  car_2_game: TrainCar2GameRoundDTO;
  car_3_fluency: TrainCar3FluencyFinishDTO;
  generated_at: string;
}

export interface DailyFiveMinuteTrainCompleteRequestDTO {
  train_id: string;
  client_completion_id?: string;
  interaction_mode: TrainInteractionMode;
  duration_seconds: number;
  practiced_words: string[];
  car_2_game_key: TrainCar2GameKey;
  car_3_finish_mode: TrainCar3FinishMode;
  car_1_completed?: boolean;
  car_2_completed?: boolean;
  car_3_completed?: boolean;
  car_scores?: Record<string, number>;
}

export interface SkillEvidenceItemDTO {
  id: string;
  child_id: string;
  skill_key: string;
  source_module: string;
  score_normalized: number;
  confidence: number;
  difficulty_level: number;
  created_at: string;
}

export interface DailyFiveMinuteTrainCompleteResponseDTO {
  visibility: "PARENT_PRIVATE";
  train_id: string;
  child_id: string;
  child_alias: string;
  interaction_mode: TrainInteractionMode;
  recorded_evidence_count: number;
  evidence_items: SkillEvidenceItemDTO[];
  today_completed_trains_count: number;
  celebration_title_vi: string;
  natural_break_cue_vi: string;
  completed_at: string;
}
