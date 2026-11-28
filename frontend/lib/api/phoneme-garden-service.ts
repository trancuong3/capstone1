import { z } from "zod/v4";

import { requestApi } from "@/lib/api/api-client";

const uuidStringSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "Invalid UUID",
  );

export const BedStageSchema = z.enum(["SEED", "SPROUT", "BUD", "BLOOM"]);
export type BedStage = z.infer<typeof BedStageSchema>;

export const PhonicsBedKeySchema = z.enum([
  "l_n",
  "s_x",
  "tr_ch",
  "r_d_gi",
  "hoi_nga",
  "coda_n_ng_t_c",
  "compound_reduplicative",
]);
export type PhonicsBedKey = z.infer<typeof PhonicsBedKeySchema>;

export const PlantSymbolKeySchema = z.enum([
  "lotus",
  "apricot",
  "bamboo",
  "sunflower",
  "chrysanthemum",
  "peach",
  "flamboyant",
]);
export type PlantSymbolKey = z.infer<typeof PlantSymbolKeySchema>;

export const BookStampMotifSchema = z.enum([
  "LOTUS_SEAL",
  "BAMBOO_SCROLL",
  "STARLIGHT_LANTERN",
  "SUNRISE_KITE",
  "BANYAN_LEAF",
]);
export type BookStampMotif = z.infer<typeof BookStampMotifSchema>;

export const MilestoneStampKeySchema = z.enum([
  "first_session",
  "five_sessions",
  "ten_sessions",
  "first_mastered_bed",
]);
export type MilestoneStampKey = z.infer<typeof MilestoneStampKeySchema>;

export const MilestoneCategorySchema = z.enum(["CALM_CYCLE", "PHONEME_BLOOM"]);
export type MilestoneCategory = z.infer<typeof MilestoneCategorySchema>;

export const PhonemeBedSchema = z.object({
  bed_key: PhonicsBedKeySchema,
  phonics_label_vi: z.string(),
  plant_name_vi: z.string(),
  plant_symbol: PlantSymbolKeySchema,
  stage: BedStageSchema,
  stage_index: z.number().int().min(0).max(3),
  practiced_words_count: z.number().int().min(0),
  mastered_words_count: z.number().int().min(0),
  mastered_words: z.array(z.string()),
  practiced_words: z.array(z.string()),
  next_stage: BedStageSchema.nullable(),
  words_to_next_stage: z.number().int().min(0),
  encouragement_vi: z.string(),
});
export type PhonemeBedDTO = z.infer<typeof PhonemeBedSchema>;

export const BookStampSchema = z.object({
  stamp_key: z.string(),
  book_id: uuidStringSchema,
  book_title: z.string(),
  completed_at: z.string().min(1),
  completed_sessions_count: z.number().int().min(1),
  motif: BookStampMotifSchema,
});
export type BookStampDTO = z.infer<typeof BookStampSchema>;

export const MilestoneStampSchema = z.object({
  stamp_key: MilestoneStampKeySchema,
  category: MilestoneCategorySchema,
  title_vi: z.string(),
  description_vi: z.string(),
  unlocked: z.boolean(),
  progress_current: z.number().int().min(0),
  progress_target: z.number().int().min(1),
  unlocked_at: z.string().nullable(),
});
export type MilestoneStampDTO = z.infer<typeof MilestoneStampSchema>;

export const PhonemeGardenSummarySchema = z.object({
  visibility: z.literal("PARENT_PRIVATE"),
  child_id: uuidStringSchema,
  child_alias: z.string(),
  child_grade: z.number().int().min(1).max(5),
  beds: z.array(PhonemeBedSchema).length(7),
  book_stamps: z.array(BookStampSchema),
  milestone_stamps: z.array(MilestoneStampSchema),
  bloomed_beds_count: z.number().int().min(0).max(7),
  total_practiced_words: z.number().int().min(0),
  total_mastered_words: z.number().int().min(0),
  total_completed_books: z.number().int().min(0),
  total_completed_sessions: z.number().int().min(0),
  unlocked_milestone_stamps_count: z.number().int().min(0),
  gentle_message_vi: z.string(),
  calm_pedagogy_note_vi: z.string(),
});
export type PhonemeGardenSummaryDTO = z.infer<
  typeof PhonemeGardenSummarySchema
>;

export interface PhonemeGardenService {
  getChildSummary(
    childId: string,
    signal?: AbortSignal,
  ): Promise<PhonemeGardenSummaryDTO>;
}

const BASE_PATH = "/phoneme-garden";

export function createPhonemeGardenService(): PhonemeGardenService {
  return {
    getChildSummary(childId, signal) {
      return requestApi(
        `${BASE_PATH}/children/${encodeURIComponent(childId)}/summary`,
        PhonemeGardenSummarySchema,
        signal,
        {
          bypassCache: true,
          timeoutMs: 15_000,
        },
      );
    },
  };
}

export function fetchPhonemeGardenSummary(
  childId: string,
  signal?: AbortSignal,
): Promise<PhonemeGardenSummaryDTO> {
  return createPhonemeGardenService().getChildSummary(childId, signal);
}
