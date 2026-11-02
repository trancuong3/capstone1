import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";
import type {
  ReadingCompletionSummaryUI,
  ReadingPageDTO,
  ReadingSessionCreateDTO,
  ReadingSessionCreateResponseDTO,
  ReadingSessionSummaryDTO,
  ReadingSessionPageProgressDTO,
  ReadingEventCreateDTO,
  ReadingEventDTO,
} from "@/types/reading";

export interface ReadingService {
  create(
    input: ReadingSessionCreateDTO,
  ): Promise<ReadingSessionCreateResponseDTO>;
  get(sessionId: string): Promise<ReadingSessionSummaryDTO>;
  getCurrentPage(sessionId: string): Promise<ReadingPageDTO>;
  getPageProgress(sessionId: string): Promise<ReadingSessionPageProgressDTO>;
  navigateToPage(
    sessionId: string,
    targetPageId: string,
  ): Promise<ReadingSessionPageProgressDTO>;
  completeCurrentPage(
    sessionId: string,
    pageId: string,
  ): Promise<ReadingSessionPageProgressDTO>;
  getCompletionSummary(sessionId: string): Promise<ReadingCompletionSummaryUI>;
  finish(sessionId: string): Promise<ReadingSessionSummaryDTO>;
  createEvent?(input: ReadingEventCreateDTO): Promise<ReadingEventDTO>;
}

const sessionCreateResponseSchema = z.object({
  Id: z.uuid(),
  State: z.literal("IN_PROGRESS"),
  SelectedPageId: z.uuid(),
  SelectedPageRevisionId: z.uuid(),
  StartedAt: z.iso.datetime({ offset: true }),
});

export const sessionPageProgressSchema = z.object({
  session_id: z.uuid(),
  persisted: z.boolean(),
  start_page_id: z.uuid(),
  end_page_id: z.uuid(),
  current_page_id: z.uuid(),
  start_page_number: z.number().int().positive(),
  end_page_number: z.number().int().positive(),
  current_page_number: z.number().int().positive(),
  current_index: z.number().int().nonnegative(),
  total_pages: z.number().int().positive(),
  completed_pages: z.number().int().nonnegative(),
  pages: z.array(
    z.object({
      page_id: z.uuid(),
      page_revision_id: z.uuid(),
      page_number: z.number().int().positive(),
      page_order: z.number().int().nonnegative(),
      status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED"]),
      started_at: z.iso.datetime({ offset: true }).nullable(),
      completed_at: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
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
  text: z.string(),
  bbox: wordBboxSchema,
  line_index: z.number().int().nonnegative().optional(),
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
  paragraph_start_line_indices: z
    .array(z.number().int().nonnegative())
    .optional(),
  indented_line_indices: z.array(z.number().int().nonnegative()).optional(),
});

const completionSummarySchema = z.object({
  duration_minutes: z.number().int().nonnegative().nullable(),
  pages_explored: z.number().int().nonnegative().nullable(),
  selected_range_pages: z.number().int().nonnegative().nullable().optional(),
  practiced_words: z.number().int().nonnegative().nullable(),
  spoken_words: z.array(z.string()).nullable().optional(),
  transcripts: z.array(z.string()).nullable().optional(),
  correct_words: z.array(z.string()).nullable().optional(),
  mispronounced_words: z.array(z.string()).nullable().optional(),
  score: z.number().min(0).max(100).nullable().optional(),
});

const readingEventResponseSchema = z.object({
  Id: z.uuid(),
  SessionId: z.uuid(),
  PageId: z.uuid(),
  PageRevisionId: z.uuid(),
  WordId: z.uuid().nullable(),
  Type: z.string(),
  StartMs: z.number().int().nonnegative(),
  EndMs: z.number().int().nonnegative().nullable(),
  Confidence: z.number().min(0).max(1).nullable(),
  Status: z.string(),
  Metadata: z.record(z.string(), z.unknown()),
  CreatedAt: z.iso.datetime({ offset: true }),
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
            end_page_id: input.end_page_id,
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

    async getPageProgress(
      sessionId: string,
    ): Promise<ReadingSessionPageProgressDTO> {
      return requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/progress`,
        sessionPageProgressSchema,
      );
    },

    async navigateToPage(
      sessionId: string,
      targetPageId: string,
    ): Promise<ReadingSessionPageProgressDTO> {
      return requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/navigate`,
        sessionPageProgressSchema,
        undefined,
        {
          method: "POST",
          body: { target_page_id: targetPageId },
        },
      );
    },

    async completeCurrentPage(
      sessionId: string,
      pageId: string,
    ): Promise<ReadingSessionPageProgressDTO> {
      return requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/pages/${encodeURIComponent(pageId)}/complete`,
        sessionPageProgressSchema,
        undefined,
        { method: "POST" },
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

    async createEvent(input: ReadingEventCreateDTO): Promise<ReadingEventDTO> {
      const event = await requestApi(
        "/reading/events",
        readingEventResponseSchema,
        undefined,
        {
          method: "POST",
          body: {
            SessionId: input.session_id,
            PageId: input.page_id,
            PageRevisionId: input.page_revision_id,
            WordId: input.word_id,
            Type: input.type,
            StartMs: input.start_ms,
            EndMs: input.end_ms,
            Confidence: input.confidence,
            Status: input.status,
            Metadata: input.metadata,
          },
        },
      );

      return {
        id: event.Id,
        session_id: event.SessionId,
        page_id: event.PageId,
        page_revision_id: event.PageRevisionId,
        page_revision_word_id: event.WordId,
        type: event.Type as ReadingEventDTO["type"],
        start_ms: event.StartMs,
        end_ms: event.EndMs,
        confidence: event.Confidence,
        status: event.Status as ReadingEventDTO["status"],
        metadata: event.Metadata,
      };
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
