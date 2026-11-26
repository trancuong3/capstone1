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
): Promise<string | undefined> {
  try {
    const payload: unknown = await response.clone().json();
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
  } catch {
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
      case "LOCAL_VOICE_UNCONFIGURED":
        code = "STT_TEMPORARILY_UNAVAILABLE";
        message = tSpeechError("errors.speech.sttTemporarilyUnavailable");
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
      case "LOCAL_VOICE_UNCONFIGURED":
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
