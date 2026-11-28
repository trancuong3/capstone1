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
  quick_play_href?: string | null;
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
  reading_misread_words_reinforced?: number;
  generated_at: string;
}
