import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";

const gradeBandSchema = z.enum(["GRADE_1_2", "GRADE_3_5"]);

const wordExplainResponseSchema = z.object({
  word: z.string(),
  normalized_word: z.string(),
  grade_band: gradeBandSchema,
  part_of_speech_vi: z.string().nullable().optional(),
  definition_vi: z.string(),
  example_sentence_vi: z.string(),
  nuance_note_vi: z.string().nullable().optional(),
  spoken_tts_text: z.string(),
  source_provider: z.string(),
  cached: z.boolean().optional().default(false),
  fallback_used: z.boolean().optional().default(false),
  safety_checked: z.boolean().optional().default(true),
  is_saved_in_notebook: z.boolean().optional().default(false),
  notebook_item_id: z.string().nullable().optional(),
});

const favoriteWordSchema = z.object({
  id: z.string(),
  child_profile_id: z.string(),
  word: z.string(),
  normalized_word: z.string(),
  grade_band: gradeBandSchema,
  definition_vi: z.string(),
  example_sentence_vi: z.string(),
  nuance_note_vi: z.string().nullable().optional(),
  spoken_tts_text: z.string(),
  source_book_id: z.string().nullable().optional(),
  source_page_id: z.string().nullable().optional(),
  visibility: z.literal("PARENT_PRIVATE").optional().default("PARENT_PRIVATE"),
  times_used_in_games: z.number().int().min(0).optional().default(0),
  already_saved: z.boolean().optional().default(false),
  created_at: z.string(),
  updated_at: z.string(),
});

const notebookListResponseSchema = z.object({
  child_id: z.string(),
  total: z.number().int().min(0),
  storytelling_words: z.array(z.string()).optional().default([]),
  items: z.array(favoriteWordSchema),
});

const deleteFavoriteWordResponseSchema = z.object({
  deleted: z.boolean(),
  item_id: z.string(),
});

export type GlossaryGradeBand = z.infer<typeof gradeBandSchema>;
export type WordExplainDTO = z.infer<typeof wordExplainResponseSchema>;
export type FavoriteWordDTO = z.infer<typeof favoriteWordSchema>;
export type VocabularyNotebookListDTO = z.infer<
  typeof notebookListResponseSchema
>;

export interface ExplainWordInput {
  readonly word: string;
  readonly context_sentence?: string | null;
  readonly grade_override?: number | null;
}

export interface SaveFavoriteWordInput {
  readonly word: string;
  readonly definition_vi?: string | null;
  readonly example_sentence_vi?: string | null;
  readonly nuance_note_vi?: string | null;
  readonly grade_band?: GlossaryGradeBand | null;
  readonly source_book_id?: string | null;
  readonly source_page_id?: string | null;
}

export interface VocabularyNotebookService {
  explainWord(
    childId: string,
    input: ExplainWordInput,
    signal?: AbortSignal,
  ): Promise<WordExplainDTO>;
  listNotebook(
    childId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<VocabularyNotebookListDTO>;
  saveWord(
    childId: string,
    input: SaveFavoriteWordInput,
    signal?: AbortSignal,
  ): Promise<FavoriteWordDTO>;
  deleteWord(
    childId: string,
    itemId: string,
    signal?: AbortSignal,
  ): Promise<{ deleted: boolean; item_id: string }>;
}

const basePath = "/vocabulary";

export function buildLocalPreviewExplanation(
  rawWord: string,
  grade: number | null | undefined,
): WordExplainDTO {
  const cleanWord =
    rawWord
      .normalize("NFC")
      .trim()
      .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "") || rawWord.trim();
  const normalized = cleanWord.toLowerCase();
  const gradeBand: GlossaryGradeBand =
    typeof grade === "number" && grade >= 3 ? "GRADE_3_5" : "GRADE_1_2";
  const definitionVi =
    gradeBand === "GRADE_1_2"
      ? `Từ «${cleanWord}» giúp bé gọi tên hoặc tả sự vật, hoạt động quen thuộc trong bài đọc.`
      : `Từ «${cleanWord}» dùng trong câu văn tiếng Việt để làm rõ hình ảnh, hoạt động hoặc phẩm chất đang được nhắc tới.`;
  const exampleVi =
    gradeBand === "GRADE_1_2"
      ? `Bé đọc to từ «${cleanWord}» thật rõ ràng cùng gia đình ở nhà.`
      : `Trong giờ Tập đọc ở lớp, em đã dùng từ «${cleanWord}» để đặt một câu kể chuyện thật hay.`;
  const nuanceVi =
    gradeBand === "GRADE_3_5" && cleanWord.includes(" ")
      ? `Từ ghép «${cleanWord}» giúp lời kể chuyện của em sinh động và giàu hình ảnh hơn.`
      : null;
  return {
    word: cleanWord,
    normalized_word: normalized,
    grade_band: gradeBand,
    part_of_speech_vi: null,
    definition_vi: definitionVi,
    example_sentence_vi: exampleVi,
    nuance_note_vi: nuanceVi,
    spoken_tts_text: `Từ ${cleanWord}. ${definitionVi} Ví dụ: ${exampleVi}`,
    source_provider: "LOCAL_PREVIEW",
    cached: false,
    fallback_used: true,
    safety_checked: true,
    is_saved_in_notebook: false,
    notebook_item_id: null,
  };
}

export function createVocabularyNotebookService(): VocabularyNotebookService {
  return {
    explainWord(childId, input, signal) {
      return requestApi(
        `${basePath}/children/${encodeURIComponent(childId)}/explain`,
        wordExplainResponseSchema,
        signal,
        {
          method: "POST",
          body: {
            word: input.word,
            ...(input.context_sentence
              ? { context_sentence: input.context_sentence }
              : {}),
            ...(typeof input.grade_override === "number"
              ? { grade_override: input.grade_override }
              : {}),
          },
          timeoutMs: 15_000,
        },
      );
    },

    listNotebook(childId, limit = 50, signal) {
      return requestApi(
        `${basePath}/children/${encodeURIComponent(childId)}/notebook${apiQuery({ limit })}`,
        notebookListResponseSchema,
        signal,
        { bypassCache: true, timeoutMs: 15_000 },
      );
    },

    saveWord(childId, input, signal) {
      return requestApi(
        `${basePath}/children/${encodeURIComponent(childId)}/notebook`,
        favoriteWordSchema,
        signal,
        {
          method: "POST",
          body: {
            word: input.word,
            ...(input.definition_vi
              ? { definition_vi: input.definition_vi }
              : {}),
            ...(input.example_sentence_vi
              ? { example_sentence_vi: input.example_sentence_vi }
              : {}),
            ...(input.nuance_note_vi
              ? { nuance_note_vi: input.nuance_note_vi }
              : {}),
            ...(input.grade_band ? { grade_band: input.grade_band } : {}),
            ...(input.source_book_id
              ? { source_book_id: input.source_book_id }
              : {}),
            ...(input.source_page_id
              ? { source_page_id: input.source_page_id }
              : {}),
          },
          timeoutMs: 15_000,
        },
      );
    },

    deleteWord(childId, itemId, signal) {
      return requestApi(
        `${basePath}/children/${encodeURIComponent(childId)}/notebook/${encodeURIComponent(itemId)}`,
        deleteFavoriteWordResponseSchema,
        signal,
        {
          method: "DELETE",
          timeoutMs: 15_000,
        },
      );
    },
  };
}
