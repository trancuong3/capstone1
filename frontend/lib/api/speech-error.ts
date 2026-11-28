import { getAbortReason, raceWithSignal } from "@/lib/api/cold-start-retry";
import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import { translateMessage } from "@/lib/i18n/formatter";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import { readLocaleCookie } from "@/lib/i18n/persistence";
import type { MessagesDictionary, TranslationParams } from "@/lib/i18n/types";
import { getCachedLocaleMessages } from "@/messages/loader";
import { viMessages } from "@/messages/vi";

export type SpeechCapability = "STT_UNAVAILABLE" | "TTS_UNAVAILABLE";

function resolveRuntimeLocale(): SupportedLocale {
  const cookieLocale = readLocaleCookie();
  if (cookieLocale) return cookieLocale;
  if (typeof document !== "undefined") {
    return normalizeLocale(document.documentElement?.lang) ?? DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

function tSpeechError(key: string, params?: TranslationParams): string {
  const locale = resolveRuntimeLocale();
  const activeMessages: MessagesDictionary =
    getCachedLocaleMessages(locale) ?? viMessages;
  return translateMessage(activeMessages, viMessages, locale, key, params);
}

export function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "TimeoutError"
  );
}

export async function extractSpeechProviderCode(
  response: Response,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }
  try {
    const jsonPromise = response.clone().json();
    const payload: unknown = signal
      ? await raceWithSignal(jsonPromise, signal)
      : await jsonPromise;
    if (typeof payload !== "object" || payload === null) {
      return undefined;
    }
    if (
      "detail" in payload &&
      typeof payload.detail === "object" &&
      payload.detail !== null &&
      "code" in payload.detail &&
      typeof payload.detail.code === "string"
    ) {
      return payload.detail.code;
    }
    if ("code" in payload && typeof payload.code === "string") {
      return payload.code;
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // Non-JSON error bodies must not be reflected to the UI.
  }
  return undefined;
}

function appendRequestCorrelation(message: string, requestId: string): string {
  const trimmed = requestId.trim();
  if (!trimmed || message.includes(trimmed)) {
    return message;
  }
  return tSpeechError("errors.requestWithId", { message, requestId: trimmed });
}

