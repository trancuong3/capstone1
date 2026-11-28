import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import type {
  MemoryAttemptStage,
  MemoryAttemptSubmitDTO,
  MemoryHintDTO,
  MemoryInputMode,
  MemoryPeekDTO,
  MemoryRecallMode,
  MemorySessionDTO,
  MemorySessionSummaryDTO,
  MemoryThemeSelection,
  MemoryThemesCatalogDTO,
  MemoryTimerMode,
} from "@/types/memory-game";

const themeKeySchema = z.enum([
  "sunny_garden",
  "happy_classroom",
  "mid_autumn_yard",
  "seaside_morning",
  "countryside_pond",
  "friendly_market",
]);

const timerModeSchema = z.enum([
  "10S",
  "20S",
  "30S",
  "60S",
  "90S",
  "120S",
  "UNLIMITED",
]);

const recallModeSchema = z.enum(["FREE_RECALL", "GUIDED_RECALL"]);

const statusSchema = z.enum([
  "OBSERVING",
  "RECALLING",
  "CREATIVE",
  "COMPLETED",
]);
const stageSchema = z.enum(["RECALL", "CREATIVE"]);
const inputModeSchema = z.enum(["VOICE", "TEXT"]);
const positionZoneSchema = z.enum([
  "trên trái",
  "trên phải",
  "giữa",
  "dưới trái",
  "dưới phải",
]);
const colorViSchema = z.enum([
  "đỏ",
  "xanh dương",
  "vàng",
  "xanh lá",
  "cam",
  "tím",
]);
const shapeCueSchema = z.enum([
  "circle",
  "square",
  "star",
  "triangle",
  "diamond",
  "hexagon",
]);

const bboxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().positive().max(1),
  h: z.number().positive().max(1),
});

const hintTiersSchema = z.object({
  tier_1: z.string(),
  tier_2: z.string(),
  tier_3: z.string(),
});

const sceneObjectSchema = z.object({
  id: z.string(),
  sprite_key: z.string(),
  name_vi: z.string(),
  category_vi: z.string(),
  aliases_vi: z.array(z.string()),
  color_vi: colorViSchema,
  color_hex: z.string(),
  color_stroke_hex: z.string(),
  color_light_hex: z.string(),
  shape_cue: shapeCueSchema,
  count: z.number().int().min(1).max(3),
  position_zone: positionZoneSchema,
  bbox: bboxSchema,
  action_vi: z.string(),
  hint_tiers: hintTiersSchema,
  is_focus_word: z.boolean(),
});

const backdropSchema = z.object({
  theme_key: themeKeySchema,
  sky_top_hex: z.string(),
  sky_bottom_hex: z.string(),
  horizon_hex: z.string(),
  ground_hex: z.string(),
  accent_hex: z.string(),
  mood_vi: z.string(),
});

const sceneSpecSchema = z.object({
  schema_version: z.string(),
  theme_key: themeKeySchema,
  theme_name_vi: z.string(),
  child_grade: z.number().int().min(1).max(5),
  difficulty_level: z.number().int().min(1).max(5),
  scene_seed: z.number().int().min(0),
  canvas_width: z.number().int().positive(),
  canvas_height: z.number().int().positive(),
  backdrop: backdropSchema,
  objects: z.array(sceneObjectSchema),
  observation_tips_vi: z.array(z.string()),
  guided_questions_vi: z.array(z.string()),
  creative_prompt_vi: z.string(),
  matched_focus_words: z.array(z.string()),
  creative_focus_words: z.array(z.string()).optional(),
});

const themesCatalogSchema = z.object({
  themes: z.array(
    z.object({
      theme_key: themeKeySchema,
      name_vi: z.string(),
      description_vi: z.string(),
      badge_vi: z.string(),
      accent_hex: z.string(),
      sprite_count: z.number().int().positive(),
      sample_items_vi: z.array(z.string()),
    }),
  ),
  timer_options: z.array(
    z.object({
      mode: timerModeSchema,
      seconds: z.number().int().nullable(),
      label_vi: z.string(),
      recommended_for_vi: z.string(),
    }),
  ),
  grade_recommendations: z.array(
    z.object({
      grade: z.number().int().min(1).max(5),
      min_objects: z.number().int().min(1),
      max_objects: z.number().int().min(1),
      recommended_timer: timerModeSchema,
      recommended_recall_mode: recallModeSchema,
      recommended_difficulty: z.number().int().min(1).max(5),
      note_vi: z.string(),
    }),
  ),
  total_sprites: z.number().int().min(1),
});

