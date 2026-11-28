import { z } from "zod";

import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import {
  COLD_START_RETRY_DELAY_MS,
  COLD_START_RETRY_STATUSES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  cancelResponseBodyQuietly,
  delayWithSignal,
  getAbortReason,
  isAbortOrTimeoutError,
  raceWithSignal,
  resolveTimeoutMs,
} from "@/lib/api/cold-start-retry";
import { invalidateApiReadCache } from "@/lib/api/read-cache";
import { ServiceError } from "@/lib/api/service-error";
import {
  buildSpeechServiceError,
  extractSpeechProviderCode,
  isTimeoutError,
} from "@/lib/api/speech-error";
import { withRequestDeadline } from "@/lib/api/request-deadline";
import {
  DEFAULT_LOCAL_VOICE_ID,
  getActiveSessionVoiceLock,
  getEffectiveVoiceId,
  getVoicePolicyPreferences,
  hasPendingSessionVoiceSwitch,
  inferModelVersionForVoiceId,
} from "@/lib/reading/session-voice-lock";
import { getSpeechPreferences } from "@/lib/reading/speech-preferences";
import { setSynthesizedAudioMeta } from "@/lib/reading/synthesized-audio-meta";
import {
  buildTtsBrowserCacheKey,
  getCachedTimedTts,
  putCachedTimedTts,
  shouldPersistTtsCacheEntry,
  type TtsCacheScope,
} from "@/lib/reading/tts-audio-cache";
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
  readonly cacheScope?: TtsCacheScope | null;
  readonly isPrivateBook?: boolean;
  readonly bypassSessionLock?: boolean;
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
  /** Explicitly resynchronizes a paused session's server-side voice lock. */
  updateSessionVoiceLock?(input: {
    readonly sessionId: string;
    readonly voiceId: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
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

async function accessToken(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }
  try {
    return await getBrowserAccessToken({
      signal,
      onUnauthorized: () => failure(401),
    });
  } catch (error) {
    if (signal?.aborted || isAbortOrTimeoutError(error)) {
      throw error;
    }
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
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<{ readonly payload: unknown; readonly headers: Headers }> {
  const effectiveTimeoutMs = resolveTimeoutMs(
    timeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const deadlineAt = Date.now() + effectiveTimeoutMs;
  const method = (init.method ?? "GET").toUpperCase();
  const canColdStartRetry = method === "GET";
  const maxAttempts = canColdStartRetry ? 2 : 1;

  try {
    return await withRequestDeadline(
      async (requestSignal) => {
        const token = await accessToken(requestSignal);
        requestSignal.throwIfAborted();
        const requestHeaders = new Headers(init.headers);
        let response!: Response;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          requestSignal.throwIfAborted();
          try {
            response = await raceWithSignal(
              fetch(`${getApiBaseUrl()}${path}`, {
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
              }),
              requestSignal,
            );
          } catch (error) {
            if (requestSignal.aborted || isAbortOrTimeoutError(error)) {
              throw error;
            }
            if (
              attempt === 0 &&
              canColdStartRetry &&
              deadlineAt - Date.now() > COLD_START_RETRY_DELAY_MS
            ) {
              await delayWithSignal(COLD_START_RETRY_DELAY_MS, requestSignal);
              continue;
            }
            throw error;
          }

          if (
            attempt === 0 &&
            canColdStartRetry &&
            COLD_START_RETRY_STATUSES.has(response.status) &&
            !requestSignal.aborted
          ) {
            const providerCode = await extractSpeechProviderCode(
              response,
              requestSignal,
            );
            if (
              !providerCode &&
              deadlineAt - Date.now() > COLD_START_RETRY_DELAY_MS
            ) {
              await cancelResponseBodyQuietly(response, requestSignal);
              await delayWithSignal(COLD_START_RETRY_DELAY_MS, requestSignal);
              continue;
            }
          }
          break;
        }

        if (!response.ok) {
          if (response.status === 401) {
            invalidateBrowserTokenCache();
            invalidateApiReadCache();
          }
          const providerCode = await extractSpeechProviderCode(
            response,
            requestSignal,
          );
          await cancelResponseBodyQuietly(response, requestSignal);
          throw failure(
            response.status,
            response.status === 429 || response.status >= 500,
            response.headers.get("x-request-id") ?? "",
            providerCode,
          );
        }
        const payload: unknown = await raceWithSignal(
          response.json(),
          requestSignal,
        );
        requestSignal.throwIfAborted();
        return { payload, headers: response.headers };
      },
      signal,
      effectiveTimeoutMs,
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
      if (signal?.aborted) {
        throw getAbortReason(signal);
      }
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

    async updateSessionVoiceLock({ sessionId, voiceId, signal }) {
      const cleanSessionId = sessionId.trim();
      const cleanVoiceId = voiceId.trim();
      if (!cleanSessionId || !cleanVoiceId) return;
      const policy = getVoicePolicyPreferences();
      await request(
        "/voice/session-lock",
        {
          method: "PUT",
          body: JSON.stringify({
            session_id: cleanSessionId,
            voice_id: cleanVoiceId,
            ...(policy.providerMode !== "local_only"
              ? { provider_mode: policy.providerMode }
              : {}),
            ...(policy.allowGoogleTtsFallback
              ? { allow_google_tts: true }
              : {}),
          }),
        },
        signal,
        8_000,
      );
    },

    async synthesizeTimed(words, options = {}) {
      if (options.signal?.aborted) {
        throw getAbortReason(options.signal);
      }
      const policy = getVoicePolicyPreferences();
      const activeLock = options.bypassSessionLock
        ? null
        : getActiveSessionVoiceLock();
      const cacheScope: TtsCacheScope =
        options.cacheScope ?? (options.isPrivateBook ? "PRIVATE" : "CATALOG");
      const canUseBrowserCache =
        typeof indexedDB !== "undefined" &&
        shouldPersistTtsCacheEntry({
          scope: cacheScope,
          isPrivateBook: options.isPrivateBook,
        });
      const speechPrefs = getSpeechPreferences();
      const resolvedRequestVoiceId =
        options.voiceId ??
        activeLock?.voiceId ??
        (options.voiceId === null
          ? null
          : (speechPrefs.voiceId ??
            (policy.region !== "north" ? getEffectiveVoiceId() : null)));
      const cacheVoiceId =
        resolvedRequestVoiceId ??
        getEffectiveVoiceId() ??
        DEFAULT_LOCAL_VOICE_ID;
      const cacheModelVersion =
        activeLock && activeLock.voiceId === cacheVoiceId
          ? activeLock.modelVersion
          : inferModelVersionForVoiceId(cacheVoiceId);
      const cacheSpeed =
        options.speed ?? activeLock?.speed ?? speechPrefs.speed;
      const browserCacheKey = canUseBrowserCache
        ? buildTtsBrowserCacheKey({
            kind: "timed",
            textOrTokens: words.map((w) => w.normalize("NFC")).join(" "),
            voiceId: cacheVoiceId,
            modelVersion: cacheModelVersion,
            speed: cacheSpeed,
            format: options.audioFormat ?? "auto",
            scope: cacheScope,
          })
        : null;

      if (browserCacheKey) {
        const cached = await getCachedTimedTts(browserCacheKey);
        options.signal?.throwIfAborted();
        if (
          cached &&
          cached.audio.size > 0 &&
          cached.words.length === words.length
        ) {
          const resolvedId = cached.resolvedVoiceId ?? cacheVoiceId;
          recordTtsEngineUsage({
            provider: cached.provider || "precomputed_cache",
            fallbackUsed: false,
            fallbackReason: null,
            voiceId: resolvedId,
            voiceGender: resolveVoiceGender(resolvedId),
          });
          return {
            audio: cached.audio,
            durationSeconds: cached.durationSeconds,
            words: cached.words,
            provider: cached.provider || "precomputed_cache",
            resolvedVoiceId: resolvedId,
            region: cached.region,
            modelVersion: cached.modelVersion ?? cacheModelVersion,
            usedFallbackVoice: false,
            ...(cached.cachedSpeed !== null
              ? { cachedSpeed: cached.cachedSpeed }
              : {}),
          };
        }
      }

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
            ...(resolvedRequestVoiceId
              ? { voice_id: resolvedRequestVoiceId }
              : {}),
            ...(options.speed !== undefined
              ? { speed: options.speed }
              : activeLock
                ? { speed: activeLock.speed }
                : {}),
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
      const duration = parsed.data.duration_seconds;
      const clampedWords: WordTiming[] = [];
      let previousEnd = 0;
      for (const [index, word] of parsed.data.words.entries()) {
        if (
          word.index !== index ||
          word.start < previousEnd - 0.005 ||
          word.end < word.start ||
          word.end > duration + 0.05
        ) {
          throw failure(502);
        }
        const safeStart = Math.max(previousEnd, Math.min(duration, word.start));
        const safeEnd = Math.max(safeStart, Math.min(duration, word.end));
        clampedWords.push({ index, start: safeStart, end: safeEnd });
        previousEnd = safeEnd;
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
      const isElevenLabsTimed = timedProvider
        .toLowerCase()
        .startsWith("elevenlabs");
      const resolvedId =
        parsed.data.resolved_voice_id ??
        resolvedRequestVoiceId ??
        options.voiceId ??
        null;
      const usedFallbackVoice = Boolean(parsed.data.used_fallback_voice);
      const cachedSpeed =
        parsed.data.cached_speed ??
        parsePositiveSpeedHeader(headers.get("x-tts-cached-speed"));
      setSynthesizedAudioMeta(audio, {
        resolvedVoiceId: resolvedId,
        usedFallbackVoice,
        provider: timedProvider,
        region: parsed.data.region ?? null,
        modelVersion: parsed.data.model_version ?? null,
        cachedSpeed,
      });
      recordTtsEngineUsage({
        provider: timedProvider,
        fallbackUsed:
          usedFallbackVoice ||
          (timedProvider === "google" &&
            !resolvedRequestVoiceId?.startsWith("google_")),
        voiceId: resolvedId,
        voiceGender: resolveVoiceGender(
          isElevenLabsTimed
            ? (resolvedRequestVoiceId ?? resolvedId)
            : resolvedId,
        ),
      });
      const headerScopeRaw = headers.get("x-tts-scope")?.trim().toUpperCase();
      const effectiveScope: TtsCacheScope =
        headerScopeRaw === "PRIVATE" ||
        headerScopeRaw === "COACHING" ||
        headerScopeRaw === "CATALOG"
          ? headerScopeRaw
          : cacheScope;
      if (
        browserCacheKey &&
        !usedFallbackVoice &&
        !isElevenLabsTimed &&
        shouldPersistTtsCacheEntry({
          scope: effectiveScope,
          cacheControl: headers.get("cache-control"),
          isPrivateBook: options.isPrivateBook,
        })
      ) {
        void putCachedTimedTts({
          key: browserCacheKey,
          audio,
          durationSeconds: duration,
          words: clampedWords,
          scope: effectiveScope,
          cacheControl: headers.get("cache-control"),
          isPrivateBook: options.isPrivateBook,
          resolvedVoiceId: resolvedId,
          region: parsed.data.region ?? null,
          modelVersion: parsed.data.model_version ?? cacheModelVersion,
          provider:
            timedProvider === "local" ? "precomputed_cache" : timedProvider,
          cachedSpeed,
        });
      }
      return {
        audio,
        durationSeconds: duration,
        words: clampedWords,
        provider: timedProvider,
        resolvedVoiceId: resolvedId,
        region: parsed.data.region ?? null,
        modelVersion: parsed.data.model_version ?? null,
        usedFallbackVoice,
        ...(cachedSpeed !== null ? { cachedSpeed } : {}),
      };
    },
  };
}
