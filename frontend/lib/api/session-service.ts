import type {
  ReadingSessionDetailDTO,
  SessionHistoryResponseDTO,
} from "@/types/reading";
import { z } from "zod";
import { apiQuery, requestApi } from "@/lib/api/api-client";
import { bookDtoSchema } from "@/lib/api/book-service";
import type { BookDetailDTO } from "@/types/book";

export interface SessionHistoryQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SessionService {
  list(
    childId: string,
    query?: SessionHistoryQuery,
  ): Promise<SessionHistoryResponseDTO>;
  get(sessionId: string): Promise<ReadingSessionDetailDTO>;
  getBook(sessionId: string): Promise<BookDetailDTO>;
}

const summarySchema = z.object({
  id: z.uuid(),
  child_id: z.uuid(),
  book_id: z.uuid(),
  state: z.enum([
    "CREATED",
    "PAGE_READY",
    "LISTENING",
    "PAUSED",
    "RECONNECTING",
    "QUESTIONING",
    "FINISHED",
    "ABORTED",
  ]),
  started_at: z.iso.datetime({ offset: true }),
  ended_at: z.iso.datetime({ offset: true }).nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
});
const detailSchema = summarySchema.extend({
  selected_page_revision_ids: z.array(z.uuid()),
  reference_page_revision_ids: z.array(z.uuid()),
  events: z.array(
    z.object({
      id: z.uuid(),
      session_id: z.uuid(),
      page_id: z.uuid(),
      page_revision_id: z.uuid(),
      page_revision_word_id: z.uuid().nullable(),
      type: z.enum([
        "OMISSION",
        "REPETITION",
        "LONG_PAUSE",
        "SUBSTITUTION",
        "SELF_CORRECTION",
        "READ_EXAMPLE",
      ]),
      status: z.enum(["CANDIDATE", "CONFIRMED", "UNCERTAIN", "DISMISSED"]),
      start_ms: z.number().nonnegative(),
      end_ms: z.number().nullable(),
      confidence: z.number().nullable(),
      metadata: z.record(z.string(), z.unknown()),
    }),
  ),
  fluency_assessment: z
    .object({
      metrics: z.object({
        active_reading_ms: z.number().nonnegative(),
        reference_words_attempted: z.number().nonnegative(),
        confirmed_error_words: z.number().nonnegative(),
        accuracy_percent: z.number().nullable(),
        reading_wpm: z.number().nullable(),
        repetition_rate: z.number().nullable(),
        long_pause_rate: z.number().nullable(),
        mean_pause_ms: z.number().nullable(),
        median_pause_ms: z.number().nullable(),
      }),
      score: z.number().nullable(),
      uncertainty: z.number().nullable(),
      model_version: z.string(),
    })
    .nullable(),
  comprehension: z.array(
    z.object({
      question: z.object({
        id: z.uuid(),
        type: z.enum(["FACTUAL", "CLOZE", "VOCABULARY"]),
        prompt: z.string(),
        page_revision_id: z.uuid(),
        source_span: z.object({
          start_word_index: z.number().int().nonnegative(),
          end_word_index_exclusive: z.number().int().nonnegative(),
          sentence_index: z.number().int().nullable(),
        }),
        difficulty: z.number(),
        answered: z.boolean(),
      }),
      answer: z
        .object({
          answer_id: z.uuid(),
          question_id: z.uuid(),
          submitted_answer: z.string(),
          is_correct: z.boolean().nullable(),
          score: z.number().nullable(),
          feedback_code: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  report_id: z.uuid().nullable(),
});

export function createSessionService(): SessionService {
  return {
    list: (childId, query) =>
      requestApi(
        `/reading/history${apiQuery({ child_id: childId, cursor: query?.cursor, limit: query?.limit })}`,
        z.object({
          sessions: z.array(
            summarySchema.refine((session) => session.child_id === childId),
          ),
          next_cursor: z.string().nullable(),
        }),
      ),
    get: (sessionId) =>
      requestApi(
        `/reading/history/${encodeURIComponent(sessionId)}`,
        detailSchema.refine(
          (detail) =>
            detail.id === sessionId &&
            detail.events.every((event) => event.session_id === sessionId) &&
            detail.comprehension.every(
              ({ question, answer }) =>
                answer === null || answer.question_id === question.id,
            ),
        ),
      ),
    getBook: (sessionId) =>
      requestApi(
        `/reading/history/${encodeURIComponent(sessionId)}/book`,
        bookDtoSchema,
      ),
  };
}
