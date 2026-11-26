import { z } from "zod";

import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import { ServiceError } from "@/lib/api/service-error";
import {
  buildSpeechServiceError,
  extractSpeechProviderCode,
  isTimeoutError,
} from "@/lib/api/speech-error";
import { withRequestDeadline } from "@/lib/api/request-deadline";
import {
  getActiveSessionVoiceLock,
  getVoicePolicyPreferences,
  hasPendingSessionVoiceSwitch,
} from "@/lib/reading/session-voice-lock";
import {
  getPreferredJsonTtsAcceptHeader,
  type TtsAudioFormat,
} from "@/lib/reading/tts-audio-format";
import { recordTtsEngineUsage } from "@/lib/reading/voice-engine-status";
import { resolveVoiceGender } from "@/lib/reading/voice-persona";
import { getApiBaseUrl } from "@/lib/supabase/config";

const voiceSchema = z.object({
  voice_id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  region_label: z.string().nullable().optional(),
  model_version: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  gender: z.string().nullable().optional(),
  accent: z.string().nullable().optional(),
  age: z.string().nullable().optional(),
  use_case: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  preview_url: z.string().nullable().optional(),
  is_default: z.boolean().optional(),
});

const voiceListSchema = z.object({
  voices: z.array(voiceSchema),
  default_voice_id: z.string(),
  local_worker_ready: z.boolean().optional(),
  google_tts_available: z.boolean().optional(),
  cached_voice_ids: z.array(z.string()).optional(),
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
  provider: z.string().optional(),
  resolved_voice_id: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  model_version: z.string().nullable().optional(),
  used_fallback_voice: z.boolean().optional(),
  cached_speed: z.number().positive().nullable().optional(),
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
  readonly provider?: string;
  readonly resolvedVoiceId?: string | null;
  readonly region?: string | null;
  readonly modelVersion?: string | null;
  readonly usedFallbackVoice?: boolean;
  readonly cachedSpeed?: number | null;
}

export interface TimedSpeechOptions {
  readonly voiceId?: string | null;
  readonly speed?: number;
  readonly audioFormat?: TtsAudioFormat;
  readonly bookId?: string | null;
  readonly pageId?: string | null;
  readonly pageRevisionId?: string | null;
  readonly cacheScope?: "CATALOG" | "PRIVATE" | "COACHING" | null;
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

function failure(
  status: number,
  retryable = false,
  requestId = "",
  providerCode?: string,
): ServiceError {
  return buildSpeechServiceError({
    capability: "TTS_UNAVAILABLE",
    status,
    requestId,
    retryable,
    providerCode,
  });
}

async function accessToken(): Promise<string> {
  try {
    return await getBrowserAccessToken({
      onUnauthorized: () => failure(401),
    });
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw failure(401);
  }
}

function parsePositiveSpeedHeader(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function requestWithHeaders(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<{ readonly payload: unknown; readonly headers: Headers }> {
  try {
    return await withRequestDeadline(
      async (requestSignal) => {
        const token = await accessToken();
        requestSignal.throwIfAborted();
        const requestHeaders = new Headers(init.headers);
        const response = await fetch(`${getApiBaseUrl()}${path}`, {
          ...init,
          headers: {
            Accept: requestHeaders.get("Accept") ?? "application/json",
            Authorization: `Bearer ${token}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: requestSignal,
        });
        if (!response.ok) {
          if (response.status === 401) {
            invalidateBrowserTokenCache();
          }
          const providerCode = await extractSpeechProviderCode(response);
          throw failure(
            response.status,
            response.status === 429 || response.status >= 500,
            response.headers.get("x-request-id") ?? "",
            providerCode,
          );
        }
        const payload: unknown = await response.json();
        requestSignal.throwIfAborted();
        return { payload, headers: response.headers };
      },
      signal,
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof ServiceError || signal?.aborted) throw error;
    if (isTimeoutError(error)) {
      throw failure(504, true, "", "LOCAL_TTS_TIMEOUT");
    }
    throw failure(0, true);
  }
}

async function request(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<unknown> {
  const { payload } = await requestWithHeaders(path, init, signal, timeoutMs);
  return payload;
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
      const policy = getVoicePolicyPreferences();
      const query =
        policy.providerMode === "local_with_google_fallback" &&
        policy.allowGoogleTtsFallback
          ? "?provider_mode=local_with_google_fallback&allow_google_tts=true"
          : "";
      const payload = await request(
        `/voice/voices${query}`,
        { method: "GET" },
        signal,
        15_000,
      );
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
      const policy = getVoicePolicyPreferences();
      const activeLock = getActiveSessionVoiceLock();
      const { payload, headers } = await requestWithHeaders(
        "/voice/text-to-speech/timed",
        {
          method: "POST",
          headers: {
            Accept: getPreferredJsonTtsAcceptHeader(options.audioFormat),
            ...(hasPendingSessionVoiceSwitch(activeLock?.sessionId)
              ? { "X-Voice-Lock-Update": "1" }
              : {}),
          },
          body: JSON.stringify({
            words,
            ...(options.voiceId ? { voice_id: options.voiceId } : {}),
            ...(options.speed !== undefined ? { speed: options.speed } : {}),
            ...(options.audioFormat
              ? { audio_format: options.audioFormat }
              : {}),
            ...(policy.providerMode !== "local_only"
              ? { provider_mode: policy.providerMode }
              : {}),
            ...(policy.allowGoogleTtsFallback
              ? { allow_google_tts: true }
              : {}),
            ...(activeLock?.sessionId
              ? { session_id: activeLock.sessionId }
              : {}),
            ...(options.bookId ? { book_id: options.bookId } : {}),
            ...(options.pageId ? { page_id: options.pageId } : {}),
            ...(options.pageRevisionId
              ? { page_revision_id: options.pageRevisionId }
              : {}),
            ...(options.cacheScope ? { cache_scope: options.cacheScope } : {}),
          }),
        },
        options.signal,
        options.timeoutMs,
      );
      const parsed = timedSpeechSchema.safeParse(payload);
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
      const timedProvider = parsed.data.provider ?? "local";
      const resolvedId =
        parsed.data.resolved_voice_id ?? options.voiceId ?? null;
      const cachedSpeed =
        parsed.data.cached_speed ??
        parsePositiveSpeedHeader(headers.get("x-tts-cached-speed"));
      recordTtsEngineUsage({
        provider: timedProvider,
        fallbackUsed:
          Boolean(parsed.data.used_fallback_voice) ||
          timedProvider === "google",
        voiceId: resolvedId,
        voiceGender: resolveVoiceGender(resolvedId),
      });
      return {
        audio,
        durationSeconds: parsed.data.duration_seconds,
        words: parsed.data.words,
        provider: parsed.data.provider ?? "local",
        resolvedVoiceId: parsed.data.resolved_voice_id ?? null,
        region: parsed.data.region ?? null,
        modelVersion: parsed.data.model_version ?? null,
        usedFallbackVoice: Boolean(parsed.data.used_fallback_voice),
        ...(cachedSpeed !== null ? { cachedSpeed } : {}),
      };
    },
  };
}
