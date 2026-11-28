import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";

// ─── Enums ──────────────────────────────────────────────────────────────────

export const phoneticProfileSchema = z.enum([
  "STRICT_SGK",
  "NORTH_TOLERANT",
  "CENTRAL_TOLERANT",
  "SOUTH_TOLERANT",
]);
export type PhoneticProfile = z.infer<typeof phoneticProfileSchema>;

export const earTrainerCompletionModeSchema = z.enum([
  "VOICE_ECHO",
  "CALM_TAP",
]);
export type EarTrainerCompletionMode = z.infer<
  typeof earTrainerCompletionModeSchema
>;

// ─── Profile ─────────────────────────────────────────────────────────────────

export const regionalPhoneticProfileResponseSchema = z.object({
  child_id: z.string(),
  phonetic_profile: phoneticProfileSchema.default("STRICT_SGK"),
  visibility: z.literal("PARENT_PRIVATE").optional().default("PARENT_PRIVATE"),
});

export type RegionalPhoneticProfileDTO = z.infer<
  typeof regionalPhoneticProfileResponseSchema
>;

// ─── Alignment evaluation ────────────────────────────────────────────────────

export const regionalVariantMatchSchema = z.object({
  reference_word: z.string(),
  spoken_word: z.string(),
  variant_rule: z.string(),
  book_index: z.number().int().nonnegative().nullable().optional(),
});

export const alignmentEvaluateResponseSchema = z.object({
  phonetic_profile: phoneticProfileSchema,
  strict_sgk_accuracy: z.number().min(0).max(1),
  regional_tolerant_accuracy: z.number().min(0).max(1),
  total_reference_words: z.number().int().min(0),
  regional_variant_matches: z.array(regionalVariantMatchSchema).default([]),
  true_error_words: z.array(z.string()).default([]),
  visibility: z.literal("PARENT_PRIVATE").optional().default("PARENT_PRIVATE"),
});

export type AlignmentEvaluateDTO = z.infer<
  typeof alignmentEvaluateResponseSchema
>;
export type RegionalVariantMatchDTO = z.infer<
  typeof regionalVariantMatchSchema
>;

// ─── Ear Trainer ─────────────────────────────────────────────────────────────

export const minimalPairRoundSchema = z.object({
  round_index: z.number().int().min(0),
  target_word: z.string(),
  distractor_word: z.string(),
  options: z.array(z.string()).optional().default([]),
  tts_text: z.string(),
  contrastive_keyterms: z.array(z.string()).default([]),
  phonics_category: z.string().default("general"),
  phonics_category_label_vi: z.string().optional().default("Từ cần ôn"),
});

export const earTrainer30sResponseSchema = z.object({
  child_id: z.string(),
  phonetic_profile: phoneticProfileSchema,
  rounds: z.array(minimalPairRoundSchema),
  total_rounds: z.number().int().default(3),
  duration_seconds: z.number().int().default(30),
  focus_weak_categories: z.array(z.string()).optional().default([]),
  visibility: z.literal("PARENT_PRIVATE").optional().default("PARENT_PRIVATE"),
});

export const earTrainerCompleteResponseSchema = z.object({
  child_id: z.string(),
  phonetic_profile: phoneticProfileSchema.optional().default("STRICT_SGK"),
  rounds_attempted: z.number().int().min(1),
  rounds_correct: z.number().int().min(0),
  accuracy: z.number().min(0).max(1),
  phase_b_spoken: z.boolean().optional().default(false),
  completion_mode: earTrainerCompletionModeSchema
    .optional()
    .default("CALM_TAP"),
  xp_earned: z.number().int().min(0),
  message_vi: z.string(),
  message_en: z.string(),
  visibility: z.literal("PARENT_PRIVATE").optional().default("PARENT_PRIVATE"),
});

export type EarTrainer30sDTO = z.infer<typeof earTrainer30sResponseSchema>;
export type MinimalPairRoundDTO = z.infer<typeof minimalPairRoundSchema>;
export type EarTrainerCompleteDTO = z.infer<
  typeof earTrainerCompleteResponseSchema
>;

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface UpdatePhoneticProfileInput {
  readonly phonetic_profile: PhoneticProfile;
}

export interface EvaluateAlignmentInput {
  readonly reference_text: string;
  readonly spoken_text: string;
  readonly phonetic_profile_override?: PhoneticProfile | null;
}

export interface CompleteEarTrainerInput {
  readonly rounds_attempted: number;
  readonly rounds_correct: number;
  readonly phase_b_spoken: boolean;
  readonly practiced_words?: readonly string[];
}

// ─── Deterministic Dual-Score Fairness Preview Samples ───────────────────────

export interface DialectPreviewSample {
  readonly referenceText: string;
  readonly spokenText: string;
  readonly fallbackEvaluation: AlignmentEvaluateDTO;
}

export const DIALECT_PREVIEW_SAMPLES: Readonly<
  Record<PhoneticProfile, DialectPreviewSample>
