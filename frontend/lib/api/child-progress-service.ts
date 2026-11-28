import { z } from "zod";
import { readingAssessmentSchema } from "@/lib/api/reading-assessment-schema";

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
    reading_assessment: readingAssessmentSchema.nullable().optional(),
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
  phonological_patterns: z
    .array(
      z.object({
        pattern_key: z.string(),
        category: z.enum(["TONE", "ONSET", "CODA"]),
        unit_a: z.string(),
        unit_b: z.string(),
        title_vi: z.string(),
        summary_vi: z.string(),
        occurrences: z.number().int().positive(),
        distinct_sessions: z.number().int().positive(),
        examples: z
          .array(
            z.object({
              expected_word: z.string(),
              spoken_word: z.string(),
              occurrences: z.number().int().positive(),
            }),
          )
          .default([]),
        minimal_pairs: z
          .array(
            z.object({
              pattern_key: z.string().nullable().optional(),
              word_a: z.string(),
              word_b: z.string(),
              target_word: z.string(),
              contrast_word: z.string(),
              hint_vi: z.string(),
              origin: z
                .enum(["CHILD_HISTORY", "CURATED_GRADE1"])
                .default("CURATED_GRADE1"),
            }),
          )
          .default([]),
      }),
    )
    .optional(),
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
  ai_fallback_reason: z.string().nullable().optional(),
});

const phonologySandboxSchema = z.object({
  child_id: z.string().uuid(),
  days: z.number().int().min(7).max(90),
  is_diagnostic: z.boolean().default(false),
  disclaimer_vi: z.string(),
  has_recurring_patterns: z.boolean().default(false),
  patterns: z
    .array(
      z.object({
        pattern_key: z.string(),
        category: z.enum(["TONE", "ONSET", "CODA"]),
        unit_a: z.string(),
        unit_b: z.string(),
        title_vi: z.string(),
        summary_vi: z.string(),
        occurrences: z.number().int().positive(),
        distinct_sessions: z.number().int().positive(),
        examples: z
          .array(
            z.object({
              expected_word: z.string(),
              spoken_word: z.string(),
              occurrences: z.number().int().positive(),
            }),
          )
          .default([]),
        minimal_pairs: z
          .array(
            z.object({
              pattern_key: z.string().nullable().optional(),
              word_a: z.string(),
              word_b: z.string(),
              target_word: z.string(),
              contrast_word: z.string(),
              hint_vi: z.string(),
              origin: z
                .enum(["CHILD_HISTORY", "CURATED_GRADE1"])
                .default("CURATED_GRADE1"),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  recommended_pairs: z
    .array(
      z.object({
        pattern_key: z.string().nullable().optional(),
        word_a: z.string(),
        word_b: z.string(),
        target_word: z.string(),
        contrast_word: z.string(),
        hint_vi: z.string(),
        origin: z
          .enum(["CHILD_HISTORY", "CURATED_GRADE1"])
          .default("CURATED_GRADE1"),
      }),
    )
    .default([]),
  duration_seconds: z.number().int().min(30).max(180).default(60),
});

export type ChildProgressAssessment = z.infer<typeof assessmentSchema>;
export type PhonologySandboxDTO = z.infer<typeof phonologySandboxSchema>;
export type PhonologicalPatternDTO = PhonologySandboxDTO["patterns"][number];
export type MinimalPairExerciseDTO =
  PhonologySandboxDTO["recommended_pairs"][number];

export interface ChildProgressService {
  /** Scores and metrics now; comments are cached AI text or offline comments. */
  get(
    childId: string,
    days: number,
    signal?: AbortSignal,
    teacherGender?: "female" | "male",
  ): Promise<ChildProgressAssessment>;
  /** Asks the AI to write the assessment (cached while the data is unchanged). */
  generate(
    childId: string,
    days: number,
    options?: {
      readonly refresh?: boolean;
      readonly signal?: AbortSignal;
      readonly teacherGender?: "female" | "male";
    },
  ): Promise<ChildProgressAssessment>;
  /** Loads 60s Vietnamese minimal-pair phonological warm-up exercises. */
  getPhonologySandbox?(
    childId: string,
    days?: number,
    signal?: AbortSignal,
  ): Promise<PhonologySandboxDTO>;
}

function path(childId: string): string {
  return `/tutor/children/${encodeURIComponent(childId)}/progress-assessment`;
}

function sandboxPath(childId: string): string {
  return `/tutor/children/${encodeURIComponent(childId)}/phonology-sandbox`;
}

export function createChildProgressService(): ChildProgressService {
  return {
    get: (childId, days, signal, teacherGender) => {
      const genderSuffix = teacherGender
        ? `&teacher_gender=${encodeURIComponent(teacherGender)}`
        : "";
      return requestApi(
        `${path(childId)}?days=${encodeURIComponent(String(days))}${genderSuffix}`,
        assessmentSchema.refine((value) => value.child_id === childId),
        signal,
      );
    },
    generate: (childId, days, options = {}) =>
      requestApi(
        path(childId),
        assessmentSchema.refine((value) => value.child_id === childId),
        options.signal,
        {
          method: "POST",
          body: {
            days,
            refresh: options.refresh ?? false,
            ...(options.teacherGender
              ? { teacher_gender: options.teacherGender }
              : {}),
          },
          timeoutMs: 45_000,
          retryOnColdStart: true,
        },
      ),
    getPhonologySandbox: (childId, days = 30, signal) =>
      requestApi(
        `${sandboxPath(childId)}?days=${encodeURIComponent(String(days))}`,
        phonologySandboxSchema.refine((value) => value.child_id === childId),
        signal,
      ),
  };
}