const matchedFactSchema = z.object({
  object_id: z.string(),
  sprite_key: z.string(),
  name_vi: z.string(),
  color_vi: z.string(),
  count: z.number().int().min(1).max(3),
  position_zone: positionZoneSchema,
  matched_attributes: z.array(z.string()),
  detail_vi: z.string(),
  bbox: bboxSchema,
});

const missedFactSchema = z.object({
  object_id: z.string(),
  sprite_key: z.string(),
  name_vi: z.string(),
  color_vi: z.string(),
  count: z.number().int().min(1).max(3),
  position_zone: positionZoneSchema,
  detail_vi: z.string(),
  hint_tier_1: z.string(),
  bbox: bboxSchema,
});

const evaluationSchema = z.object({
  stage: stageSchema,
  factual_score: z.number().int().min(0).max(100),
  creative_score: z.number().int().min(0).max(100),
  stars: z.number().int().min(0).max(3),
  matched_facts: z.array(matchedFactSchema),
  missed_facts: z.array(missedFactSchema),
  creative_highlights: z.array(z.string()),
  story_anchors: z.array(z.string()),
  praise_message_vi: z.string(),
  story_praise_vi: z.string(),
  next_tip_vi: z.string(),
  creative_followup_vi: z.string(),
  support_summary_vi: z.string().nullable(),
  used_focus_words: z.array(z.string()),
  ai_provider: z.string(),
});

const attemptSchema = z.object({
  id: z.uuid(),
  session_id: z.uuid(),
  attempt_number: z.number().int().min(1),
  stage: stageSchema,
  input_mode: inputModeSchema,
  response_text: z.string(),
  factual_score: z.number().int().min(0).max(100),
  creative_score: z.number().int().min(0).max(100),
  stars: z.number().int().min(0).max(3),
  evaluation: evaluationSchema,
  ai_provider: z.string().nullable(),
  created_at: z.string(),
});

const sessionSchema = z.object({
  id: z.uuid(),
  child_id: z.uuid(),
  child_grade: z.number().int().min(1).max(5),
  theme_key: themeKeySchema,
  theme_name_vi: z.string(),
  difficulty_level: z.number().int().min(1).max(5),
  scene_seed: z.number().int().min(0),
  timer_mode: timerModeSchema,
  timer_seconds: z.number().int().nullable(),
  recall_mode: recallModeSchema,
  status: statusSchema,
  hints_used: z.number().int().min(0),
  peek_count: z.number().int().min(0),
  best_factual_score: z.number().int().min(0).max(100),
  best_creative_score: z.number().int().min(0).max(100),
  stars: z.number().int().min(0).max(3),
  attempts_count: z.number().int().min(0),
  scene_spec: sceneSpecSchema,
  attempts: z.array(attemptSchema),
  created_at: z.string(),
  updated_at: z.string(),
});

const attemptSubmitSchema = z.object({
  attempt: attemptSchema,
  session: sessionSchema,
});

const hintSchema = z.object({
  session_id: z.uuid(),
  hints_used: z.number().int().min(0),
  object_id: z.string().nullable(),
  tier: z.number().int().min(1).max(3),
  hint_text_vi: z.string(),
  remaining_unmentioned_count: z.number().int().min(0),
  has_more_tiers: z.boolean(),
});

const peekSchema = z.object({
  session_id: z.uuid(),
  peek_count: z.number().int().min(0),
  peek_duration_seconds: z.number().int().min(1),
  message_vi: z.string(),
});

