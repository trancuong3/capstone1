import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";

export const microStoryWordSourceSchema = z.enum([
  "WEAK_WORD",
  "COLD_START_GRADE",
  "PARENT_CUSTOM",
]);

export const microStoryQuotaSchema = z.object({
  child_id: z.string().min(1),
  daily_limit: z.number().int().nonnegative(),
  used_today: z.number().int().nonnegative(),
  remaining_today: z.number().int().nonnegative(),
  quota_exceeded: z.boolean(),
  resets_at_utc: z.string(),
});

export const microStoryTargetWordSchema = z.object({
  normalized_word: z.string().min(1),
  display_text: z.string().min(1),
  source: microStoryWordSourceSchema,
  priority_score: z.number(),
  practice_count: z.number().int().nonnegative().default(0),
  phonics_category: z.string(),
  phonics_label_vi: z.string(),
  reason_vi: z.string(),
  selected_by_default: z.boolean(),
});

export const microStoryPreviewSchema = z.object({
  child_id: z.string().min(1),
  child_alias: z.string(),
  child_grade: z.number().int().min(1).max(5),
  recommended_words: z.array(microStoryTargetWordSchema),
  candidate_pool: z.array(microStoryTargetWordSchema),
  cold_start_filled: z.boolean(),
  privacy_notice_vi: z.string(),
  quota: microStoryQuotaSchema,
});

export const microStoryPageSummarySchema = z.object({
  page_id: z.string().min(1),
  page_number: z.number().int().min(1).max(4),
  revision_id: z.string().min(1),
  text: z.string(),
  word_count: z.number().int().positive(),
  target_words_on_page: z.array(z.string()),
  target_word_indices: z.array(z.number().int().nonnegative()),
  image_url: z.string().min(1),
  illustration_provider: z.string(),
  illustration_fallback_used: z.boolean(),
});

export const microStoryComprehensionItemSchema = z.object({
  question_id: z.string().min(1),
  page_number: z.number().int().min(1).max(4),
  prompt: z.string(),
  choices: z.array(z.string()),
  correct_answer: z.string(),
  difficulty: z.string(),
});

export const microStoryGenerateResponseSchema = z.object({
  book_id: z.string().min(1),
  seeded_session_id: z.string().min(1),
  child_id: z.string().min(1),
  child_alias: z.string(),
  child_grade: z.number().int().min(1).max(5),
  title: z.string(),
  visibility_scope: z.literal("PARENT_PRIVATE"),
  readable_for_children: z.boolean(),
  reader_href: z.string().min(1),
  my_book_href: z.string().min(1),
  target_weak_words: z.array(microStoryTargetWordSchema),
  cold_start_filled: z.boolean(),
  story_provider: z.string(),
  illustration_provider: z.string(),
  illustration_fallback_used: z.boolean(),
  safety_status: z.enum(["PASSED", "SANITIZED_FALLBACK"]),
  pages: z.array(microStoryPageSummarySchema),
  comprehension_questions: z.array(microStoryComprehensionItemSchema),
  quota: microStoryQuotaSchema,
});

export type MicroStoryQuotaDTO = z.infer<typeof microStoryQuotaSchema>;
export type MicroStoryTargetWordDTO = z.infer<
  typeof microStoryTargetWordSchema
>;
export type MicroStoryPreviewDTO = z.infer<typeof microStoryPreviewSchema>;
export type MicroStoryPageSummaryDTO = z.infer<
  typeof microStoryPageSummarySchema
>;
export type MicroStoryComprehensionItemDTO = z.infer<
  typeof microStoryComprehensionItemSchema
>;
export type MicroStoryGenerateResponseDTO = z.infer<
  typeof microStoryGenerateResponseSchema
>;

export interface MicroStoryGenerateInput {
  readonly selected_words?: readonly string[];
  readonly theme_hint?: string | null;
  readonly title_override?: string | null;
}

export interface MicroStoryService {
  getQuota(childId: string, signal?: AbortSignal): Promise<MicroStoryQuotaDTO>;
  previewWords(
    childId: string,
    signal?: AbortSignal,
  ): Promise<MicroStoryPreviewDTO>;
  generateStory(
    childId: string,
    input: MicroStoryGenerateInput,
    signal?: AbortSignal,
  ): Promise<MicroStoryGenerateResponseDTO>;
}

export function createMicroStoryService(): MicroStoryService {
  return {
    getQuota(childId, signal) {
      return requestApi(
        `/micro-stories/children/${encodeURIComponent(childId)}/quota`,
        microStoryQuotaSchema,
        signal,
        { bypassCache: true },
      );
    },
    previewWords(childId, signal) {
      return requestApi(
        `/micro-stories/children/${encodeURIComponent(childId)}/preview-words`,
        microStoryPreviewSchema,
        signal,
        { bypassCache: true },
      );
    },
    generateStory(childId, input, signal) {
      return requestApi(
        `/micro-stories/children/${encodeURIComponent(childId)}/generate`,
        microStoryGenerateResponseSchema,
        signal,
        {
          method: "POST",
          body: input,
          timeoutMs: 60_000,
        },
      );
    },
  };
}

export const defaultMicroStoryService: MicroStoryService =
  createMicroStoryService();