export function buildSpeechServiceError(params: {
  capability: SpeechCapability;
  status: number;
  requestId?: string;
  retryable?: boolean;
  providerCode?: string;
}): ServiceError {
  const { capability, status, requestId = "", providerCode } = params;
  let code: ServiceErrorCode = capability;
  let message = tSpeechError("errors.speech.defaultUnavailable");
  let retryable =
    params.retryable ?? (status === 0 || status === 429 || status >= 500);

  if (capability === "STT_UNAVAILABLE") {
    switch (providerCode) {
      case "STT_QUOTA_EXCEEDED":
      case "GOOGLE_STT_QUOTA_EXCEEDED":
        code = "STT_QUOTA_EXCEEDED";
        message = tSpeechError("errors.speech.sttQuotaExceeded");
        retryable = false;
        break;
      case "STT_AUTH_FAILED":
      case "GOOGLE_STT_AUTH_ERROR":
        code = "STT_AUTH_FAILED";
        message = tSpeechError("errors.speech.sttAuthFailed");
        retryable = false;
        break;
      case "STT_PERMISSION_DENIED":
        code = "STT_PERMISSION_DENIED";
        message = tSpeechError("errors.speech.sttPermissionDenied");
        retryable = false;
        break;
      case "STT_TERMS_NOT_ACCEPTED":
        code = "STT_TERMS_NOT_ACCEPTED";
        message = tSpeechError("errors.speech.sttTermsNotAccepted");
        retryable = false;
        break;
      case "STT_CONCURRENCY_LIMITED":
      case "LOCAL_STT_BUSY":
        code = "STT_CONCURRENCY_LIMITED";
        message = tSpeechError("errors.speech.sttBusy");
        retryable = true;
        break;
      case "LOCAL_VOICE_UNCONFIGURED":
        code = "STT_TEMPORARILY_UNAVAILABLE";
        message = tSpeechError("errors.speech.sttLocalUnconfigured");
        retryable = true;
        break;
      case "STT_TEMPORARILY_UNAVAILABLE":
      case "LOCAL_STT_UNAVAILABLE":
        code = "STT_TEMPORARILY_UNAVAILABLE";
        message = tSpeechError("errors.speech.sttTemporarilyUnavailable");
        retryable = true;
        break;
      case "GOOGLE_STT_UNCONFIGURED":
        code = "STT_TEMPORARILY_UNAVAILABLE";
        message =
          "Dịch vụ nghe đọc dự phòng chưa được cấu hình trên máy chủ. ViRead đang chuyển sang nhận diện dự phòng trên thiết bị.";
        retryable = true;
        break;
      case "GOOGLE_STT_UNAVAILABLE":
        code = "STT_TEMPORARILY_UNAVAILABLE";
        message = tSpeechError("errors.speech.sttGoogleUnavailable");
        retryable = true;
        break;
      case "STT_TIMEOUT":
      case "LOCAL_STT_TIMEOUT":
      case "GOOGLE_STT_TIMEOUT":
        code = "STT_TIMEOUT";
        message = tSpeechError("errors.speech.sttTimeout");
        retryable = true;
        break;
      case "STT_NETWORK_ERROR":
        code = "STT_NETWORK_ERROR";
        message = tSpeechError("errors.speech.sttNetworkError");
        retryable = true;
        break;
      case "STT_RATE_LIMITED":
      case "GOOGLE_STT_COOLDOWN":
        code = "STT_RATE_LIMITED";
        message = tSpeechError("errors.speech.sttRateLimited");
        retryable = true;
        break;
      case "STT_INVALID_AUDIO":
      case "INVALID_AUDIO":
        code = "STT_INVALID_AUDIO";
        message = tSpeechError("errors.speech.sttInvalidAudio");
        retryable = false;
        break;
      case "EMPTY_AUDIO":
        code = "STT_INVALID_AUDIO";
        message =
          "Chưa nhận được âm thanh ghi âm. Bé ghé gần micro và đọc lại nhé.";
        retryable = false;
        break;
      case "AUDIO_TOO_LARGE":
        code = "STT_INVALID_AUDIO";
        message =
          "Đoạn ghi âm hơi dài quá giới hạn. Bé đọc ngắn gọn hơn rồi thử lại nhé.";
        retryable = false;
        break;
      case "UNSUPPORTED_AUDIO":
        code = "STT_INVALID_AUDIO";
        message =
          "Định dạng âm thanh trên thiết bị này chưa được hỗ trợ. Ba mẹ hãy thử lại trên trình duyệt khác nhé.";
        retryable = false;
        break;
      case "GOOGLE_STT_AUDIO_TOO_LONG":
        code = "STT_INVALID_AUDIO";
        message =
          "Đoạn ghi âm vượt quá độ dài cho phép của dịch vụ nghe đọc. Bé đọc từng câu ngắn rồi thử lại nhé.";
        retryable = false;
        break;
      case "STT_PROVIDER_REJECTED":
      case "GOOGLE_STT_REJECTED":
        code = "STT_PROVIDER_REJECTED";
        message = tSpeechError("errors.speech.sttProviderRejected");
        retryable = false;
        break;
      default:
        if (status === 401) {
          code = "AUTH_REQUIRED";
          message = tSpeechError("errors.speech.sttAuthRequired");
          retryable = false;
        } else if (status === 403) {
          code = "FORBIDDEN";
          message = tSpeechError("errors.speech.sttForbidden");
          retryable = false;
        } else if (status === 422) {
          code = "VALIDATION_ERROR";
          message = tSpeechError("errors.speech.sttValidationError");
          retryable = false;
        } else if (status === 0) {
          code = "STT_NETWORK_ERROR";
          message = tSpeechError("errors.speech.sttOfflineNetwork");
          retryable = true;
        }
    }
  } else {
    switch (providerCode) {
      case "LOCAL_VOICE_UNCONFIGURED":
        code = "TTS_UNAVAILABLE";
        message = tSpeechError("errors.speech.ttsLocalUnconfigured");
        retryable = true;
        break;
      case "LOCAL_TTS_UNAVAILABLE":
        code = "TTS_UNAVAILABLE";
        message = tSpeechError("errors.speech.ttsLocalUnavailable");
        retryable = true;
        break;
      case "LOCAL_TTS_TIMEOUT":
      case "TTS_TIMEOUT":
      case "GOOGLE_TTS_TIMEOUT":
        code = "TTS_UNAVAILABLE";
        message = tSpeechError("errors.speech.ttsTimeout");
        retryable = true;
        break;
      case "LOCAL_TTS_BUSY":
      case "TTS_CONCURRENCY_LIMITED":
        code = "TTS_UNAVAILABLE";
        message = tSpeechError("errors.speech.ttsBusy");
        retryable = true;
        break;
      case "GOOGLE_TTS_UNAVAILABLE":
      case "GOOGLE_TTS_COOLDOWN":
      case "GOOGLE_TTS_RATE_LIMITED":
        code = "TTS_UNAVAILABLE";
        message = tSpeechError("errors.speech.ttsFallbackBusy");
        retryable = true;
        break;
      case "TTS_QUOTA_EXCEEDED":
        code = "TTS_UNAVAILABLE";
        message =
          "Dịch vụ giọng đọc mẫu tạm hết hạn mức. Bé có thể dùng giọng đọc trên thiết bị hoặc tự đọc tiếp nhé.";
        retryable = false;
        break;
      case "GOOGLE_TTS_DISABLED":
        code = "TTS_UNAVAILABLE";
        message =
          "Giọng đọc mẫu dự phòng hiện đang tắt trên máy chủ. Bé có thể dùng giọng đọc trên thiết bị hoặc tự đọc tiếp nhé.";
        retryable = false;
        break;
      case "GOOGLE_TTS_UNCONFIGURED":
        code = "TTS_UNAVAILABLE";
        message =
          "Giọng đọc mẫu dự phòng chưa được cấu hình trên máy chủ. Bé có thể dùng giọng đọc trên thiết bị hoặc tự đọc tiếp nhé.";
        retryable = false;
        break;
      case "VOICE_NOT_FOUND":
        code = "TTS_UNAVAILABLE";
        message =
          "Không tìm thấy giọng đọc mẫu đã chọn. ViRead sẽ dùng giọng đọc dự phòng nhé.";
        retryable = false;
        break;
      case "TTS_INVALID_TEXT":
        code = "VALIDATION_ERROR";
        message = "Nội dung cần đọc mẫu chưa hợp lệ hoặc quá dài.";
        retryable = false;
        break;
      case "GOOGLE_TTS_QUOTA_EXCEEDED":
      case "GOOGLE_TTS_AUTH_ERROR":
      case "GOOGLE_TTS_REJECTED":
        code = "TTS_UNAVAILABLE";
        message = tSpeechError("errors.speech.ttsProviderInterrupted");
        retryable = false;
        break;
      default:
        if (status === 401) {
          code = "AUTH_REQUIRED";
          message = tSpeechError("errors.speech.ttsAuthRequired");
          retryable = false;
        } else if (status === 403) {
          code = "FORBIDDEN";
          message = tSpeechError("errors.speech.ttsForbidden");
          retryable = false;
        } else if (status === 422) {
          code = "VALIDATION_ERROR";
          message = tSpeechError("errors.speech.ttsValidationError");
          retryable = false;
        } else if (status === 0) {
          message = tSpeechError("errors.speech.ttsNetworkError");
          retryable = true;
        } else {
          message = tSpeechError("errors.speech.ttsUnavailable");
        }
    }
  }

  return new ServiceError({
    code,
    message: appendRequestCorrelation(message, requestId),
    status,
    request_id: requestId,
    retryable,
    ...(providerCode ? { provider_code: providerCode } : {}),
  });
}

