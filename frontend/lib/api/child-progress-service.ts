import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";

const nullableNumber = z.number().nullable();

const componentSchema = z.object({
  key: z.enum(["ACCURACY", "FLUENCY", "COMPREHENSION", "CONSISTENCY"]),
  label: z.string(),
  score: z.number().int().min(0).max(100).nullable(),
  previous_score: z.number().int().min(0).max(100).nullable(),
  detail: z.string(),
});

const assessmentSchema = z.object({
  child_id: z.string().uuid(),
  period_start: z.iso.date(),
  period_end: z.iso.date(),
  days: z.number().int().min(7).max(90),
  generated_at: z.iso.datetime({ offset: true }),
  data_status: z.enum(["OK", "INSUFFICIENT"]),
  score: z.object({
    overall: z.number().int().min(0).max(100).nullable(),
    previous_overall: z.number().int().min(0).max(100).nullable(),
    delta: z.number().int().nullable(),
    grade: z.enum(["EXCELLENT", "GOOD", "FAIR", "NEEDS_SUPPORT"]).nullable(),
    grade_label: z.string().nullable(),
    components: z.array(componentSchema),
  }),
  metrics: z.object({
    sessions: z.number().int().nonnegative(),
    active_days: z.number().int().nonnegative(),
    reading_minutes: z.number().int().nonnegative(),
    books: z.number().int().nonnegative(),
    pages_compared: z.number().int().nonnegative(),
    words_read: z.number().int().nonnegative(),
    coverage_pct: nullableNumber,
    accuracy_pct: nullableNumber,
    skipped_rate_pct: nullableNumber,
    substitution_rate_pct: nullableNumber,
    hesitations: z.number().int().nonnegative(),
    repeated_words: z.number().int().nonnegative(),
    hesitations_per_100_words: nullableNumber,
    words_per_minute: nullableNumber,
    comprehension_answered: z.number().int().nonnegative(),
    comprehension_first_try_pct: nullableNumber,
    comprehension_by_type: z.array(
      z.object({
        type: z.enum(["FACTUAL", "CLOZE", "VOCABULARY"]),
        answered: z.number().int().nonnegative(),
        first_try_correct: z.number().int().nonnegative(),
      }),
    ),
    retry_confirmed: z.number().int().nonnegative(),
    retry_failed: z.number().int().nonnegative(),
  }),
  weekly: z.array(
    z.object({
      week_start: z.iso.date(),
      sessions: z.number().int().nonnegative(),
      minutes: z.number().int().nonnegative(),
      accuracy_pct: nullableNumber,
    }),
  ),
  difficult_words: z.array(
    z.object({
      word: z.string(),
      times: z.number().int().positive(),
      heard_as: z.string().nullable(),
    }),
  ),
  assessment: z.object({
    source: z.enum(["AI", "RULE_BASED"]),
    model: z.string().nullable(),
    headline: z.string(),
    summary: z.string(),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.object({ area: z.string(), detail: z.string() })),
    actions: z.array(
      z.object({
        title: z.string(),
        detail: z.string(),
        audience: z.enum(["PARENT", "CHILD"]),
      }),
    ),
    practice_words: z.array(z.string()),
    encouragement: z.string(),
  }),
  ai_cached: z.boolean(),
});

export type ChildProgressAssessment = z.infer<typeof assessmentSchema>;

export interface ChildProgressService {
  /** Scores and metrics now; comments are cached AI text or offline comments. */
  get(
    childId: string,
    days: number,
    signal?: AbortSignal,
  ): Promise<ChildProgressAssessment>;
  /** Asks the AI to write the assessment (cached while the data is unchanged). */
  generate(
    childId: string,
    days: number,
    options?: { readonly refresh?: boolean; readonly signal?: AbortSignal },
  ): Promise<ChildProgressAssessment>;
}

function path(childId: string): string {
  return `/tutor/children/${encodeURIComponent(childId)}/progress-assessment`;
}

export function createChildProgressService(): ChildProgressService {
  return {
    get: (childId, days, signal) =>
      requestApi(
        `${path(childId)}?days=${encodeURIComponent(String(days))}`,
        assessmentSchema.refine((value) => value.child_id === childId),
        signal,
      ),
    generate: (childId, days, options = {}) =>
      requestApi(
        path(childId),
        assessmentSchema.refine((value) => value.child_id === childId),
        options.signal,
        {
          method: "POST",
          body: { days, refresh: options.refresh ?? false },
        },
      ),
  };
}
