import { z } from "zod";

import { ServiceError } from "@/lib/api/service-error";
import { withRequestDeadline } from "@/lib/api/request-deadline";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

const safeMessage =
  "Chức năng giọng nói đang chưa sẵn sàng. Vui lòng thử lại sau.";

const voiceSchema = z.object({
  voice_id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().nullable().optional(),
  gender: z.string().nullable().optional(),
  accent: z.string().nullable().optional(),
  age: z.string().nullable().optional(),
  use_case: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  preview_url: z.string().nullable().optional(),
});

const voiceListSchema = z.object({
  voices: z.array(voiceSchema),
  default_voice_id: z.string(),
});

const timedSpeechSchema = z.object({
  audio_base64: z.string().min(1),
  content_type: z.string().startsWith("audio/"),
  duration_seconds: z.number().positive(),
  words: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      start: z.number().nonnegative(),
      end: z.number().nonnegative(),
    }),
  ),
});

export type VoiceOption = z.infer<typeof voiceSchema>;
export type VoiceList = z.infer<typeof voiceListSchema>;

export interface WordTiming {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export interface TimedSpeech {
  readonly audio: Blob;
  readonly durationSeconds: number;
  readonly words: readonly WordTiming[];
}

export interface TimedSpeechOptions {
  readonly voiceId?: string | null;
  readonly speed?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface VoiceStudioService {
  listVoices(signal?: AbortSignal): Promise<VoiceList>;
  /** Synthesizes the words in order and returns exact per-word audio times. */
  synthesizeTimed(
    words: readonly string[],
    options?: TimedSpeechOptions,
  ): Promise<TimedSpeech>;
}

function failure(status: number, retryable = false): ServiceError {
  return new ServiceError({
    code:
      status === 401
        ? "AUTH_REQUIRED"
        : status === 403
          ? "FORBIDDEN"
          : status === 422
            ? "VALIDATION_ERROR"
            : "TTS_UNAVAILABLE",
    message: safeMessage,
    status,
    request_id: "",
    retryable,
  });
}

async function accessToken(): Promise<string> {
  try {
    const supabase = createBrowserSupabaseClient();
    const { error: initializationError } = await supabase.auth.initialize();
    if (initializationError) throw failure(401);
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) throw failure(401);
    return data.session.access_token;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw failure(401);
  }
}

async function request(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<unknown> {
  try {
    return await withRequestDeadline(
      async (requestSignal) => {
        const token = await accessToken();
        requestSignal.throwIfAborted();
        const response = await fetch(`${getApiBaseUrl()}${path}`, {
          ...init,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: requestSignal,
        });
        if (!response.ok) {
          throw failure(
            response.status,
            response.status === 429 || response.status >= 500,
          );
        }
        const payload: unknown = await response.json();
        requestSignal.throwIfAborted();
        return payload;
      },
      signal,
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof ServiceError || signal?.aborted) throw error;
    throw failure(0, true);
  }
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType });
}

export function createVoiceStudioService(): VoiceStudioService {
  return {
    async listVoices(signal) {
      const payload = await request("/voice/voices", { method: "GET" }, signal);
      const parsed = voiceListSchema.safeParse(payload);
      if (!parsed.success) throw failure(502);
      const seen = new Set<string>();
      return {
        ...parsed.data,
        voices: parsed.data.voices.filter((voice) => {
          if (seen.has(voice.voice_id)) return false;
          seen.add(voice.voice_id);
          return true;
        }),
      };
    },

    async synthesizeTimed(words, options = {}) {
      const payload = await request(
        "/voice/text-to-speech/timed",
        {
          method: "POST",
          body: JSON.stringify({
            words,
            ...(options.voiceId ? { voice_id: options.voiceId } : {}),
            ...(options.speed !== undefined ? { speed: options.speed } : {}),
          }),
        },
        options.signal,
        options.timeoutMs,
      );
      const parsed = timedSpeechSchema.safeParse(payload);
      // Timings must describe every word, otherwise highlighting would drift.
      if (!parsed.success || parsed.data.words.length !== words.length) {
        throw failure(502);
      }
      let previousEnd = 0;
      for (const [index, word] of parsed.data.words.entries()) {
        if (
          word.index !== index ||
          word.start < previousEnd ||
          word.end < word.start ||
          word.end > parsed.data.duration_seconds
        ) {
          throw failure(502);
        }
        previousEnd = word.end;
      }
      let audio: Blob;
      try {
        audio = base64ToBlob(
          parsed.data.audio_base64,
          parsed.data.content_type,
        );
      } catch {
        throw failure(502);
      }
      if (!audio.size) throw failure(502);
      return {
        audio,
        durationSeconds: parsed.data.duration_seconds,
        words: parsed.data.words,
      };
    },
  };
}
