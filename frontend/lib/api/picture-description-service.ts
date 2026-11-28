import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import { withRequestDeadline } from "@/lib/api/request-deadline";
import { ServiceError } from "@/lib/api/service-error";
import { translateRuntime } from "@/lib/i18n/runtime";
import { getEffectiveTeacherPersona } from "@/lib/reading/session-voice-lock";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import type {
  PictureCatalogDTO,
  PictureEvaluateResponseDTO,
  PictureInputMode,
  PictureSessionDTO,
  PictureSessionSummaryDTO,
  PictureSourceType,
  PictureTeachingMode,
} from "@/types/picture-description";

const sourceTypeSchema = z.enum(["BOOK_PAGE", "CUSTOM_UPLOAD", "SAMPLE"]);
const statusSchema = z.enum(["ACTIVE", "COMPLETED"]);
const inputModeSchema = z.enum(["VOICE", "TEXT"]);
const teachingModeSchema = z.enum([
  "OBSERVE",
  "VOCABULARY",
  "SENTENCE",
  "STORY",
  "INFER",
  "CREATE",
]);
const scaffoldingStepSchema = z.enum([
  "PRAISE",
  "EXPAND",
  "PROMPT",
  "NEXT_CHALLENGE",
]);
const providerTierSchema = z.enum([
  "CURATED",
  "GEMINI_PRIMARY",
  "GEMINI_FALLBACK",
  "GROQ_FREE",
  "LOCAL_OLLAMA",
  "DETERMINISTIC_FALLBACK",
]);

const sampleSchema = z.object({
  sample_key: z.string(),
  title: z.string(),
  theme: z.string(),
  description: z.string(),
  image_url: z.string(),
  matched_difficult_words: z.array(z.string()).optional(),
});

const bookPageSchema = z.object({
  book_id: z.uuid(),
  book_title: z.string(),
  page_id: z.uuid(),
  page_number: z.number().int().min(1),
  image_url: z.string(),
  matched_difficult_words: z.array(z.string()).optional(),
  has_verified_illustration: z.boolean().optional(),
  page_kind: z.string().nullish(),
  ocr_excerpt: z.string().nullish(),
});

const catalogSchema = z.object({
  samples: z.array(sampleSchema),
  book_pages: z.array(bookPageSchema),
  focus_difficult_words: z.array(z.string()).optional(),
  recommended_sample_key: z.string().nullish(),
  recommended_book_page_id: z.string().nullish(),
});

const vocabSchema = z.object({
  word: z.string(),
  hint: z.string(),
});

const guideSchema = z.object({
  is_child_safe: z.boolean(),
  scene_title: z.string(),
  scene_summary: z.string(),
  guiding_questions: z.array(z.string()),
  suggested_vocabulary: z.array(vocabSchema),
  model_sample_sentences: z.array(z.string()),
  teaching_mode: teachingModeSchema.optional(),
  target_words: z.array(z.string()).optional(),
});

const feedbackSchema = z.object({
  is_relevant: z.boolean(),
  score_out_of_10: z.number().int().min(0).max(10),
  stars: z.number().int().min(0).max(3),
  matched_details: z.array(z.string()),
  missed_details: z.array(z.string()),
  praise_message: z.string(),
  improvement_tip: z.string(),
  upgraded_sentences: z.array(z.string()),
  vocabulary_highlights: z.array(z.string()),
  teaching_mode: teachingModeSchema.optional(),
  scaffolding_step: scaffoldingStepSchema.nullish(),
  next_prompt_question: z.string().nullish(),
  used_target_words: z.array(z.string()).optional(),
  practiced_difficult_words: z.array(z.string()).optional(),
  provider_tier: providerTierSchema.nullish(),
});

const attemptSchema = z.object({
  attempt_id: z.uuid(),
  attempt_number: z.number().int().min(1),
  input_mode: inputModeSchema,
  transcript_text: z.string(),
  score_out_of_10: z.number().int().min(0).max(10),
  stars: z.number().int().min(0).max(3),
  evaluation_source: z.enum(["AI", "FALLBACK"]).optional().default("AI"),
  provider_tier: providerTierSchema.nullish(),
  practiced_difficult_words: z.array(z.string()).optional(),
  feedback: feedbackSchema,
  created_at: z.string(),
});

const sessionSchema = z.object({
  session_id: z.uuid(),
  child_id: z.uuid(),
  child_grade: z.number().int().min(1).max(5),
  source_type: sourceTypeSchema,
  sample_key: z.string().nullable(),
  book_id: z.uuid().nullable(),
  book_page_id: z.uuid().nullable(),
  image_url: z.string(),
  scene_title: z.string(),
  status: statusSchema,
  best_stars: z.number().int().min(0).max(3),
  best_score: z.number().int().min(0).max(10),
  attempts_count: z.number().int().min(0),
  teaching_mode: teachingModeSchema.optional(),
  target_words: z.array(z.string()).optional(),
  target_vocabulary: z.array(z.string()).optional(),
  practiced_difficult_words: z.array(z.string()).optional(),
  provider_tier: providerTierSchema.nullish(),
  guide: guideSchema,
  attempts: z.array(attemptSchema),
  created_at: z.string(),
  updated_at: z.string(),
});

const sessionSummarySchema = z.object({
  session_id: z.uuid(),
  child_id: z.uuid(),
  source_type: sourceTypeSchema,
  sample_key: z.string().nullish(),
  book_page_id: z.uuid().nullish(),
  scene_title: z.string(),
  image_url: z.string(),
  status: statusSchema,
  best_stars: z.number().int().min(0).max(3),
  best_score: z.number().int().min(0).max(10),
  attempts_count: z.number().int().min(0),
  created_at: z.string(),
  updated_at: z.string(),
});

