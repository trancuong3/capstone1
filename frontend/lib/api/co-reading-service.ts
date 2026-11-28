import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";

// ---------------------------------------------------------------------------
// Enums & primitives
// ---------------------------------------------------------------------------

const turnRoleSchema = z.enum(["NARRATOR", "CHARACTER_A", "CHARACTER_B"]);
const turnOwnerSchema = z.enum(["AI_OR_PARENT", "CHILD"]);

// ---------------------------------------------------------------------------
// Dialogue / parse-script schemas
// ---------------------------------------------------------------------------

export const dialogueTurnSchema = z.object({
  index: z.number().int().nonnegative(),
  role: turnRoleSchema,
  speaker_label: z.string(),
  text: z.string(),
  words: z.array(z.string()).default([]),
  voice_id: z.string(),
  voice_name: z.string(),
  is_character_dialogue: z.boolean(),
  turn_owner: turnOwnerSchema,
  coaching_prompt_vi: z.string().nullable().optional(),
  coaching_voice_id: z.string(),
});

export const parseScriptResponseSchema = z.object({
  child_id: z.string(),
  book_id: z.string().nullable().optional(),
  page_id: z.string().nullable().optional(),
  total_turns: z.number().int(),
  turns: z.array(dialogueTurnSchema),
  has_dialogue: z.boolean(),
  narrator_voice_id: z.string(),
  coaching_voice_id: z.string(),
  character_voices: z.record(z.string(), z.string()),
  has_parent_narration: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Narration schemas
// ---------------------------------------------------------------------------

export const wordTimingSchema = z.object({
  word: z.string(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
});

export const narrationMetaSchema = z.object({
  id: z.string(),
  parent_id: z.string(),
  book_id: z.string(),
  page_id: z.string(),
  audio_format: z.string(),
  content_type: z.string(),
  file_size_bytes: z.number().int(),
  duration_ms: z.number().int(),
  alignment_source: z.string(),
  word_timings: z.array(wordTimingSchema),
  audio_endpoint: z.string(),
  visibility: z.literal("PARENT_PRIVATE"),
  created_at: z.string(),
  updated_at: z.string(),
});

const narrationDeleteSchema = z.object({
  deleted: z.boolean(),
  narration_id: z.string(),
});

// ---------------------------------------------------------------------------
// Postcard schemas
// ---------------------------------------------------------------------------

export const postcardReadSchema = z.object({
  id: z.string(),
  parent_id: z.string(),
  child_id: z.string(),
  title: z.string(),
  passage_text: z.string(),
  source_book_id: z.string().nullable().optional(),
  source_page_id: z.string().nullable().optional(),
  has_audio_clip: z.boolean(),
  audio_format: z.string().nullable().optional(),
  audio_size_bytes: z.number().int().nullable().optional(),
  audio_endpoint: z.string().nullable().optional(),
  emoji_badge: z.string(),
  visibility: z.literal("PARENT_PRIVATE"),
  created_at: z.string(),
  updated_at: z.string(),
});

export const postcardListSchema = z.object({
  child_id: z.string(),
  total: z.number().int(),
  items: z.array(postcardReadSchema),
});

const postcardDeleteSchema = z.object({
  deleted: z.boolean(),
  postcard_id: z.string(),
});

// ---------------------------------------------------------------------------
// Exported DTO types
// ---------------------------------------------------------------------------

export type DialogueTurnDTO = z.infer<typeof dialogueTurnSchema>;
export type ParseScriptResponseDTO = z.infer<typeof parseScriptResponseSchema>;
export type NarrationMetaDTO = z.infer<typeof narrationMetaSchema>;
export type WordTimingDTO = z.infer<typeof wordTimingSchema>;
export type PostcardReadDTO = z.infer<typeof postcardReadSchema>;
export type PostcardListDTO = z.infer<typeof postcardListSchema>;

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ParseScriptPayload {
  page_text?: string;
  book_id?: string;
  page_id?: string;
  teacher_voice_id?: string;
}

export interface UploadNarrationOptions {
  pageText?: string;
  durationMs?: number;
}

export interface CreatePostcardPayload {
  title: string;
  passage_text: string;
  emoji_badge?: string;
  source_book_id?: string;
  source_page_id?: string;
  audio_clip?: File | null;
}

export interface CoReadingService {
  parseScript(
    childId: string,
    payload: ParseScriptPayload,
    signal?: AbortSignal,
  ): Promise<ParseScriptResponseDTO>;

  uploadNarration(
    bookId: string,
    pageId: string,
    audioFile: File,
    options?: UploadNarrationOptions,
    signal?: AbortSignal,
  ): Promise<NarrationMetaDTO>;

  getNarrationMeta(
    bookId: string,
    pageId: string,
    signal?: AbortSignal,
  ): Promise<NarrationMetaDTO>;

  deleteNarration(
    bookId: string,
    pageId: string,
    signal?: AbortSignal,
  ): Promise<{ deleted: boolean; narration_id: string }>;

  createPostcard(
    childId: string,
    payload: CreatePostcardPayload,
    signal?: AbortSignal,
  ): Promise<PostcardReadDTO>;

  listPostcards(
    childId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<PostcardListDTO>;

  deletePostcard(
    childId: string,
    postcardId: string,
    signal?: AbortSignal,
  ): Promise<{ deleted: boolean; postcard_id: string }>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const BASE = "/co-reading";

export function createCoReadingService(): CoReadingService {
  return {
    parseScript(childId, payload, signal) {
      return requestApi(
        `${BASE}/children/${encodeURIComponent(childId)}/parse-script`,
        parseScriptResponseSchema,
        signal,
        { method: "POST", body: payload, timeoutMs: 15_000 },
      );
    },

    uploadNarration(bookId, pageId, audioFile, options, signal) {
      const form = new FormData();
      form.append("audio_file", audioFile);
      if (options?.pageText) form.append("page_text", options.pageText);
      if (options?.durationMs != null)
        form.append("duration_ms", String(options.durationMs));
      return requestApi(
        `${BASE}/my-books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}/narration`,
        narrationMetaSchema,
        signal,
        { method: "POST", body: form, timeoutMs: 60_000 },
      );
    },

    getNarrationMeta(bookId, pageId, signal) {
      return requestApi(
        `${BASE}/my-books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}/narration`,
        narrationMetaSchema,
        signal,
        { bypassCache: true, timeoutMs: 15_000 },
      );
    },

    deleteNarration(bookId, pageId, signal) {
      return requestApi(
        `${BASE}/my-books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}/narration`,
        narrationDeleteSchema,
        signal,
        { method: "DELETE", timeoutMs: 15_000 },
      );
    },

    createPostcard(childId, payload, signal) {
      const form = new FormData();
      form.append("title", payload.title);
      form.append("passage_text", payload.passage_text);
      form.append("emoji_badge", payload.emoji_badge ?? "🌟");
      if (payload.source_book_id)
        form.append("source_book_id", payload.source_book_id);
      if (payload.source_page_id)
        form.append("source_page_id", payload.source_page_id);
      if (payload.audio_clip) form.append("audio_clip", payload.audio_clip);
      return requestApi(
        `${BASE}/children/${encodeURIComponent(childId)}/postcards`,
        postcardReadSchema,
        signal,
        { method: "POST", body: form, timeoutMs: 30_000 },
      );
    },

    listPostcards(childId, limit = 50, signal) {
      return requestApi(
        `${BASE}/children/${encodeURIComponent(childId)}/postcards${apiQuery({ limit })}`,
        postcardListSchema,
        signal,
        { bypassCache: true, timeoutMs: 15_000 },
      );
    },

    deletePostcard(childId, postcardId, signal) {
      return requestApi(
        `${BASE}/children/${encodeURIComponent(childId)}/postcards/${encodeURIComponent(postcardId)}`,
        postcardDeleteSchema,
        signal,
        { method: "DELETE", timeoutMs: 15_000 },
      );
    },
  };
}