export const STT_FALLBACK_ELIGIBLE_CODES = new Set<string>([
  "STT_QUOTA_EXCEEDED",
  "GOOGLE_STT_QUOTA_EXCEEDED",
  "STT_UNAVAILABLE",
  "STT_TEMPORARILY_UNAVAILABLE",
  "STT_CONCURRENCY_LIMITED",
  "STT_NETWORK_ERROR",
  "STT_TIMEOUT",
  "STT_RATE_LIMITED",
  "SPEECH_UNAVAILABLE",
  "LOCAL_VOICE_UNCONFIGURED",
  "LOCAL_STT_UNAVAILABLE",
  "LOCAL_STT_TIMEOUT",
  "LOCAL_STT_BUSY",
  "GOOGLE_STT_UNCONFIGURED",
  "GOOGLE_STT_UNAVAILABLE",
  "GOOGLE_STT_TIMEOUT",
  "GOOGLE_STT_COOLDOWN",
]);

/**
 * Single source of truth for whether an STT error should trigger client-side
 * fallback (WASM / Android native / Browser SpeechRecognition or accepting a
 * high-confidence browser transcript in retry mode).
 *
 * Covers quota exhaustion (402 / STT_QUOTA_EXCEEDED), rate limits (429),
 * backend/worker outages (5xx / 0 / LOCAL_STT_* / STT_UNAVAILABLE), and
 * network TypeErrors, while never treating AbortError, auth (401/403), or
 * invalid-audio (422 / STT_INVALID_AUDIO) as fallback-eligible.
 */
export function isSttFallbackEligibleError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof TypeError) return true;
  if (error instanceof ServiceError) {
    if (
      error.status >= 500 ||
      error.status === 429 ||
      error.status === 402 ||
      error.status === 0
    ) {
      return true;
    }
    if (STT_FALLBACK_ELIGIBLE_CODES.has(String(error.code))) {
      return true;
    }
    const providerCode =
      typeof error.provider_code === "string" ? error.provider_code : "";
    return Boolean(
      providerCode && STT_FALLBACK_ELIGIBLE_CODES.has(providerCode),
    );
  }
  if (typeof error === "object") {
    const rec = error as {
      status?: unknown;
      code?: unknown;
      provider_code?: unknown;
      providerCode?: unknown;
      message?: unknown;
    };
    if (
      typeof rec.status === "number" &&
      (rec.status >= 500 ||
        rec.status === 429 ||
        rec.status === 402 ||
        rec.status === 0)
    ) {
      return true;
    }
    const code = typeof rec.code === "string" ? rec.code : "";
    if (STT_FALLBACK_ELIGIBLE_CODES.has(code)) return true;
    const providerCode =
      typeof rec.provider_code === "string"
        ? rec.provider_code
        : typeof rec.providerCode === "string"
          ? rec.providerCode
          : "";
    if (providerCode && STT_FALLBACK_ELIGIBLE_CODES.has(providerCode)) {
      return true;
    }
    const message = typeof rec.message === "string" ? rec.message : "";
    const combined = `${code} ${providerCode} ${message}`;
    for (const marker of STT_FALLBACK_ELIGIBLE_CODES) {
      if (combined.includes(marker)) return true;
    }
    return (
      combined.includes("503") ||
      combined.includes("502") ||
      combined.includes("504")
    );
  }
  return false;
}
