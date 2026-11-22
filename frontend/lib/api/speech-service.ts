import { z } from "zod";

import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import { withRequestDeadline } from "@/lib/api/request-deadline";
import {
  getActiveSessionVoiceLock,
  getVoicePolicyPreferences,
  type VoiceProviderMode,
} from "@/lib/reading/session-voice-lock";
import { setSynthesizedAudioMeta } from "@/lib/reading/synthesized-audio-meta";
import {
  recordSttEngineUsage,
  recordTtsEngineUsage,
} from "@/lib/reading/voice-engine-status";
import { resolveVoiceGender } from "@/lib/reading/voice-persona";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

const safeMessage =
  "Chức năng giọng nói trên máy đang chưa sẵn sàng. Ba mẹ và bé vui lòng thử lại nhé.";

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
  readonly providerMode?: VoiceProviderMode;
  readonly allowGoogleTts?: boolean;
  readonly sessionId?: string | null;
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
  readonly source?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface SpeechService {
  synthesize(text: string, options?: TextToSpeechOptions): Promise<Blob>;
  synthesizePhonics?(
    steps: readonly SynthesizePhonicsStepInput[],
    options?: TextToSpeechOptions,
  ): Promise<SynthesizedPhonicsSpeech>;
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
  let code: ServiceErrorCode = capabilityCode;
  let message = safeMessage;
  let shouldRetry = retryable;

  if (capabilityCode === "STT_UNAVAILABLE") {
    switch (providerCode) {
      case "STT_QUOTA_EXCEEDED":
        code = "STT_QUOTA_EXCEEDED";
        message =
          "Dịch vụ nhận diện dự phòng đã hết hạn mức. Ba mẹ kiểm tra lại bộ giọng nói trên máy nhé.";
        shouldRetry = false;
        break;
      case "STT_AUTH_FAILED":
      case "GOOGLE_STT_AUTH_ERROR":
        code = "STT_AUTH_FAILED";
        shouldRetry = false;
        break;
      case "STT_PERMISSION_DENIED":
        code = "STT_PERMISSION_DENIED";
        shouldRetry = false;
        break;
      case "STT_TERMS_NOT_ACCEPTED":
        code = "STT_TERMS_NOT_ACCEPTED";
        shouldRetry = false;
        break;
      case "STT_CONCURRENCY_LIMITED":
      case "LOCAL_STT_BUSY":
        code = "STT_CONCURRENCY_LIMITED";
        message =
          "Bộ nhận diện giọng nói trên máy đang bận. Bé thử lại sau ít giây nhé.";
        shouldRetry = true;
        break;
      case "STT_TEMPORARILY_UNAVAILABLE":
      case "LOCAL_STT_UNAVAILABLE":
      case "GOOGLE_STT_UNAVAILABLE":
        code = "STT_TEMPORARILY_UNAVAILABLE";
        message =
          "Bộ nhận diện giọng nói trên máy chưa bật hoặc đang khởi động. Ba mẹ kiểm tra dịch vụ giọng nói local rồi bấm Thử lại nhé.";
        shouldRetry = true;
        break;
      case "STT_TIMEOUT":
      case "LOCAL_STT_TIMEOUT":
      case "GOOGLE_STT_TIMEOUT":
        code = "STT_TIMEOUT";
        shouldRetry = true;
        break;
      case "STT_NETWORK_ERROR":
        code = "STT_NETWORK_ERROR";
        shouldRetry = true;
        break;
      case "STT_RATE_LIMITED":
      case "GOOGLE_STT_COOLDOWN":
        code = "STT_RATE_LIMITED";
        shouldRetry = true;
        break;
      case "STT_INVALID_AUDIO":
      case "INVALID_AUDIO":
        code = "STT_INVALID_AUDIO";
        shouldRetry = false;
        break;
      case "STT_PROVIDER_REJECTED":
      case "GOOGLE_STT_REJECTED":
        code = "STT_PROVIDER_REJECTED";
        shouldRetry = false;
        break;
      default:
        if (status === 401) code = "AUTH_REQUIRED";
        if (status === 403) code = "FORBIDDEN";
        if (status === 422) code = "VALIDATION_ERROR";
    }
  } else {
    if (status === 401) code = "AUTH_REQUIRED";
    if (status === 403) code = "FORBIDDEN";
    if (status === 422) code = "VALIDATION_ERROR";
  }

  return new ServiceError({
    code,
    message,
    status,
    request_id: requestId,
    retryable: shouldRetry,
  });
}

