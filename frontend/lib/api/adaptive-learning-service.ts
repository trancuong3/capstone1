import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";
import { ServiceError } from "@/lib/api/service-error";
import { translateRuntime } from "@/lib/i18n/runtime";
import type {
  EntertainmentRecommendationsDTO,
  ParentEntertainmentAnalyticsDTO,
} from "@/types/adaptive-learning";

const skillDomainSchema = z.enum([
  "READING_WORDS",
  "LANGUAGE_GRAMMAR",
  "OBSERVATION_MEMORY_CREATIVITY",
  "MUSIC_RHYTHM",
]);

const skillStatusSchema = z.enum(["OBSERVED", "ESTIMATED", "UNKNOWN"]);

const gameKeySchema = z.enum([
  "PICTURE_DESCRIPTION",
  "SENTENCE_SHOOTER",
  "KARAOKE",
  "MEMORY_GAME",
]);

const crossGameRecommendationSchema = z.object({
  game_key: gameKeySchema,
  zone_title_vi: z.string(),
  game_title_vi: z.string(),
  reason_vi: z.string(),
  suggested_mode: z.string(),
  suggested_difficulty: z.number().int(),
  target_words: z.array(z.string()).default([]),
  href: z.string(),
  priority: z.number().int(),
});

export const entertainmentRecommendationsSchema = z.object({
  child_id: z.string().min(1),
  child_alias: z.string(),
  child_grade: z.number().int(),
  mascot_greeting_vi: z.string(),
  natural_break_reminder_vi: z.string(),
  today_activities_count: z.number().int().default(0),
  focus_difficult_words: z.array(z.string()).default([]),
  primary_recommendation: crossGameRecommendationSchema,
  recommendations: z.array(crossGameRecommendationSchema),
});

const skillMasterySchema = z.object({
  skill_key: z.string(),
  label_vi: z.string(),
  domain: skillDomainSchema,
  status: skillStatusSchema,
  mastery_pct: z.number().nullable(),
  confidence: z.number(),
  evidence_count: z.number().int(),
  high_confidence_count: z.number().int(),
  last_observed_at: z.string().nullable(),
  source_modules: z.array(z.string()).default([]),
});

const spacedDifficultWordSchema = z.object({
  normalized_word: z.string(),
  display_text: z.string(),
  phonics_category: z.string().optional(),
  phonics_label_vi: z.string().optional(),
  priority_score: z.number(),
  practice_count: z.number().int(),
  last_practiced_at: z.string().nullable(),
  days_since_practice: z.number().int().nullable(),
  recommended_game: gameKeySchema,
  reason_vi: z.string(),
});

const moduleActivitySummarySchema = z.object({
  game_key: gameKeySchema,
  title_vi: z.string(),
  sessions_count: z.number().int(),
  recent_average_pct: z.number().nullable(),
  highlight_vi: z.string(),
});

const karaokeWeakSegmentSummarySchema = z.object({
  song_id: z.string().min(1),
  line_text: z.string(),
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  tip_vi: z.string(),
});

export const parentEntertainmentAnalyticsSchema = z.object({
  child_id: z.string().min(1),
  child_alias: z.string(),
  child_grade: z.number().int(),
  window_days: z.number().int(),
  is_diagnostic: z.boolean(),
  disclaimer_vi: z.string(),
  observed_skills_count: z.number().int(),
  estimated_skills_count: z.number().int(),
  unknown_skills_count: z.number().int(),
  skills: z.array(skillMasterySchema),
  practiced_difficult_words: z.array(spacedDifficultWordSchema),
  module_activities: z.array(moduleActivitySummarySchema),
  karaoke_weak_segments: z.array(karaokeWeakSegmentSummarySchema),
  home_support_tips_vi: z.array(z.string()),
  generated_at: z.string(),
});

function assertNonEmptyChildId(childId: string): string {
  const normalized = childId.trim();
  if (!normalized) {
    throw new ServiceError({
      code: "VALIDATION_ERROR",
      message: translateRuntime("entertainment.hub.recommendationLoadError"),
      status: 422,
      request_id: "",
      retryable: false,
    });
  }
  return normalized;
}

function normalizeWindowDays(windowDays: number): number {
  if (typeof windowDays !== "number" || !Number.isFinite(windowDays)) {
    return 30;
  }
  return Math.min(90, Math.max(7, Math.floor(windowDays)));
}

export interface AdaptiveLearningService {
  getRecommendations(
    childId: string,
    teacherGender?: "female" | "male",
  ): Promise<EntertainmentRecommendationsDTO>;
  getParentAnalytics(
    childId: string,
    windowDays?: number,
    teacherGender?: "female" | "male",
  ): Promise<ParentEntertainmentAnalyticsDTO>;
}

export function createAdaptiveLearningService(): AdaptiveLearningService {
  return {
    async getRecommendations(
      childId: string,
      teacherGender?: "female" | "male",
    ) {
      const normalizedChildId = assertNonEmptyChildId(childId);
      const suffix = teacherGender
        ? `?teacher_gender=${encodeURIComponent(teacherGender)}`
        : "";
      return requestApi(
        `/learning/children/${encodeURIComponent(normalizedChildId)}/recommendations${suffix}`,
        entertainmentRecommendationsSchema,
      );
    },
    async getParentAnalytics(
      childId: string,
      windowDays = 30,
      teacherGender?: "female" | "male",
    ) {
      const normalizedChildId = assertNonEmptyChildId(childId);
      const normalizedWindowDays = normalizeWindowDays(windowDays);
      const genderParam = teacherGender
        ? `&teacher_gender=${encodeURIComponent(teacherGender)}`
        : "";
      return requestApi(
        `/learning/children/${encodeURIComponent(normalizedChildId)}/parent-analytics?window_days=${normalizedWindowDays}${genderParam}`,
        parentEntertainmentAnalyticsSchema,
      );
    },
  };
}
