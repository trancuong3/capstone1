import { z } from "zod";

import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

const safeMessage =
  "Chức năng giọng nói đang chưa sẵn sàng. Vui lòng thử lại sau.";
const invalidAudioMessage =
  "Đoạn ghi âm không hợp lệ. Bé vui lòng đọc lại để thử lần nữa.";

const wordTimestampSchema = z.object({
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  logprob: z.number().finite().nullable().optional(),
});

const transcriptionSchema = z.object({
  text: z.string(),
  language_code: z.string().nullable().optional(),
  language_probability: z.number().nullable().optional(),
  words: z.array(wordTimestampSchema).nullable().optional(),
});

export interface WordTimestamp {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly logprob?: number | null;
}

export interface SpeechTranscript {
  readonly text: string;
  readonly language_code: string | null;
  readonly language_probability: number | null;
  readonly words: readonly WordTimestamp[] | null;
}

export interface TextToSpeechOptions {
  readonly signal?: AbortSignal;
  readonly voiceId?: string;
}

export interface SpeechToTextOptions {
  readonly filename?: string;
  readonly languageCode?: string;
  readonly signal?: AbortSignal;
}

export interface SpeechService {
  synthesize(text: string, options?: TextToSpeechOptions): Promise<Blob>;
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
  message = safeMessage,
): ServiceError {
  let code: ServiceErrorCode = capabilityCode;
  if (status === 401) code = "AUTH_REQUIRED";
  if (status === 403) code = "FORBIDDEN";
  if (status === 422) code = "VALIDATION_ERROR";
  return new ServiceError({
    code,
    message,
    status,
    request_id: requestId,
    retryable,
  });
}

async function accessToken(
  capabilityCode: "STT_UNAVAILABLE" | "TTS_UNAVAILABLE",
) {
  try {
    const { data, error } =
      await createBrowserSupabaseClient().auth.getSession();
    if (error || !data.session?.access_token)
      throw failure(capabilityCode, 401);
    return data.session.access_token;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw failure(capabilityCode, 401);
  }
}

async function speechRequest(
  path: "/voice/text-to-speech" | "/voice/speech-to-text",
  capabilityCode: "STT_UNAVAILABLE" | "TTS_UNAVAILABLE",
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const token = await accessToken(capabilityCode);
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
      let message = safeMessage;
      if (response.status === 422 && path === "/voice/speech-to-text") {
        try {
          const errorPayload: unknown = await response.clone().json();
          if (
            typeof errorPayload === "object" &&
            errorPayload !== null &&
            "detail" in errorPayload &&
            typeof errorPayload.detail === "object" &&
            errorPayload.detail !== null &&
            "code" in errorPayload.detail &&
            errorPayload.detail.code === "INVALID_AUDIO"
          ) {
            message = invalidAudioMessage;
          }
        } catch {
          // Keep a safe generic message when the error body is not valid JSON.
        }
      }
      throw failure(
        capabilityCode,
        response.status,
        response.headers.get("x-request-id") ?? "",
        response.status === 429 || response.status >= 500,
        message,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof ServiceError || signal?.aborted) throw error;
    throw failure(capabilityCode, 0, "", true);
  }
}

export function createSpeechService(): SpeechService {
  return {
    async synthesize(text, options = {}) {
      const normalizedText = text.trim();
      if (!normalizedText) throw failure("TTS_UNAVAILABLE", 422);

      const response = await speechRequest(
        "/voice/text-to-speech",
        "TTS_UNAVAILABLE",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: normalizedText,
            ...(options.voiceId ? { voice_id: options.voiceId } : {}),
          }),
        },
        options.signal,
      );
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("audio/")) {
        throw failure("TTS_UNAVAILABLE", response.status);
      }
      const audio = await response.blob();
      if (!audio.size) throw failure("TTS_UNAVAILABLE", response.status);
      return audio;
    },

    async transcribe(audio, options = {}) {
      if (!audio.size) throw failure("STT_UNAVAILABLE", 422);

      // A MIME label is metadata, not a conversion. Never invent WebM when
      // the captured Blob has no authoritative encoding information.
      const mimeType = audio.type.trim();
      const baseMimeType =
        mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      const extensionByMimeType: Readonly<Record<string, string>> = {
        "audio/webm": "webm",
        "audio/ogg": "ogg",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/mp4": "m4a",
        "audio/aac": "aac",
        "audio/flac": "flac",
      };
      const extension = extensionByMimeType[baseMimeType];
      if (!extension) throw failure("STT_UNAVAILABLE", 422);

      const filename = options.filename ?? `recording.${extension}`;
      const suppliedExtension = filename.split(".").pop()?.toLowerCase();
      if (suppliedExtension !== extension) {
        throw failure("STT_UNAVAILABLE", 422);
      }

      // Send the original bytes unchanged. The browser's MediaRecorder MIME
      // type and the filename extension must describe the same audio format.
      const form = new FormData();
      form.append("file", audio, filename);
      if (options.languageCode)
        form.append("language_code", options.languageCode);

      const response = await speechRequest(
        "/voice/speech-to-text",
        "STT_UNAVAILABLE",
        { method: "POST", body: form },
        options.signal,
      );
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw failure("STT_UNAVAILABLE", response.status);
      }
      const parsed = transcriptionSchema.safeParse(payload);
      if (!parsed.success) throw failure("STT_UNAVAILABLE", response.status);
      return {
        text: parsed.data.text,
        language_code: parsed.data.language_code ?? null,
        language_probability: parsed.data.language_probability ?? null,
        words: parsed.data.words ?? null,
      };
    },
  };
}
