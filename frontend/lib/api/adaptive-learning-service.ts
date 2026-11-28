import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";
import type {
  CompleteMagicRhythmChantInput,
  CompleteMagicRhythmChantResponseDTO,
  CompleteMagicWordQuestInput,
  CompleteMagicWordQuestResponseDTO,
  CreateMagicRhythmChantInput,
  CreateMagicWordQuestInput,
  DailyFiveMinuteTrainCompleteRequestDTO,
  DailyFiveMinuteTrainCompleteResponseDTO,
  DailyFiveMinuteTrainDTO,
  EntertainmentRecommendationsDTO,
  MagicRhythmChantDTO,
  MagicWordQuestDTO,
  ParentEntertainmentAnalyticsDTO,
  WarmupMicroStoryDTO,
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

const entertainmentRecommendationsSchema = z.object({
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
  is_due: z.boolean().default(true),
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

const parentEntertainmentAnalyticsSchema = z.object({
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

const trainWarmupWordItemSchema = z.object({
  normalized_word: z.string(),
  display_text: z.string(),
  phonics_category: z.string(),
  phonics_label_vi: z.string(),
  syllable_hint_vi: z.string(),
  sample_sentence_vi: z.string(),
  source: z.enum(["SPACED_DIFFICULT_WORD", "COLD_START_GRADE"]),
});

const trainCar1WarmupSchema = z.object({
  car_number: z.literal(1),
  car_key: z.literal("WARMUP_WORDS"),
  title_vi: z.string(),
  subtitle_vi: z.string(),
  estimated_seconds: z.number().int(),
  dominant_phonics_category: z.string(),
  dominant_phonics_label_vi: z.string(),
  target_words: z.array(trainWarmupWordItemSchema),
});

const trainCar2GameRoundSchema = z.object({
  car_number: z.literal(2),
  car_key: z.literal("CONTEXT_GAME"),
  title_vi: z.string(),
  subtitle_vi: z.string(),
  estimated_seconds: z.number().int(),
  game_key: z.enum(["SENTENCE_SHOOTER", "PICTURE_DESCRIPTION"]),
  suggested_mode: z.string(),
  recommended_difficulty: z.number().int(),
  seeded_words: z.array(z.string()),
  prompt_vi: z.string(),
  sentence_tokens: z.array(z.string()),
  distractor_tokens: z.array(z.string()).default([]),
  deep_link_href: z.string(),
});

const trainCar3FluencyFinishSchema = z.object({
  car_number: z.literal(3),
  car_key: z.literal("FLUENCY_FINISH"),
  title_vi: z.string(),
  subtitle_vi: z.string(),
  estimated_seconds: z.number().int(),
  finish_mode: z.enum(["SHORT_PASSAGE", "SLOW_KARAOKE_085X"]),
  playback_speed: z.number(),
  phonics_category: z.string(),
  phonics_label_vi: z.string(),
  passage_title_vi: z.string(),
  text_vi: z.string(),
  featured_words: z.array(z.string()).default([]),
  coaching_tip_vi: z.string(),
});

const dailyFiveMinuteTrainSchema = z.object({
  train_id: z.string().min(1),
  visibility: z.literal("PARENT_PRIVATE"),
  child_id: z.string().min(1),
  child_alias: z.string(),
  child_grade: z.number().int(),
  total_estimated_seconds: z.number().int(),
  is_cold_start: z.boolean(),
  completed_today: z.boolean(),
  today_completed_count: z.number().int().default(0),
  greeting_vi: z.string(),
  no_mic_support_note_vi: z.string(),
  natural_break_cue_vi: z.string(),
  disclaimer_vi: z.string(),
  car_1_warmup: trainCar1WarmupSchema,
  car_2_game: trainCar2GameRoundSchema,
  car_3_fluency: trainCar3FluencyFinishSchema,
  generated_at: z.string(),
});

const skillEvidenceItemSchema = z.object({
  id: z.string(),
  child_id: z.string(),
  skill_key: z.string(),
  source_module: z.string(),
  score_normalized: z.number(),
  confidence: z.number(),
  difficulty_level: z.number().int(),
  created_at: z.string(),
});

const dailyFiveMinuteTrainCompleteResponseSchema = z.object({
  visibility: z.literal("PARENT_PRIVATE"),
  train_id: z.string(),
  child_id: z.string(),
  child_alias: z.string(),
  interaction_mode: z.enum(["VOICE", "NO_MIC_TOUCH", "MIXED"]),
  recorded_evidence_count: z.number().int(),
  evidence_items: z.array(skillEvidenceItemSchema).default([]),
  today_completed_trains_count: z.number().int(),
  celebration_title_vi: z.string(),
  natural_break_cue_vi: z.string(),
  completed_at: z.string(),
});

const warmupMicroStorySchema = z.object({
  child_id: z.string().min(1),
  local_date: z.string(),
  has_due_words: z.boolean(),
  target_words: z.array(z.string()).default([]),
  title_vi: z.string(),
  sentences: z.array(z.string()).default([]),
  full_text: z.string(),
  source: z.enum(["AI", "RULE_BASED"]),
  cached: z.boolean().default(false),
});

export const magicQuestProviderTierSchema = z.enum([
  "GEMINI",
  "GROQ",
  "DETERMINISTIC_FALLBACK",
]);

export const magicQuestSourceKindSchema = z.enum([
  "WEAK_WORDS",
  "STARTER_FALLBACK",
]);

export const magicQuestPromptSlotSchema = z.object({
  position: z.number().int().nonnegative(),
  text: z.string().nullable().default(null),
  is_blank: z.boolean().default(false),
  is_target_word: z.boolean().default(false),
});

export const magicQuestChoiceTokenSchema = z.object({
  id: z.uuid(),
  text: z.string().min(1),
  is_target: z.boolean().default(false),
});

export const magicWordQuestRoundSchema = z.object({
  round_number: z.number().int().min(1).max(4),
  target_word: z.string().min(1),
  normalized_word: z.string().min(1),
  is_weak_target: z.boolean().default(true),
  phonics_category: z.string().default("general"),
  phonics_label_vi: z.string().default("Từ cần ôn"),
  sentence_text: z.string().min(1),
  prompt_hint_vi: z.string().min(1),
  prompt_slots: z.array(magicQuestPromptSlotSchema),
  choices: z.array(magicQuestChoiceTokenSchema).min(2).max(4),
  expected_choice_id: z.uuid(),
});

export const magicWordQuestSchema = z.object({
  quest_id: z.uuid(),
  child_id: z.uuid(),
  child_grade: z.number().int().min(1).max(5),
  title_vi: z.string(),
  intro_vi: z.string(),
  ephemeral_badge_vi: z.string(),
  dissolve_message_template_vi: z.string(),
  source_kind: magicQuestSourceKindSchema,
  provider_tier: magicQuestProviderTierSchema,
  target_words: z.array(z.string()),
  rounds: z.array(magicWordQuestRoundSchema).min(3).max(4),
  expires_at: z.string(),
  quest_exp: z.number().int().positive(),
  quest_sig: z.string().regex(/^[0-9a-f]{64}$/i),
});

export const completeMagicWordQuestResponseSchema = z.object({
  quest_id: z.uuid(),
  child_id: z.uuid(),
  recorded_evidence_skills: z.array(z.string()).default([]),
  already_recorded: z.boolean().default(false),
  stars_earned: z.number().int().min(1).max(3),
  ephemeral_cleared: z.boolean().default(true),
});

export const magicRhythmChantLineSchema = z.object({
  line_number: z.number().int().min(1).max(4),
  line_text: z.string().min(1),
  target_word: z.string().min(1),
  normalized_word: z.string().min(1),
  is_weak_target: z.boolean().default(true),
  phonics_category: z.string().default("general"),
  phonics_label_vi: z.string().default("Từ cần ôn"),
  beat_count: z.number().int().min(2).max(8).default(4),
  clap_hint_vi: z.string().min(1),
});

export const magicRhythmChantSchema = z.object({
  chant_id: z.uuid(),
  child_id: z.uuid(),
  child_grade: z.number().int().min(1).max(5),
  title_vi: z.string(),
  intro_vi: z.string(),
  ephemeral_badge_vi: z.string(),
  dissolve_message_template_vi: z.string(),
  bpm: z.number().int().min(40).max(160).default(80),
  source_kind: magicQuestSourceKindSchema,
  provider_tier: magicQuestProviderTierSchema,
  target_words: z.array(z.string()),
  lines: z.array(magicRhythmChantLineSchema).min(3).max(4),
  expires_at: z.string(),
  chant_exp: z.number().int().positive(),
  chant_sig: z.string().regex(/^[0-9a-f]{64}$/i),
});

export const completeMagicRhythmChantResponseSchema = z.object({
  chant_id: z.uuid(),
  child_id: z.uuid(),
  recorded_evidence_skills: z.array(z.string()).default([]),
  already_recorded: z.boolean().default(false),
  stars_earned: z.number().int().min(1).max(3),
  ephemeral_cleared: z.boolean().default(true),
});

export interface AdaptiveLearningService {
  getRecommendations(
    childId: string,
    teacherGender?: "female" | "male",
    options?: {
      readonly bypassCache?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<EntertainmentRecommendationsDTO>;
  getParentAnalytics(
    childId: string,
    windowDays?: number,
    teacherGender?: "female" | "male",
  ): Promise<ParentEntertainmentAnalyticsDTO>;
  getDailyFiveMinuteTrain(
    childId: string,
    teacherGender?: "female" | "male",
  ): Promise<DailyFiveMinuteTrainDTO>;
  completeDailyFiveMinuteTrain(
    childId: string,
    payload: DailyFiveMinuteTrainCompleteRequestDTO,
  ): Promise<DailyFiveMinuteTrainCompleteResponseDTO>;
  getWarmupStory(
    childId: string,
    options?: { readonly refresh?: boolean },
  ): Promise<WarmupMicroStoryDTO>;
  createMagicWordQuest(
    childId: string,
    input?: CreateMagicWordQuestInput,
    signal?: AbortSignal,
  ): Promise<MagicWordQuestDTO>;
  completeMagicWordQuest(
    childId: string,
    payload: CompleteMagicWordQuestInput,
    signal?: AbortSignal,
  ): Promise<CompleteMagicWordQuestResponseDTO>;
  createMagicRhythmChant(
    childId: string,
    input?: CreateMagicRhythmChantInput,
    signal?: AbortSignal,
  ): Promise<MagicRhythmChantDTO>;
  completeMagicRhythmChant(
    childId: string,
    payload: CompleteMagicRhythmChantInput,
    signal?: AbortSignal,
  ): Promise<CompleteMagicRhythmChantResponseDTO>;
}

export function createAdaptiveLearningService(): AdaptiveLearningService {
  return {
    getRecommendations(
      childId: string,
      teacherGender?: "female" | "male",
      options?: {
        readonly bypassCache?: boolean;
        readonly signal?: AbortSignal;
      },
    ) {
      const suffix = teacherGender
        ? `?teacher_gender=${encodeURIComponent(teacherGender)}`
        : "";
      return requestApi(
        `/learning/children/${encodeURIComponent(childId)}/recommendations${suffix}`,
        entertainmentRecommendationsSchema,
        options?.signal,
        options?.bypassCache ? { bypassCache: true } : undefined,
      );
    },
    getParentAnalytics(
      childId: string,
      windowDays = 30,
      teacherGender?: "female" | "male",
    ) {
      const genderParam = teacherGender
        ? `&teacher_gender=${encodeURIComponent(teacherGender)}`
        : "";
      return requestApi(
        `/learning/children/${encodeURIComponent(childId)}/parent-analytics?window_days=${windowDays}${genderParam}`,
        parentEntertainmentAnalyticsSchema,
      );
    },
    getDailyFiveMinuteTrain(
      childId: string,
      teacherGender?: "female" | "male",
    ) {
      const suffix = teacherGender
        ? `?teacher_gender=${encodeURIComponent(teacherGender)}`
        : "";
      return requestApi(
        `/learning/children/${encodeURIComponent(childId)}/daily-five-minute-train${suffix}`,
        dailyFiveMinuteTrainSchema,
        undefined,
        { bypassCache: true },
      );
    },
    completeDailyFiveMinuteTrain(
      childId: string,
      payload: DailyFiveMinuteTrainCompleteRequestDTO,
    ) {
      return requestApi(
        `/learning/children/${encodeURIComponent(childId)}/daily-five-minute-train/complete`,
        dailyFiveMinuteTrainCompleteResponseSchema,
        undefined,
        {
          method: "POST",
          body: payload,
        },
      );
    },
    createMagicWordQuest(
      childId: string,
      input: CreateMagicWordQuestInput = {},
      signal?: AbortSignal,
    ) {
      const body = {
        ...(input.focus_words ? { focus_words: input.focus_words } : {}),
        ...(input.teacher_gender
          ? { teacher_gender: input.teacher_gender }
          : {}),
        ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
      };
      return requestApi(
        `/learning/children/${encodeURIComponent(childId)}/magic-word-quest`,
        magicWordQuestSchema,
        signal,
        {
          method: "POST",
          body,
          bypassCache: true,
        },
      );
    },
    completeMagicWordQuest(
      childId: string,
      payload: CompleteMagicWordQuestInput,
      signal?: AbortSignal,
    ) {
      return requestApi(
        `/learning/children/${encodeURIComponent(childId)}/magic-word-quest/complete`,
        completeMagicWordQuestResponseSchema,
        signal,
        {
          method: "POST",
          body: payload,
          bypassCache: true,
        },
      );
    },
    createMagicRhythmChant(
      childId: string,
      input: CreateMagicRhythmChantInput = {},
      signal?: AbortSignal,
    ) {
      const body = {
        ...(input.focus_words ? { focus_words: input.focus_words } : {}),
        ...(input.teacher_gender
          ? { teacher_gender: input.teacher_gender }
          : {}),
        ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
      };
      return requestApi(
        `/learning/children/${encodeURIComponent(childId)}/magic-rhythm-chant`,
        magicRhythmChantSchema,
        signal,
        {
          method: "POST",
          body,
          bypassCache: true,
        },
      );
    },
    completeMagicRhythmChant(
      childId: string,
      payload: CompleteMagicRhythmChantInput,
      signal?: AbortSignal,
    ) {
      return requestApi(
        `/learning/children/${encodeURIComponent(childId)}/magic-rhythm-chant/complete`,
        completeMagicRhythmChantResponseSchema,
        signal,
        {
          method: "POST",
          body: payload,
          bypassCache: true,
        },
      );
    },
    getWarmupStory(childId: string, options?: { readonly refresh?: boolean }) {
      const suffix = options?.refresh ? "?refresh=true" : "";
      return requestApi(
        `/learning/children/${encodeURIComponent(childId)}/warmup-story${suffix}`,
        warmupMicroStorySchema,
      );
    },
  };
}