const sessionSummaryListSchema = z.array(sessionSummarySchema);

const evaluateResponseSchema = z.object({
  session: sessionSchema,
  latest_attempt: attemptSchema,
  practiced_difficult_words: z.array(z.string()).optional(),
});

export interface CreatePictureSessionInput {
  readonly child_id: string;
  readonly source_type?: PictureSourceType;
  readonly auto_select?: boolean;
  readonly sample_key?: string;
  readonly book_id?: string;
  readonly book_page_id?: string;
  readonly image_file?: File;
  readonly teaching_mode?: PictureTeachingMode;
  readonly target_words?: readonly string[];
  readonly refresh_ai_guide?: boolean;
  readonly teacher_gender?: "female" | "male";
}

export interface PictureCatalogQueryOptions {
  readonly bookId?: string;
  readonly bookPageId?: string;
}

export interface EvaluatePictureInput {
  readonly transcript_text: string;
  readonly input_mode: PictureInputMode;
  readonly teaching_mode?: PictureTeachingMode;
  readonly target_words?: readonly string[];
  readonly teacher_gender?: "female" | "male";
}

export interface PictureDescriptionService {
  getCatalog(
    childId: string,
    signal?: AbortSignal,
    options?: PictureCatalogQueryOptions,
  ): Promise<PictureCatalogDTO>;
  listSessions(
    childId: string,
    signal?: AbortSignal,
  ): Promise<PictureSessionSummaryDTO[]>;
  getSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PictureSessionDTO>;
  createSession(
    input: CreatePictureSessionInput,
    signal?: AbortSignal,
  ): Promise<PictureSessionDTO>;
  evaluate(
    sessionId: string,
    input: EvaluatePictureInput,
    signal?: AbortSignal,
  ): Promise<PictureEvaluateResponseDTO>;
}

const STANDARD_DEADLINE_MS = 20_000;
const AI_DEADLINE_MS = 45_000;

async function withPictureDeadline<T>(
  operation: (requestSignal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  try {
    return await withRequestDeadline(operation, signal, timeoutMs);
  } catch (error) {
    if (
      !signal?.aborted &&
      error instanceof DOMException &&
      error.name === "TimeoutError"
    ) {
      throw new ServiceError({
        code: "NETWORK_ERROR",
        message: adaptTextToTeacherPersona(
          translateRuntime("entertainment.pictureDescription.aiTimeoutError"),
          getEffectiveTeacherPersona().gender,
        ),
        status: 504,
        request_id: "",
        retryable: true,
      });
    }
    throw error;
  }
}

export function createPictureDescriptionService(): PictureDescriptionService {
  return {
    getCatalog(childId, signal, options) {
      return withPictureDeadline(
        (requestSignal) =>
          requestApi(
            `/games/picture-description/catalog${apiQuery({
              child_id: childId,
              book_id: options?.bookId,
              book_page_id: options?.bookPageId,
            })}`,
            catalogSchema,
            requestSignal,
          ),
        signal,
        STANDARD_DEADLINE_MS,
      );
    },

    listSessions(childId, signal) {
      return withPictureDeadline(
        (requestSignal) =>
          requestApi(
            `/games/picture-description/sessions${apiQuery({ child_id: childId })}`,
            sessionSummaryListSchema,
            requestSignal,
          ),
        signal,
        STANDARD_DEADLINE_MS,
      );
    },

    getSession(sessionId, signal) {
      return withPictureDeadline(
        (requestSignal) =>
          requestApi(
            `/games/picture-description/sessions/${encodeURIComponent(sessionId)}`,
            sessionSchema,
            requestSignal,
          ),
        signal,
        STANDARD_DEADLINE_MS,
      );
    },

    createSession(input, signal) {
      const form = new FormData();
      form.append("child_id", input.child_id);
      if (input.source_type) {
        form.append("source_type", input.source_type);
      }
      if (input.auto_select) {
        form.append("auto_select", "true");
      }
      if (input.sample_key) {
        form.append("sample_key", input.sample_key);
      }
      if (input.book_id) {
        form.append("book_id", input.book_id);
      }
      if (input.book_page_id) {
        form.append("book_page_id", input.book_page_id);
      }
      if (input.teaching_mode) {
        form.append("teaching_mode", input.teaching_mode);
      }
      if (input.target_words && input.target_words.length > 0) {
        form.append("target_words", JSON.stringify(input.target_words));
      }
      if (input.refresh_ai_guide) {
        form.append("refresh_ai_guide", "true");
      }
      if (input.teacher_gender) {
        form.append("teacher_gender", input.teacher_gender);
      }
      if (input.image_file) {
        form.append(
          "image",
          input.image_file,
          input.image_file.name || "picture.jpg",
        );
      }
      return withPictureDeadline(
        (requestSignal) =>
          requestApi(
            "/games/picture-description/sessions",
            sessionSchema,
            requestSignal,
            {
              method: "POST",
              body: form,
              timeoutMs: AI_DEADLINE_MS,
            },
          ),
        signal,
        AI_DEADLINE_MS,
      );
    },

    evaluate(sessionId, input, signal) {
      return withPictureDeadline(
        (requestSignal) =>
          requestApi(
            `/games/picture-description/sessions/${encodeURIComponent(sessionId)}/evaluate`,
            evaluateResponseSchema,
            requestSignal,
            {
              method: "POST",
              body: input,
              timeoutMs: AI_DEADLINE_MS,
            },
          ),
        signal,
        AI_DEADLINE_MS,
      );
    },
  };
}