> = {
  STRICT_SGK: {
    referenceText: "Mùa lúa chín chim sẻ hót vang",
    spokenText: "Mùa núa chín chim xẻ vang",
    fallbackEvaluation: {
      phonetic_profile: "STRICT_SGK",
      strict_sgk_accuracy: 0.4286,
      regional_tolerant_accuracy: 0.4286,
      total_reference_words: 7,
      regional_variant_matches: [],
      true_error_words: ["lúa", "sẻ", "hót"],
      visibility: "PARENT_PRIVATE",
    },
  },
  NORTH_TOLERANT: {
    referenceText: "Mùa lúa chín chim sẻ hót vang",
    spokenText: "Mùa núa chín chim xẻ vang",
    fallbackEvaluation: {
      phonetic_profile: "NORTH_TOLERANT",
      strict_sgk_accuracy: 0.4286,
      regional_tolerant_accuracy: 0.7143,
      total_reference_words: 7,
      regional_variant_matches: [
        {
          reference_word: "lúa",
          spoken_word: "núa",
          variant_rule: "NORTH:onset_l_n",
          book_index: 1,
        },
        {
          reference_word: "sẻ",
          spoken_word: "xẻ",
          variant_rule: "NORTH:onset_s_x",
          book_index: 4,
        },
      ],
      true_error_words: ["hót"],
      visibility: "PARENT_PRIVATE",
    },
  },
  CENTRAL_TOLERANT: {
    referenceText: "Gió mát thổi qua ngõ cũ nhà em",
    spokenText: "Gió mác thổi qua ngỏ củ em",
    fallbackEvaluation: {
      phonetic_profile: "CENTRAL_TOLERANT",
      strict_sgk_accuracy: 0.5,
      regional_tolerant_accuracy: 0.875,
      total_reference_words: 8,
      regional_variant_matches: [
        {
          reference_word: "mát",
          spoken_word: "mác",
          variant_rule: "CENTRAL:coda_c_t",
          book_index: 1,
        },
        {
          reference_word: "ngõ",
          spoken_word: "ngỏ",
          variant_rule: "CENTRAL:tone_hoi_nga",
          book_index: 4,
        },
        {
          reference_word: "cũ",
          spoken_word: "củ",
          variant_rule: "CENTRAL:tone_hoi_nga",
          book_index: 5,
        },
      ],
      true_error_words: ["nhà"],
      visibility: "PARENT_PRIVATE",
    },
  },
  SOUTH_TOLERANT: {
    referenceText: "Bé về nhà mang tin vui cho mẹ",
    spokenText: "Bé dề nhà mang tinh dui mẹ",
    fallbackEvaluation: {
      phonetic_profile: "SOUTH_TOLERANT",
      strict_sgk_accuracy: 0.5,
      regional_tolerant_accuracy: 0.875,
      total_reference_words: 8,
      regional_variant_matches: [
        {
          reference_word: "về",
          spoken_word: "dề",
          variant_rule: "SOUTH:onset_d_v",
          book_index: 1,
        },
        {
          reference_word: "tin",
          spoken_word: "tinh",
          variant_rule: "SOUTH:coda_n_nh",
          book_index: 4,
        },
        {
          reference_word: "vui",
          spoken_word: "dui",
          variant_rule: "SOUTH:onset_d_v",
          book_index: 5,
        },
      ],
      true_error_words: ["cho"],
      visibility: "PARENT_PRIVATE",
    },
  },
};

// ─── Service interface ────────────────────────────────────────────────────────

export interface RegionalPhoneticService {
  getProfile(childId: string): Promise<RegionalPhoneticProfileDTO>;
  updateProfile(
    childId: string,
    input: UpdatePhoneticProfileInput,
  ): Promise<RegionalPhoneticProfileDTO>;
  evaluateAlignment(
    childId: string,
    input: EvaluateAlignmentInput,
  ): Promise<AlignmentEvaluateDTO>;
  getEarTrainer(childId: string): Promise<EarTrainer30sDTO>;
  completeEarTrainer(
    childId: string,
    input: CompleteEarTrainerInput,
  ): Promise<EarTrainerCompleteDTO>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export function createRegionalPhoneticService(): RegionalPhoneticService {
  return {
    async getProfile(childId) {
      return requestApi(
        `/dialect/children/${encodeURIComponent(childId)}/profile`,
        regionalPhoneticProfileResponseSchema,
      );
    },

    async updateProfile(childId, input) {
      return requestApi(
        `/dialect/children/${encodeURIComponent(childId)}/profile`,
        regionalPhoneticProfileResponseSchema,
        undefined,
        {
          method: "PUT",
          body: input,
        },
      );
    },

    async evaluateAlignment(childId, input) {
      const payload: Record<string, unknown> = {
        reference_text: input.reference_text,
        spoken_text: input.spoken_text,
      };
      if (input.phonetic_profile_override) {
        payload.phonetic_profile_override = input.phonetic_profile_override;
      }
      return requestApi(
        `/dialect/children/${encodeURIComponent(childId)}/evaluate-alignment`,
        alignmentEvaluateResponseSchema,
        undefined,
        {
          method: "POST",
          body: payload,
        },
      );
    },

    async getEarTrainer(childId) {
      return requestApi(
        `/dialect/children/${encodeURIComponent(childId)}/ear-trainer-30s`,
        earTrainer30sResponseSchema,
      );
    },

    async completeEarTrainer(childId, input) {
      return requestApi(
        `/dialect/children/${encodeURIComponent(childId)}/ear-trainer-30s/complete`,
        earTrainerCompleteResponseSchema,
        undefined,
        {
          method: "POST",
          body: {
            rounds_attempted: input.rounds_attempted,
            rounds_correct: input.rounds_correct,
            phase_b_spoken: input.phase_b_spoken,
            practiced_words: input.practiced_words ?? [],
          },
        },
      );
    },
  };
}

export const defaultRegionalPhoneticService: RegionalPhoneticService =
  createRegionalPhoneticService();
