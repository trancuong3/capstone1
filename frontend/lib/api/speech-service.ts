import { z } from "zod";

import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import { ServiceError } from "@/lib/api/service-error";
import {
  buildSpeechServiceError,
  extractSpeechProviderCode,
} from "@/lib/api/speech-error";
import { withRequestDeadline } from "@/lib/api/request-deadline";
import {
  DEFAULT_LOCAL_VOICE_ID,
  getActiveSessionVoiceLock,
  getVoicePolicyPreferences,
  hasPendingSessionVoiceSwitch,
  inferModelVersionForVoiceId,
  type VoiceProviderMode,
} from "@/lib/reading/session-voice-lock";
import {
  getSynthesizedAudioMeta,
  setSynthesizedAudioMeta,
} from "@/lib/reading/synthesized-audio-meta";
import {
  buildTtsBrowserCacheKey,
  getCachedPhonicsTts,
  getCachedTtsAudio,
  putCachedPhonicsTts,
  putCachedTtsAudio,
  shouldPersistTtsCacheEntry,
  type TtsCacheScope,
} from "@/lib/reading/tts-audio-cache";
import {
  getPreferredTtsAcceptHeader,
  type TtsAudioFormat,
} from "@/lib/reading/tts-audio-format";
import {
  recordSttEngineUsage,
  recordTtsEngineUsage,
} from "@/lib/reading/voice-engine-status";
import { resolveVoiceGender } from "@/lib/reading/voice-persona";
import {
  normalizeAiPhonicsResponse,
  type SupportedPhonicsLessonPlan,
} from "@/lib/reading/phonics-lesson";
import { getApiBaseUrl } from "@/lib/supabase/config";

const wordTimestampSchema = z.object({
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  type: z.string().optional(),
  logprob: z.number().nullable().optional(),
});

const transcriptionSchema = z.object({
  text: z.string(),
  language_code: z.string().nullable().optional(),
  language_probability: z.number().nullable().optional(),
  words: z.array(wordTimestampSchema).nullable().optional(),
});

const phonicsSpeechSchema = z.object({
  audio_base64: z.string().min(1),
  content_type: z.string().startsWith("audio/"),
  duration_seconds: z.number().positive(),
  step_timings: z.array(
    z.object({
      id: z.string(),
      index: z.number().int().nonnegative(),
      start: z.number().nonnegative(),
      end: z.number().nonnegative(),
    }),
  ),
  provider: z.string().optional(),
  resolved_voice_id: z.string(),
  region: z.string().optional(),
  model_version: z.string(),
  cached_speed: z.number().positive().nullable().optional(),
});

export interface WordTimestamp {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly type?: string;
  readonly logprob?: number | null;
}

export interface SpeechTranscript {
  readonly text: string;
  readonly language_code: string | null;
  readonly language_probability: number | null;
  readonly words: readonly WordTimestamp[] | null;
  readonly provider?: string | null;
  readonly fallback_used?: boolean;
}

export interface TextToSpeechOptions {
  readonly signal?: AbortSignal;
  readonly voiceId?: string;
  readonly speed?: number;
  readonly wordSample?: boolean;
  readonly audioFormat?: TtsAudioFormat;
  readonly providerMode?: VoiceProviderMode;
  readonly allowGoogleTts?: boolean;
  readonly sessionId?: string | null;
  readonly bookId?: string | null;
  readonly pageId?: string | null;
  readonly pageRevisionId?: string | null;
  readonly cacheScope?: TtsCacheScope | null;
  readonly isPrivateBook?: boolean;
  readonly bypassSessionLock?: boolean;
  readonly timeoutMs?: number;
}

