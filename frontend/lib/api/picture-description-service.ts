import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import type {
  PictureCatalogDTO,
  PictureEvaluateResponseDTO,
  PictureInputMode,
  PictureSessionDTO,
  PictureSessionSummaryDTO,
  PictureSourceType,
} from "@/types/picture-description";

const sourceTypeSchema = z.enum(["BOOK_PAGE", "CUSTOM_UPLOAD", "SAMPLE"]);
const statusSchema = z.enum(["ACTIVE", "COMPLETED"]);
const inputModeSchema = z.enum(["VOICE", "TEXT"]);

const sampleSchema = z.object({
  sample_key: z.string(),
  title: z.string(),
  theme: z.string(),
  description: z.string(),
  image_url: z.string(),
});

const bookPageSchema = z.object({
  book_id: z.uuid(),
  book_title: z.string(),
  page_id: z.uuid(),
  page_number: z.number().int().min(1),
  image_url: z.string(),
});

const catalogSchema = z.object({
  samples: z.array(sampleSchema),
  book_pages: z.array(bookPageSchema),
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
});

const attemptSchema = z.object({
  attempt_id: z.uuid(),
  attempt_number: z.number().int().min(1),
  input_mode: inputModeSchema,
  transcript_text: z.string(),
  score_out_of_10: z.number().int().min(0).max(10),
  stars: z.number().int().min(0).max(3),
  evaluation_source: z.enum(["AI", "FALLBACK"]).optional().default("AI"),
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
});

export interface CreatePictureSessionInput {
  readonly child_id: string;
  readonly source_type: PictureSourceType;
  readonly sample_key?: string;
  readonly book_page_id?: string;
  readonly image_file?: File;
}

export interface EvaluatePictureInput {
  readonly transcript_text: string;
  readonly input_mode: PictureInputMode;
}

export interface PictureDescriptionService {
  getCatalog(childId: string, signal?: AbortSignal): Promise<PictureCatalogDTO>;
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

export function createPictureDescriptionService(): PictureDescriptionService {
  return {
    getCatalog(childId, signal) {
      return requestApi(
        `/games/picture-description/catalog${apiQuery({ child_id: childId })}`,
        catalogSchema,
        signal,
      );
    },

    listSessions(childId, signal) {
      return requestApi(
        `/games/picture-description/sessions${apiQuery({ child_id: childId })}`,
        sessionSummaryListSchema,
        signal,
      );
    },

    getSession(sessionId, signal) {
      return requestApi(
        `/games/picture-description/sessions/${encodeURIComponent(sessionId)}`,
        sessionSchema,
        signal,
      );
    },

    createSession(input, signal) {
      const form = new FormData();
      form.append("child_id", input.child_id);
      form.append("source_type", input.source_type);
      if (input.sample_key) {
        form.append("sample_key", input.sample_key);
      }
      if (input.book_page_id) {
        form.append("book_page_id", input.book_page_id);
      }
      if (input.image_file) {
        form.append(
          "image",
          input.image_file,
          input.image_file.name || "picture.jpg",
        );
      }
      return requestApi(
        "/games/picture-description/sessions",
        sessionSchema,
        signal,
        {
          method: "POST",
          body: form,
        },
      );
    },

    evaluate(sessionId, input, signal) {
      return requestApi(
        `/games/picture-description/sessions/${encodeURIComponent(sessionId)}/evaluate`,
        evaluateResponseSchema,
        signal,
        {
          method: "POST",
          body: input,
        },
      );
    },
  };
}