async function accessToken(
  capabilityCode: "STT_UNAVAILABLE" | "TTS_UNAVAILABLE",
) {
  try {
    const supabase = createBrowserSupabaseClient();
    const { error: initializationError } = await supabase.auth.initialize();
    if (initializationError) throw failure(capabilityCode, 401);

    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token)
      throw failure(capabilityCode, 401);
    return data.session.access_token;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw failure(capabilityCode, 401);
  }
}

async function speechRequest(
  path:
    | "/voice/text-to-speech"
    | "/voice/text-to-speech/phonics"
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
      let providerCode: string | undefined;
      try {
        const payload: unknown = await response.clone().json();
        if (
          typeof payload === "object" &&
          payload !== null &&
          "detail" in payload &&
          typeof payload.detail === "object" &&
          payload.detail !== null &&
          "code" in payload.detail &&
          typeof payload.detail.code === "string"
        ) {
          providerCode = payload.detail.code;
        }
      } catch {
        // Non-JSON provider responses remain a generic safe service error.
      }
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
      const activeLock = getActiveSessionVoiceLock();
      const sessionId = options.sessionId ?? activeLock?.sessionId ?? null;

      return withRequestDeadline(
        async (signal) => {
          const response = await speechRequest(
            "/voice/text-to-speech",
            "TTS_UNAVAILABLE",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: normalizedText,
                ...(options.voiceId ? { voice_id: options.voiceId } : {}),
                ...(options.speed !== undefined
                  ? { speed: options.speed }
                  : {}),
                ...(options.wordSample ? { word_sample: true } : {}),
                ...(mode !== "local_only" ? { provider_mode: mode } : {}),
                ...(allowGoogleTts ? { allow_google_tts: true } : {}),
                ...(sessionId ? { session_id: sessionId } : {}),
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
          const provider =
            response.headers.get("x-voice-provider")?.trim() || "local";
          const fallbackReason =
            response.headers.get("x-voice-fallback-reason")?.trim() || null;
          const voiceGender = resolveVoiceGender(
            resolvedVoiceId ?? options.voiceId,
            response.headers.get("x-voice-gender"),
          );
          setSynthesizedAudioMeta(audio, {
            resolvedVoiceId,
            usedFallbackVoice,
            provider,
            region: response.headers.get("x-voice-region")?.trim() || null,
            modelVersion:
              response.headers.get("x-voice-model-version")?.trim() || null,
          });
          recordTtsEngineUsage({
            provider,
            fallbackUsed: usedFallbackVoice,
            fallbackReason,
            voiceId: resolvedVoiceId ?? options.voiceId ?? null,
            voiceGender,
          });
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
      const activeLock = getActiveSessionVoiceLock();
      const sessionId = options.sessionId ?? activeLock?.sessionId ?? null;

      return withRequestDeadline(
        async (signal) => {
          const response = await speechRequest(
            "/voice/text-to-speech/phonics",
            "TTS_UNAVAILABLE",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
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
                ...(mode !== "local_only" ? { provider_mode: mode } : {}),
                ...(allowGoogleTts ? { allow_google_tts: true } : {}),
                ...(sessionId ? { session_id: sessionId } : {}),
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
            phonicsProvider === "google" ||
            (Boolean(options.voiceId) &&
              parsed.data.resolved_voice_id !== options.voiceId);
          setSynthesizedAudioMeta(audio, {
            resolvedVoiceId: parsed.data.resolved_voice_id,
            usedFallbackVoice: phonicsUsedFallback,
            provider: phonicsProvider,
            region: parsed.data.region ?? "north",
            modelVersion: parsed.data.model_version,
          });
          recordTtsEngineUsage({
            provider: phonicsProvider,
            fallbackUsed: phonicsUsedFallback,
            voiceId: parsed.data.resolved_voice_id,
            voiceGender: resolveVoiceGender(parsed.data.resolved_voice_id),
          });
          return {
            audio,
            durationSeconds: parsed.data.duration_seconds,
            stepTimings: parsed.data.step_timings,
            provider: parsed.data.provider ?? "local",
            resolvedVoiceId: parsed.data.resolved_voice_id,
            region: parsed.data.region ?? "north",
            modelVersion: parsed.data.model_version,
          };
        },
        options.signal,
        options.timeoutMs ?? 30_000,
      );
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
              text: parsed.data.text,
              language_code: parsed.data.language_code ?? null,
              language_probability: parsed.data.language_probability ?? null,
              words: parsed.data.words ?? null,
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