export interface PhonicsStepTiming {
  readonly id: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export interface SynthesizedPhonicsSpeech {
  readonly audio: Blob;
  readonly durationSeconds: number;
  readonly stepTimings: readonly PhonicsStepTiming[];
  readonly provider: string;
  readonly resolvedVoiceId: string;
  readonly region: string;
  readonly modelVersion: string;
  readonly cachedSpeed?: number | null;
}

export interface SynthesizePhonicsStepInput {
  readonly id: string;
  readonly spokenText: string;
  readonly pauseAfterMs?: number;
}

export { getSynthesizedAudioMeta } from "@/lib/reading/synthesized-audio-meta";
export type { SynthesizedAudioMeta } from "@/lib/reading/synthesized-audio-meta";

export interface SpeechToTextOptions {
  readonly filename?: string;
  readonly languageCode?: string;
  readonly keyterms?: readonly string[];
  readonly providerMode?: VoiceProviderMode;
  readonly allowGoogleStt?: boolean;
  readonly sessionId?: string | null;
  readonly pageId?: string | null;
  readonly turnId?: string | null;
  readonly voicedDurationMs?: number | null;
  readonly source?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const phonicsAnalyzeResponseSchema = z.object({
  supported: z.boolean(),
  source: z.enum(["rules", "ai", "none"]).optional(),
  raw_text: z.string().optional(),
  clean_phrase: z.string().optional(),
  syllables: z.array(z.string()).optional(),
  focus_syllable_index: z.number().int().nonnegative().optional(),
  focus_syllable: z.string().optional(),
  focus_range_start: z.number().int().nonnegative().optional(),
  focus_range_end: z.number().int().nonnegative().optional(),
  onset: z
    .object({ written: z.string(), spoken: z.string() })
    .nullable()
    .optional(),
  rhyme: z
    .object({
      written: z.string(),
      untoned: z.string(),
      nucleus: z.string(),
      coda: z.string(),
      spoken: z.string(),
    })
    .nullable()
    .optional(),
  tone: z
    .object({
      key: z.enum(["ngang", "sac", "huyen", "hoi", "nga", "nang"]),
      label: z.string(),
      spoken: z.string().nullable(),
    })
    .nullable()
    .optional(),
  steps: z
    .array(
      z.object({
        id: z.string(),
        index: z.number().int().nonnegative(),
        kind: z.enum([
          "rhyme_build",
          "onset_blend",
          "tone_blend",
          "whole_syllable",
          "context_phrase",
        ]),
        display_text: z.string(),
        spoken_text: z.string(),
        highlight_part: z.enum([
          "rhyme",
          "onset_and_rhyme",
          "tone_and_syllable",
          "whole_syllable",
          "context",
        ]),
        highlight_start: z.number().int().nonnegative(),
        highlight_end: z.number().int().nonnegative(),
        pause_after_ms: z.number().int().positive(),
      }),
    )
    .optional(),
});

const aiPhonicsCache = new Map<string, SupportedPhonicsLessonPlan | null>();

export interface PhonicsAnalyzeOptions {
  readonly contextPhrase?: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface SpeechService {
  synthesize(text: string, options?: TextToSpeechOptions): Promise<Blob>;
  synthesizePhonics?(
    steps: readonly SynthesizePhonicsStepInput[],
    options?: TextToSpeechOptions,
  ): Promise<SynthesizedPhonicsSpeech>;
  analyzePhonics?(
    text: string,
    options?: PhonicsAnalyzeOptions,
  ): Promise<SupportedPhonicsLessonPlan | null>;
  transcribe(
    audio: Blob,
    options?: SpeechToTextOptions,
  ): Promise<SpeechTranscript>;
}

function failure(
  capabilityCode: "STT_UNAVAILABLE" | "TTS_UNAVAILABLE",
  status: number,
  requestId = "",
  retryable = false,
  providerCode?: string,
): ServiceError {
  return buildSpeechServiceError({
    capability: capabilityCode,
    status,
    requestId,
    retryable,
    providerCode,
  });
}

async function accessToken(
  capabilityCode: "STT_UNAVAILABLE" | "TTS_UNAVAILABLE",
) {
  try {
    return await getBrowserAccessToken({
      onUnauthorized: () => failure(capabilityCode, 401),
    });
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw failure(capabilityCode, 401);
  }
}

async function speechRequest(
  path:
    | "/voice/text-to-speech"
    | "/voice/text-to-speech/phonics"
    | "/voice/phonics/analyze"
    | "/voice/speech-to-text",
  capabilityCode: "STT_UNAVAILABLE" | "TTS_UNAVAILABLE",
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const token = await accessToken(capabilityCode);
  signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  headers.set("Accept", headers.get("Accept") ?? "*/*");
  headers.set("Authorization", `Bearer ${token}`);
  try {
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      if (response.status === 401) {
        invalidateBrowserTokenCache();
      }
      const providerCode = await extractSpeechProviderCode(response);
      throw failure(
        capabilityCode,
        response.status,
        response.headers.get("x-request-id") ?? "",
        response.status === 429 || response.status >= 500,
        providerCode,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof ServiceError || signal?.aborted) throw error;
    throw failure(capabilityCode, 0, "", true);
  }
}

const INVALID_KEYTERM_CHARACTERS = /[<>{}\[\]\\]/u;

function appendKeyterms(
  form: FormData,
  keyterms: readonly string[] | undefined,
): void {
  if (!keyterms?.length) return;

  const uniqueKeyterms = new Set<string>();

  for (const value of keyterms) {
    const normalized = value.normalize("NFC").trim();

    if (!normalized) continue;
    if (normalized.length > 50) continue;
    if (INVALID_KEYTERM_CHARACTERS.test(normalized)) continue;
    if (normalized.split(/\s+/u).length > 5) continue;

    uniqueKeyterms.add(normalized);

    if (uniqueKeyterms.size >= 1000) break;
  }

  for (const keyterm of uniqueKeyterms) {
    form.append("keyterms", keyterm);
  }
}

function parsePositiveSpeedHeader(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType });
}

export function createSpeechService(): SpeechService {
  return {
    async synthesize(text, options = {}) {
      const normalizedText = text.normalize("NFC").trim();
      if (!normalizedText) throw failure("TTS_UNAVAILABLE", 422);

      const policy = getVoicePolicyPreferences();
      const mode = options.providerMode ?? policy.providerMode;
      const allowGoogleTts =
        options.allowGoogleTts ?? policy.allowGoogleTtsFallback;
      const activeLock = options.bypassSessionLock
        ? null
        : getActiveSessionVoiceLock();
      const sessionId = options.bypassSessionLock
        ? null
        : (options.sessionId ?? activeLock?.sessionId ?? null);
      const cacheScope: TtsCacheScope =
        options.cacheScope ?? (options.isPrivateBook ? "PRIVATE" : "CATALOG");
      const canUseBrowserCache =
        typeof indexedDB !== "undefined" &&
        shouldPersistTtsCacheEntry({
          scope: cacheScope,
          isPrivateBook: options.isPrivateBook,
        });
      const cacheVoiceId =
        options.voiceId ?? activeLock?.voiceId ?? DEFAULT_LOCAL_VOICE_ID;
      const cacheModelVersion =
        activeLock && activeLock.voiceId === cacheVoiceId
          ? activeLock.modelVersion
          : inferModelVersionForVoiceId(cacheVoiceId);
      const browserCacheKey = canUseBrowserCache
        ? buildTtsBrowserCacheKey({
            kind: options.wordSample ? "wordSample" : "short",
            textOrTokens: normalizedText,
            voiceId: cacheVoiceId,
            modelVersion: cacheModelVersion,
            speed: options.speed ?? activeLock?.speed ?? 1,
            format: options.audioFormat ?? "auto",
            scope: cacheScope,
          })
        : null;

      if (browserCacheKey) {
        const cachedAudio = await getCachedTtsAudio(browserCacheKey);
        options.signal?.throwIfAborted();
        if (cachedAudio && cachedAudio.size > 0) {
          const voiceGender = resolveVoiceGender(cacheVoiceId, null);
          const storedCachedSpeed =
            getSynthesizedAudioMeta(cachedAudio)?.cachedSpeed ?? null;
          setSynthesizedAudioMeta(cachedAudio, {
            resolvedVoiceId: cacheVoiceId,
            usedFallbackVoice: false,
            provider: "precomputed_cache",
            region: activeLock?.region ?? null,
            modelVersion:
              activeLock?.modelVersion ??
              inferModelVersionForVoiceId(cacheVoiceId),
            cachedSpeed: storedCachedSpeed,
          });
          recordTtsEngineUsage({
            provider: "precomputed_cache",
            fallbackUsed: false,
            fallbackReason: null,
            voiceId: cacheVoiceId,
            voiceGender,
          });
          return cachedAudio;
        }
      }

      return withRequestDeadline(
        async (signal) => {
          const response = await speechRequest(
            "/voice/text-to-speech",
            "TTS_UNAVAILABLE",
            {
              method: "POST",
              headers: {
                Accept: getPreferredTtsAcceptHeader(options.audioFormat),
                "Content-Type": "application/json",
                ...(hasPendingSessionVoiceSwitch(sessionId)
                  ? { "X-Voice-Lock-Update": "1" }
                  : {}),
              },
              body: JSON.stringify({
                text: normalizedText,
                ...(options.voiceId ? { voice_id: options.voiceId } : {}),
                ...(options.speed !== undefined
                  ? { speed: options.speed }
                  : {}),
                ...(options.wordSample ? { word_sample: true } : {}),
                ...(options.audioFormat
                  ? { audio_format: options.audioFormat }
                  : {}),
                ...(mode !== "local_only" ? { provider_mode: mode } : {}),
                ...(allowGoogleTts ? { allow_google_tts: true } : {}),
                ...(sessionId ? { session_id: sessionId } : {}),
                ...(options.bookId ? { book_id: options.bookId } : {}),
                ...(options.pageId ? { page_id: options.pageId } : {}),
                ...(options.pageRevisionId
                  ? { page_revision_id: options.pageRevisionId }
                  : {}),
                ...(options.cacheScope
                  ? { cache_scope: options.cacheScope }
                  : {}),
              }),
            },
            signal,
          );
          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.toLowerCase().startsWith("audio/")) {
            throw failure("TTS_UNAVAILABLE", response.status);
          }
          const audio = await response.blob();
          signal.throwIfAborted();
          if (!audio.size) throw failure("TTS_UNAVAILABLE", response.status);
          const resolvedVoiceId =
            response.headers.get("x-resolved-voice-id")?.trim() || null;
          const usedFallbackVoice =
            response.headers.get("x-voice-fallback") === "1";
          const ttsCacheHeader =
            response.headers.get("x-tts-cache")?.trim().toUpperCase() || null;
          const headerProvider =
            response.headers.get("x-tts-provider")?.trim() ||
            response.headers.get("x-voice-provider")?.trim() ||
            "local";
          const provider =
            ttsCacheHeader === "HIT" && headerProvider === "local"
              ? "precomputed_cache"
              : headerProvider;
          const fallbackReason =
            response.headers.get("x-voice-fallback-reason")?.trim() || null;
          const voiceGender = resolveVoiceGender(
            resolvedVoiceId ?? options.voiceId,
            response.headers.get("x-voice-gender"),
          );
          const cachedSpeed = parsePositiveSpeedHeader(
            response.headers.get("x-tts-cached-speed"),
          );
          setSynthesizedAudioMeta(audio, {
            resolvedVoiceId,
            usedFallbackVoice,
            provider,
            region: response.headers.get("x-voice-region")?.trim() || null,
            modelVersion:
              response.headers.get("x-voice-model-version")?.trim() || null,
            cachedSpeed,
          });
          recordTtsEngineUsage({
            provider,
            fallbackUsed: usedFallbackVoice,
            fallbackReason,
            voiceId: resolvedVoiceId ?? options.voiceId ?? null,
            voiceGender,
          });
          const headerScopeRaw = response.headers
            .get("x-tts-scope")
            ?.trim()
            .toUpperCase();
          const effectiveScope: TtsCacheScope =
            headerScopeRaw === "PRIVATE" ||
            headerScopeRaw === "COACHING" ||
            headerScopeRaw === "CATALOG"
              ? headerScopeRaw
              : cacheScope;
          if (
            browserCacheKey &&
            !usedFallbackVoice &&
            shouldPersistTtsCacheEntry({
              scope: effectiveScope,
              cacheControl: response.headers.get("cache-control"),
              isPrivateBook: options.isPrivateBook,
            })
          ) {
            void putCachedTtsAudio({
              key: browserCacheKey,
              audio,
              scope: effectiveScope,
              cacheControl: response.headers.get("cache-control"),
              isPrivateBook: options.isPrivateBook,
              cachedSpeed,
            });
          }
          return audio;
        },
        options.signal,
        options.timeoutMs ?? 30_000,
      );
    },

    async synthesizePhonics(steps, options = {}) {
      if (!steps.length) throw failure("TTS_UNAVAILABLE", 422);

      const policy = getVoicePolicyPreferences();
      const mode = options.providerMode ?? policy.providerMode;
      const allowGoogleTts =
        options.allowGoogleTts ?? policy.allowGoogleTtsFallback;
      const activeLock = options.bypassSessionLock
        ? null
        : getActiveSessionVoiceLock();
      const sessionId = options.bypassSessionLock
        ? null
        : (options.sessionId ?? activeLock?.sessionId ?? null);
      const cacheScope: TtsCacheScope =
        options.cacheScope ?? (options.isPrivateBook ? "PRIVATE" : "COACHING");
      const canUseBrowserCache =
        typeof indexedDB !== "undefined" &&
        shouldPersistTtsCacheEntry({
          scope: cacheScope,
          isPrivateBook: options.isPrivateBook,
        });
      const cacheVoiceId =
        options.voiceId ?? activeLock?.voiceId ?? DEFAULT_LOCAL_VOICE_ID;
      const cacheModelVersion =
        activeLock && activeLock.voiceId === cacheVoiceId
          ? activeLock.modelVersion
          : inferModelVersionForVoiceId(cacheVoiceId);
      const browserCacheKey = canUseBrowserCache
        ? buildTtsBrowserCacheKey({
            kind: "phonics",
            textOrTokens: JSON.stringify(
              steps.map((s) => [
                s.id,
                s.spokenText.normalize("NFC").trim(),
                s.pauseAfterMs ?? 420,
              ]),
            ),
            voiceId: cacheVoiceId,
            modelVersion: cacheModelVersion,
            speed: options.speed ?? activeLock?.speed ?? 1,
            format: options.audioFormat ?? "auto",
            scope: cacheScope,
          })
        : null;

      if (browserCacheKey) {
        const cached = await getCachedPhonicsTts(browserCacheKey);
        options.signal?.throwIfAborted();
        if (
          cached &&
          cached.audio.size > 0 &&
          cached.stepTimings.length === steps.length
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
            stepTimings: cached.stepTimings,
            provider: cached.provider || "precomputed_cache",
            resolvedVoiceId: resolvedId,
            region: cached.region ?? activeLock?.region ?? "north",
            modelVersion: cached.modelVersion ?? cacheModelVersion,
            ...(cached.cachedSpeed !== null
              ? { cachedSpeed: cached.cachedSpeed }
              : {}),
          };
        }
      }

      return withRequestDeadline(
        async (signal) => {
          const response = await speechRequest(
            "/voice/text-to-speech/phonics",
            "TTS_UNAVAILABLE",
            {
              method: "POST",
              headers: {
                Accept: options.audioFormat
                  ? `application/json, ${getPreferredTtsAcceptHeader(options.audioFormat)}`
                  : "application/json, audio/mpeg;q=0.9, audio/wav;q=0.8",
                "Content-Type": "application/json",
                ...(hasPendingSessionVoiceSwitch(sessionId)
                  ? { "X-Voice-Lock-Update": "1" }
                  : {}),
              },
              body: JSON.stringify({
                steps: steps.map((s) => ({
                  id: s.id,
                  spoken_text: s.spokenText.normalize("NFC").trim(),
                  pause_after_ms: s.pauseAfterMs ?? 420,
                })),
                ...(options.voiceId ? { voice_id: options.voiceId } : {}),
                ...(options.speed !== undefined
                  ? { speed: options.speed }
                  : {}),
                ...(options.audioFormat
                  ? { audio_format: options.audioFormat }
                  : {}),
                ...(mode !== "local_only" ? { provider_mode: mode } : {}),
                ...(allowGoogleTts ? { allow_google_tts: true } : {}),
                ...(sessionId ? { session_id: sessionId } : {}),
                ...(options.bookId ? { book_id: options.bookId } : {}),
                ...(options.pageId ? { page_id: options.pageId } : {}),
                ...(options.pageRevisionId
                  ? { page_revision_id: options.pageRevisionId }
                  : {}),
                ...(options.cacheScope
                  ? { cache_scope: options.cacheScope }
                  : {}),
              }),
            },
            signal,
          );
          const payload: unknown = await response.json();
          signal.throwIfAborted();
          const parsed = phonicsSpeechSchema.safeParse(payload);
          if (
            !parsed.success ||
            parsed.data.step_timings.length !== steps.length
          ) {
            throw failure("TTS_UNAVAILABLE", 502);
          }
          let audio: Blob;
          try {
            audio = base64ToBlob(
              parsed.data.audio_base64,
              parsed.data.content_type,
            );
          } catch {
            throw failure("TTS_UNAVAILABLE", 502);
          }
          if (!audio.size) throw failure("TTS_UNAVAILABLE", 502);
          const phonicsProvider = parsed.data.provider ?? "local";
          const phonicsUsedFallback =
            (Boolean(options.voiceId) &&
              parsed.data.resolved_voice_id !== options.voiceId) ||
            (!options.voiceId && phonicsProvider === "google");
          const cachedSpeed =
            parsed.data.cached_speed ??
            parsePositiveSpeedHeader(
              response.headers.get("x-tts-cached-speed"),
            );
          setSynthesizedAudioMeta(audio, {
            resolvedVoiceId: parsed.data.resolved_voice_id,
            usedFallbackVoice: phonicsUsedFallback,
            provider: phonicsProvider,
            region: parsed.data.region ?? "north",
            modelVersion: parsed.data.model_version,
            cachedSpeed,
          });
          recordTtsEngineUsage({
            provider: phonicsProvider,
            fallbackUsed: phonicsUsedFallback,
            voiceId: parsed.data.resolved_voice_id,
            voiceGender: resolveVoiceGender(parsed.data.resolved_voice_id),
          });
          const headerScopeRaw = response.headers
            .get("x-tts-scope")
            ?.trim()
            .toUpperCase();
          const effectiveScope: TtsCacheScope =
            headerScopeRaw === "PRIVATE" ||
            headerScopeRaw === "COACHING" ||
            headerScopeRaw === "CATALOG"
              ? headerScopeRaw
              : cacheScope;
          if (
            browserCacheKey &&
            !phonicsUsedFallback &&
            shouldPersistTtsCacheEntry({
              scope: effectiveScope,
              cacheControl: response.headers.get("cache-control"),
              isPrivateBook: options.isPrivateBook,
            })
          ) {
            void putCachedPhonicsTts({
              key: browserCacheKey,
              audio,
              durationSeconds: parsed.data.duration_seconds,
              stepTimings: parsed.data.step_timings,
              scope: effectiveScope,
              cacheControl: response.headers.get("cache-control"),
              isPrivateBook: options.isPrivateBook,
              resolvedVoiceId: parsed.data.resolved_voice_id,
              region: parsed.data.region ?? "north",
              modelVersion: parsed.data.model_version,
              provider:
                phonicsProvider === "local"
                  ? "precomputed_cache"
                  : phonicsProvider,
              cachedSpeed,
            });
          }
          return {
            audio,
            durationSeconds: parsed.data.duration_seconds,
            stepTimings: parsed.data.step_timings,
            provider: phonicsProvider,
            resolvedVoiceId: parsed.data.resolved_voice_id,
            region: parsed.data.region ?? "north",
            modelVersion: parsed.data.model_version,
            ...(cachedSpeed !== null ? { cachedSpeed } : {}),
          };
        },
        options.signal,
        options.timeoutMs ?? 30_000,
      );
    },

