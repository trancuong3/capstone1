import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";
import type {
  ReadingCompletionSummaryUI,
  ReadingPageDTO,
  ReadingSessionCreateDTO,
  ReadingSessionCreateResponseDTO,
  ReadingSessionSummaryDTO,
} from "@/types/reading";

export interface ReadingService {
  create(
    input: ReadingSessionCreateDTO,
  ): Promise<ReadingSessionCreateResponseDTO>;
  get(sessionId: string): Promise<ReadingSessionSummaryDTO>;
  getCurrentPage(sessionId: string): Promise<ReadingPageDTO>;
  getCompletionSummary(sessionId: string): Promise<ReadingCompletionSummaryUI>;
  finish(sessionId: string): Promise<ReadingSessionSummaryDTO>;
}

const sessionCreateResponseSchema = z.object({
  Id: z.uuid(),
  State: z.literal("IN_PROGRESS"),
  SelectedPageId: z.uuid(),
  SelectedPageRevisionId: z.uuid(),
  StartedAt: z.iso.datetime({ offset: true }),
});

const sessionSummarySchema = z.object({
  id: z.guid(),
  child_id: z.guid(),
  book_id: z.guid(),
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
  started_at: z.string(),
  ended_at: z.string().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
});

const wordBboxSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);

const wordDtoSchema = z.object({
  word_id: z.guid(),
  word_index: z.number().int(),
  line_index: z.number().int().nonnegative().optional(),
  text: z.string(),
  bbox: wordBboxSchema,
});

export const readingPageDtoSchema = z.object({
  page_id: z.guid(),
  page_revision_id: z.guid(),
  page_number: z.number().int(),
  confidence: z.number().min(0).max(1).nullable(),
  width: z.number(),
  height: z.number(),
  image_url: z.string().nullable().optional(),
  text: z.string().optional(),
  words: z.array(wordDtoSchema),
});

const completionSummarySchema = z.object({
  duration_minutes: z.number().int().nonnegative().nullable(),
  pages_explored: z.number().int().nonnegative().nullable(),
  practiced_words: z.number().int().nonnegative().nullable(),
  spoken_words: z.array(z.string()).nullable(),
  transcripts: z.array(z.string()).nullable(),
});

export function createReadingService(): ReadingService {
  return {
    async create(
      input: ReadingSessionCreateDTO,
    ): Promise<ReadingSessionCreateResponseDTO> {
      const response = await requestApi(
        "/reading/sessions",
        sessionCreateResponseSchema,
        undefined,
        {
          method: "POST",
          body: {
            child_id: input.child_id,
            book_id: input.book_id,
            mode: input.mode,
            state: "CREATED",
            selected_page_id: input.selected_page_id,
            selected_page_revision_id: input.selected_page_revision_id,
          },
        },
      );
      return {
        session_id: response.Id,
        state: "PAGE_READY",
        selected_page_id: response.SelectedPageId,
        selected_page_revision_id: response.SelectedPageRevisionId,
        started_at: response.StartedAt,
      };
    },

    async get(sessionId: string): Promise<ReadingSessionSummaryDTO> {
      const summary = await requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}`,
        sessionSummarySchema,
      );
      return {
        id: summary.id,
        child_id: summary.child_id,
        book_id: summary.book_id,
        state: summary.state,
        started_at: summary.started_at,
        ended_at: summary.ended_at ?? null,
        duration_ms: summary.duration_ms ?? null,
      };
    },

    async getCurrentPage(sessionId: string): Promise<ReadingPageDTO> {
      return requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/page`,
        readingPageDtoSchema,
      );
    },

    async getCompletionSummary(
      sessionId: string,
    ): Promise<ReadingCompletionSummaryUI> {
      return requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/completion-summary`,
        completionSummarySchema,
      );
    },

    async finish(sessionId: string): Promise<ReadingSessionSummaryDTO> {
      const summary = await requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/finish`,
        sessionSummarySchema,
        undefined,
        { method: "POST" },
      );
      return {
        id: summary.id,
        child_id: summary.child_id,
        book_id: summary.book_id,
        state: summary.state,
        started_at: summary.started_at,
        ended_at: summary.ended_at ?? null,
        duration_ms: summary.duration_ms ?? null,
      };
    },
  };
}