const sessionSummarySchema = z.object({
  id: z.uuid(),
  child_id: z.uuid(),
  child_grade: z.number().int().min(1).max(5),
  theme_key: themeKeySchema,
  theme_name_vi: z.string(),
  difficulty_level: z.number().int().min(1).max(5),
  timer_mode: timerModeSchema,
  timer_seconds: z.number().int().nullable(),
  recall_mode: recallModeSchema,
  status: statusSchema,
  hints_used: z.number().int().min(0),
  peek_count: z.number().int().min(0),
  best_factual_score: z.number().int().min(0).max(100),
  best_creative_score: z.number().int().min(0).max(100),
  stars: z.number().int().min(0).max(3),
  attempts_count: z.number().int().min(0),
  object_count: z.number().int().min(0),
  created_at: z.string(),
  updated_at: z.string(),
});

export interface CreateMemorySessionInput {
  readonly child_id: string;
  readonly theme_key?: MemoryThemeSelection;
  readonly timer_mode?: MemoryTimerMode;
  readonly recall_mode?: MemoryRecallMode;
  readonly difficulty_level?: number;
  readonly scene_seed?: number;
  readonly focus_words?: readonly string[];
}

export interface RequestMemoryHintInput {
  readonly mentioned_text?: string;
  readonly mentioned_object_ids?: readonly string[];
  readonly target_object_id?: string | null;
  readonly requested_tier?: number;
}

export interface SubmitMemoryAttemptInput {
  readonly stage: MemoryAttemptStage;
  readonly input_mode: MemoryInputMode;
  readonly response_text: string;
  readonly teacher_gender?: "female" | "male";
}

export interface MemoryGameService {
  getThemes(signal?: AbortSignal): Promise<MemoryThemesCatalogDTO>;
  createSession(
    input: CreateMemorySessionInput,
    signal?: AbortSignal,
  ): Promise<MemorySessionDTO>;
  listSessions(
    childId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<MemorySessionSummaryDTO[]>;
  getSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<MemorySessionDTO>;
  requestHint(
    sessionId: string,
    input?: RequestMemoryHintInput,
    signal?: AbortSignal,
  ): Promise<MemoryHintDTO>;
  recordPeek(sessionId: string, signal?: AbortSignal): Promise<MemoryPeekDTO>;
  submitAttempt(
    sessionId: string,
    input: SubmitMemoryAttemptInput,
    signal?: AbortSignal,
  ): Promise<MemoryAttemptSubmitDTO>;
}

const basePath = "/games/memory";
const requestTimeoutMs = 20_000;

async function withRequestTimeout<T>(
  signal: AbortSignal | undefined,
  request: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () =>
      controller.abort(new DOMException("Request timed out", "TimeoutError")),
    requestTimeoutMs,
  );
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    return await request(controller.signal);
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function createMemoryGameService(): MemoryGameService {
  return {
    getThemes: (signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(`${basePath}/themes`, themesCatalogSchema, requestSignal),
      ),
    createSession: (input, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(`${basePath}/sessions`, sessionSchema, requestSignal, {
          method: "POST",
          body: input,
        }),
      ),
    listSessions: (childId, limit = 10, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          `${basePath}/sessions${apiQuery({ child_id: childId, limit })}`,
          z.array(sessionSummarySchema),
          requestSignal,
        ),
      ),
    getSession: (sessionId, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          `${basePath}/sessions/${encodeURIComponent(sessionId)}`,
          sessionSchema,
          requestSignal,
        ),
      ),
    requestHint: (sessionId, input = {}, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          `${basePath}/sessions/${encodeURIComponent(sessionId)}/hint`,
          hintSchema,
          requestSignal,
          {
            method: "POST",
            body: input,
          },
        ),
      ),
    recordPeek: (sessionId, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          `${basePath}/sessions/${encodeURIComponent(sessionId)}/peek`,
          peekSchema,
          requestSignal,
          { method: "POST" },
        ),
      ),
    submitAttempt: (sessionId, input, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          `${basePath}/sessions/${encodeURIComponent(sessionId)}/attempts`,
          attemptSubmitSchema,
          requestSignal,
          {
            method: "POST",
            body: input,
          },
        ),
      ),
  };
}