    async analyzePhonics(text, options = {}) {
      const normalized = text.normalize("NFC").trim();
      if (!normalized) return null;
      const contextPhrase =
        options.contextPhrase?.normalize("NFC").trim() || null;
      const cacheKey = `${normalized.toLowerCase()}::${(contextPhrase ?? "").toLowerCase()}`;
      if (aiPhonicsCache.has(cacheKey)) {
        return aiPhonicsCache.get(cacheKey) ?? null;
      }
      try {
        const result = await withRequestDeadline(
          async (signal) => {
            const response = await speechRequest(
              "/voice/phonics/analyze",
              "TTS_UNAVAILABLE",
              {
                method: "POST",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  text: normalized,
                  ...(contextPhrase ? { context_phrase: contextPhrase } : {}),
                }),
              },
              signal,
            );
            const payload: unknown = await response.json();
            signal.throwIfAborted();
            const parsed = phonicsAnalyzeResponseSchema.safeParse(payload);
            if (!parsed.success) return null;
            return normalizeAiPhonicsResponse(parsed.data, normalized);
          },
          options.signal,
          options.timeoutMs ?? 8_000,
        );
        if (aiPhonicsCache.size >= 256) {
          const firstKey = aiPhonicsCache.keys().next().value;
          if (firstKey !== undefined) aiPhonicsCache.delete(firstKey);
        }
        aiPhonicsCache.set(cacheKey, result);
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return null;
      }
    },

    async transcribe(audio, options = {}) {
      if (!audio.size || audio.size > 20 * 1024 * 1024)
        throw failure("STT_UNAVAILABLE", 422, "", false, "STT_INVALID_AUDIO");

      const mimeType = audio.type || "audio/webm";
      const fileBlob = audio.type
        ? audio
        : new Blob([audio], { type: mimeType });
      const filename =
        options.filename ??
        (mimeType.includes("ogg")
          ? "recording.ogg"
          : mimeType.includes("mp4")
            ? "recording.mp4"
            : mimeType.includes("wav")
              ? "recording.wav"
              : "recording.webm");

      const policy = getVoicePolicyPreferences();
      const mode = options.providerMode ?? policy.providerMode;
      const allowGoogleStt =
        options.allowGoogleStt ?? policy.allowGoogleSttFallback;
      const activeLock = getActiveSessionVoiceLock();
      const sessionId = options.sessionId ?? activeLock?.sessionId ?? null;

      const form = new FormData();
      form.append("file", fileBlob, filename);

      if (options.languageCode) {
        form.append("language_code", options.languageCode);
      }
      if (mode !== "local_only") {
        form.append("provider_mode", mode);
      }
      if (allowGoogleStt) {
        form.append("allow_google_stt", "true");
      }
      if (sessionId) {
        form.append("session_id", sessionId);
      }
      if (options.pageId) {
        form.append("page_id", options.pageId);
      }
      if (options.turnId) {
        form.append("turn_id", options.turnId);
      }
      if (
        typeof options.voicedDurationMs === "number" &&
        Number.isFinite(options.voicedDurationMs) &&
        options.voicedDurationMs >= 0
      ) {
        form.append(
          "voiced_duration_ms",
          String(Math.round(options.voicedDurationMs)),
        );
      }
      if (options.source) {
        form.append("source", options.source);
      }

      appendKeyterms(form, options.keyterms);

      const controller = new AbortController();
      const abort = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new DOMException("Transcription timed out", "TimeoutError"),
        );
      }, options.timeoutMs ?? 30_000);
      const interrupted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
      });
      try {
        controller.signal.throwIfAborted();
        return await Promise.race([
          interrupted,
          (async () => {
            const response = await speechRequest(
              "/voice/speech-to-text",
              "STT_UNAVAILABLE",
              { method: "POST", body: form },
              controller.signal,
            );
            const payload: unknown = await response.json();
            controller.signal.throwIfAborted();
            const parsed = transcriptionSchema.safeParse(payload);
            if (!parsed.success)
              throw failure("STT_UNAVAILABLE", response.status);
            const providerHeader =
              response.headers.get("x-voice-provider")?.trim() || null;
            const fallbackUsed =
              response.headers.get("x-voice-fallback") === "1";
            const fallbackReason =
              response.headers.get("x-voice-fallback-reason")?.trim() || null;
            recordSttEngineUsage({
              provider: providerHeader ?? "local",
              fallbackUsed,
              fallbackReason,
            });
            return {
              text: parsed.data.text.normalize("NFC"),
              language_code: parsed.data.language_code ?? null,
              language_probability: parsed.data.language_probability ?? null,
              words: parsed.data.words
                ? parsed.data.words.map((w) => ({
                    ...w,
                    text: w.text.normalize("NFC"),
                  }))
                : null,
              ...(providerHeader ? { provider: providerHeader } : {}),
              ...(fallbackUsed ? { fallback_used: true } : {}),
            };
          })(),
        ]);
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (timedOut)
          throw failure("STT_UNAVAILABLE", 408, "", true, "STT_TIMEOUT");
        if (error instanceof ServiceError) throw error;
        throw failure("STT_UNAVAILABLE", 0, "", true, "STT_NETWORK_ERROR");
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      }
    },
  };
}
