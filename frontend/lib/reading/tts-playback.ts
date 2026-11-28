import { translateMessage } from "@/lib/i18n/formatter";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import { readLocaleCookie } from "@/lib/i18n/persistence";
import type { MessagesDictionary } from "@/lib/i18n/types";
import { getCachedLocaleMessages } from "@/messages/loader";
import { viMessages } from "@/messages/vi";
import type {
  PhonicsStepTiming,
  SpeechService,
  SynthesizedPhonicsSpeech,
} from "@/lib/api/speech-service";
import type {
  TimedSpeech,
  VoiceStudioService,
  WordTiming,
} from "@/lib/api/voice-studio-service";
import { withRequestDeadline } from "@/lib/api/request-deadline";
import {
  acquireUnlockedAudioElement,
  installAndroidAudioUnlock,
} from "@/lib/reading/android-audio-unlock";
import {
  isAndroidNativeSpeechAvailable,
  speakWithAndroidNativeTts,
  stopAndroidNativeTts,
} from "@/lib/reading/native-speech-bridge";
import type {
  PhonicsLessonStep,
  SupportedPhonicsLessonPlan,
} from "@/lib/reading/phonics-lesson";
import {
  approveSessionVoiceSwitch,
  DEFAULT_LOCAL_VOICE_ID,
  getActiveSessionVoiceLock,
  getDefaultVoiceIdForRegionAndGender,
  getVoicePolicyPreferences,
  GOOGLE_TTS_MODEL_VERSION,
  inferModelVersionForVoiceId,
  inferProviderFromVoiceId,
  inferRegionFromVoiceId,
  recordSessionUtteranceVoice,
  REGION_DEFAULT_VOICE_ID,
  registerVoiceCacheInvalidator,
  type VoiceProviderKind,
  type VoiceRegion,
} from "@/lib/reading/session-voice-lock";
import { prepareWordSampleAudio } from "@/lib/reading/short-word-audio";
import {
  clampSpeed,
  getGlobalVoiceSelectionUpdatedAt,
  getSpeechPreferences,
  getSpeechPreferencesMeta,
} from "@/lib/reading/speech-preferences";
import {
  getSynthesizedAudioMeta,
  setSynthesizedAudioMeta,
} from "@/lib/reading/synthesized-audio-meta";
import type { TtsCacheScope } from "@/lib/reading/tts-audio-cache";
import {
  isWavAudioBlob,
  type TtsAudioFormat,
} from "@/lib/reading/tts-audio-format";
import {
  hasMatchingSpeechWords,
  SHORT_TTS_MAX_CHARACTERS,
  splitSpeechText,
} from "@/lib/reading/tts-text";
import { normalizeVietnameseWord } from "@/lib/reading/vietnamese-text";
import {
  getFreshVoiceEngineHealth,
  mapLocalVoiceToGoogleBackup,
  recordTtsEngineUsage,
} from "@/lib/reading/voice-engine-status";
import {
  resolveVoiceGender,
  type VoiceGender,
} from "@/lib/reading/voice-persona";
import {
  findActiveWordIndex,
  HIGHLIGHT_LEAD_SECONDS,
} from "@/lib/reading/word-timeline";

export type PlaybackState =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "completed"
  | "fallback"
  | "error";

export interface SpeechPlayOptions {
  /** Normalize & prepare crisp single-word model in the locked voice. */
  wordSample?: boolean;
  /** Spoken coaching / guidance utterance in the locked voice. */
  coaching?: boolean;
  /** Relative speed for this utterance only (< 1 = slower, clearer help). */
  speedScale?: number;
  /** Utterance category for session voice-consistency auditing. */
  utteranceKind?: string;
  /** Verified public-catalog precomputed MP3 URL (never used for private books). */
  precomputedAudioUrl?: string | null;
  precomputedVoiceId?: string | null;
  precomputedCachedSpeed?: number | null;
  /** Preview mode: omit active session lock so voice preview never triggers 409. */
  bypassSessionLock?: boolean;
  bookId?: string | null;
  pageId?: string | null;
  pageRevisionId?: string | null;
  cacheScope?: TtsCacheScope | null;
  isPrivateBook?: boolean;
  onPlay?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onWordChange?: (index: number) => void;
  onEnded?: () => void;
}

export interface WordTimedPlayOptions {
  /** Verified page text, preserving its punctuation and paragraphs. */
  text?: string;
  /** Verified public-catalog precomputed MP3 URL (cached in Cache Storage). */
  precomputedAudioUrl?: string | null;
  /** Optional word timings sidecar for precomputed verified-catalog audio. */
  precomputedWordTimings?: readonly WordTiming[] | null;
  precomputedVoiceId?: string | null;
  precomputedCachedSpeed?: number | null;
  /** Preview mode: omit active session lock so voice preview never triggers 409. */
  bypassSessionLock?: boolean;
  /** Utterance category for session voice-consistency auditing & preview fallback. */
  utteranceKind?: string;
  bookId?: string | null;
  pageId?: string | null;
  pageRevisionId?: string | null;
  cacheScope?: TtsCacheScope | null;
  isPrivateBook?: boolean;
  onPlay?: () => void;
  /** -1 clears the cursor if text and OCR words cannot be safely mapped. */
  onWordChange?: (index: number) => void;
  onEnded?: () => void;
}

export interface PhonicsPlayOptions {
  speedScale?: number;
  bypassSessionLock?: boolean;
  bookId?: string | null;
  pageId?: string | null;
  pageRevisionId?: string | null;
  cacheScope?: TtsCacheScope | null;
  isPrivateBook?: boolean;
  onPlay?: (duration: number) => void;
  onStepChange?: (stepIndex: number, step: PhonicsLessonStep) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
}

export interface TtsPlaybackCacheContext {
  readonly bookId?: string | null;
  readonly pageId?: string | null;
  readonly pageRevisionId?: string | null;
  readonly isPrivateBook?: boolean;
  readonly bypassSessionLock?: boolean;
}

interface ResolvedOperationVoice {
  readonly sessionId: string | null;
  readonly bypassSessionLock?: boolean;
  readonly utteranceKind?: string;
  readonly provider: VoiceProviderKind;
  readonly requestedVoiceId: string | null;
  readonly cacheVoiceId: string;
  readonly region: VoiceRegion;
  readonly modelVersion: string;
  readonly speed: number;
}

interface Operation {
  readonly controller: AbortController;
  voice: ResolvedOperationVoice;
  paused: boolean;
  started: boolean;
  resumeWait?: () => void;
}

interface ActiveMedia {
  pause(): void;
  resume(): Promise<void>;
}

function resolveRuntimeLocale(): SupportedLocale {
  const cookieLocale = readLocaleCookie();
  if (cookieLocale) return cookieLocale;
  if (typeof document !== "undefined") {
    return normalizeLocale(document.documentElement?.lang) ?? DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

function tSpeechPlayback(key: string): string {
  const locale = resolveRuntimeLocale();
  const activeMessages: MessagesDictionary =
    getCachedLocaleMessages(locale) ?? viMessages;
  return translateMessage(activeMessages, viMessages, locale, key);
}

function stopped(): Error {
  return new DOMException("Audio playback was stopped.", "AbortError");
}

function unavailable(): Error {
  return new Error(tSpeechPlayback("speech.playback.unavailable"));
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function getLockedVoiceUnavailableNotice(): string {
  return tSpeechPlayback("speech.playback.lockedVoiceUnavailableNotice");
}

function getServerFallbackVoiceNotice(): string {
  return tSpeechPlayback("speech.playback.serverFallbackNotice");
}

function getAndroidNativeFallbackVoiceNotice(): string {
  return tSpeechPlayback("speech.playback.androidNativeFallbackNotice");
}

function getBrowserFallbackVoiceNotice(): string {
  return tSpeechPlayback("speech.playback.browserFallbackNotice");
}

function isNotAllowedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "NotAllowedError"
  );
}

function canReuseUnlockedMobileAudio(): boolean {
  if (typeof window === "undefined") return false;
  const isMobileRuntime =
    isAndroidNativeSpeechAvailable() ||
    (typeof navigator !== "undefined" &&
      /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent ?? ""));
  if (!isMobileRuntime) return false;
  if (typeof Audio !== "function") return false;
  try {
    return Function.prototype.toString.call(Audio).includes("[native code]");
  } catch {
    return false;
  }
}

const AUTOPLAY_BLOCKED_NOTICE =
  "Trình duyệt đang chờ bé chạm nút Nghe lại để bật âm thanh.";
const CATALOG_TTS_CACHE_NAME = "viread-catalog-tts-v1";

function canUseGoogleTtsFallback(): boolean {
  const policy = getVoicePolicyPreferences();
  return (
    policy.providerMode === "local_with_google_fallback" &&
    policy.allowGoogleTtsFallback
  );
}

function canUseBrowserSpeechSynthesis(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.speechSynthesis?.speak === "function" &&
    typeof SpeechSynthesisUtterance === "function"
  );
}

function isLocalVoiceUnconfiguredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const rec = error as {
    code?: unknown;
    providerCode?: unknown;
    provider_code?: unknown;
    message?: unknown;
  };
  const combined = `${String(rec.code ?? "")} ${String(rec.providerCode ?? "")} ${String(rec.provider_code ?? "")} ${String(rec.message ?? "")}`;
  return combined.includes("LOCAL_VOICE_UNCONFIGURED");
}

function isLocalVoiceUnconfiguredHealth(): boolean {
  const health = getFreshVoiceEngineHealth();
  if (!health) return false;
  return (
    health.local.tts_error_code === "LOCAL_VOICE_UNCONFIGURED" ||
    health.local.error_code === "LOCAL_VOICE_UNCONFIGURED"
  );
}

function canUseAllowedDeviceFallbackTts(
  voiceOrOp?: Operation | ResolvedOperationVoice,
  error?: unknown,
): boolean {
  // Enforce SessionVoiceLock ("Một buổi, một giọng"):
  // never silently jump to OS/Android/browser voice mid-session unless parent
  // opted into `local_with_google_fallback` + `allowGoogleTtsFallback` and the
  // local worker is unconfigured (LOCAL_VOICE_UNCONFIGURED).
  const voice = voiceOrOp && "voice" in voiceOrOp ? voiceOrOp.voice : voiceOrOp;
  const isSessionLocked = voice?.bypassSessionLock
    ? false
    : Boolean(voice?.sessionId ?? getActiveSessionVoiceLock());
  const isTransientBusyError = (err: unknown): boolean => {
    if (!err) return false;
    const rec = typeof err === "object" ? (err as Record<string, unknown>) : {};
    const combined = `${String(rec.code ?? "")} ${String(rec.providerCode ?? "")} ${String(rec.provider_code ?? "")} ${err instanceof Error ? err.message : String(err)}`;
    return /VOICE_WORKER_BUSY|LOCAL_VOICE_BUSY|LOCAL_TTS_BUSY|LOCAL_STT_BUSY/i.test(
      combined,
    );
  };
  const isTechnicalServerOutage = (err: unknown): boolean => {
    if (!err || isAbort(err) || isTransientBusyError(err)) return false;
    if (isLocalVoiceUnconfiguredError(err)) return true;
    if (err instanceof TypeError) return true;
    if (
      typeof err === "object" &&
      "name" in err &&
      (err as { name?: unknown }).name === "TimeoutError"
    ) {
      return true;
    }
    const rec = typeof err === "object" ? (err as Record<string, unknown>) : {};
    const hasNumericStatus = typeof rec.status === "number";
    const status = hasNumericStatus ? (rec.status as number) : NaN;
    if (status === 401 || status === 403 || status === 422) {
      return false;
    }
    if ((hasNumericStatus && status === 0) || status === 429 || status >= 500) {
      return true;
    }
    const code = typeof rec.code === "string" ? rec.code : "";
    const providerCode =
      typeof rec.provider_code === "string"
        ? rec.provider_code
        : typeof rec.providerCode === "string"
          ? rec.providerCode
          : "";
    if (
      code === "TTS_UNAVAILABLE" ||
      code === "NETWORK_ERROR" ||
      /LOCAL_TTS_UNAVAILABLE|LOCAL_TTS_TIMEOUT|TTS_TIMEOUT|GOOGLE_TTS_UNAVAILABLE|GOOGLE_TTS_TIMEOUT|TTS_QUOTA_EXCEEDED/i.test(
        providerCode,
      )
    ) {
      return true;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return /500|502|503|504|429|timeout|network|failed to fetch|unavailable|offline|econnrefused/i.test(
      msg,
    );
  };
  const optedInUnconfiguredFallback =
    canUseGoogleTtsFallback() &&
    (isTechnicalServerOutage(error) || isLocalVoiceUnconfiguredHealth());
  if (isSessionLocked && !optedInUnconfiguredFallback) {
    return false;
  }
  // Android Native TTS (`android_native`) is 100% on-device/offline (NOT Google
  // cloud), so it remains allowed under `local_only` when no session voice lock
  // is active (Tier 3 Android APK fallback).
  if (isAndroidNativeSpeechAvailable()) {
    return true;
  }
  // Explicit teacher voice preview (`utteranceKind === "voice_preview"`,
  // `bypassSessionLock: true`, fixed greeting with zero child PII) may fall
  // back to on-device `speechSynthesis` when backend TTS fails with a
  // technical/network outage even under `local_only`.
  if (
    voice?.bypassSessionLock &&
    voice?.utteranceKind === "voice_preview" &&
    error !== undefined &&
    isTechnicalServerOutage(error) &&
    canUseBrowserSpeechSynthesis()
  ) {
    return true;
  }
  const policy = getVoicePolicyPreferences();
  if (policy.providerMode === "local_only") {
    return false;
  }
  return canUseGoogleTtsFallback() && canUseBrowserSpeechSynthesis();
}

function shouldSkipBackendTtsForVoice(
  voice: ResolvedOperationVoice,
  hasBackendCacheTarget = false,
): boolean {
  if (
    hasBackendCacheTarget ||
    !canUseAllowedDeviceFallbackTts(voice) ||
    voice.provider !== "local"
  ) {
    return false;
  }
  const health = getFreshVoiceEngineHealth();
  if (!health) return false;
  if (health.elevenlabs?.tts_configured && !health.elevenlabs.tts_cooldown) {
    const requestedGender = resolveVoiceGender(
      voice.requestedVoiceId ?? voice.cacheVoiceId,
    );
    if (
      requestedGender !== "male" ||
      health.elevenlabs.male_tts_configured === true
    ) {
      return false;
    }
  }
  return (
    (!health.local.available || !health.local.tts_ready) &&
    (!health.google.tts_configured || health.google.tts_cooldown)
  );
}

function shouldSkipBackendTtsForBrowserFallback(
  operation: Operation,
  hasBackendCacheTarget = false,
): boolean {
  return shouldSkipBackendTtsForVoice(operation.voice, hasBackendCacheTarget);
}

function isCacheablePublicCatalogTtsUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(
      trimmed,
      typeof window !== "undefined"
        ? window.location.origin
        : "https://viread.local",
    );
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    // Strict privacy boundary: NEVER cache signed/private URLs carrying tokens.
    if (
      parsed.searchParams.has("token") ||
      parsed.searchParams.has("sig") ||
      parsed.pathname.includes("viread-private-books")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchPrecomputedCatalogAudio(
  url: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  if (!isCacheablePublicCatalogTtsUrl(url) || typeof fetch !== "function") {
    return null;
  }
  const cacheStorage =
    typeof caches !== "undefined" && typeof caches.open === "function"
      ? caches
      : null;

  let cache: Cache | null = null;
  if (cacheStorage) {
    try {
      cache = await cacheStorage.open(CATALOG_TTS_CACHE_NAME);
      const cached = await cache.match(url);
      if (cached && cached.ok) {
        const cachedBlob = await cached.blob();
        if (cachedBlob.size > 0) {
          return cachedBlob;
        }
      }
    } catch {
      cache = null;
    }
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      signal,
    });
    if (!response.ok) return null;
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    const looksAudio =
      contentType.startsWith("audio/") ||
      /\.(mp3|ogg|wav|m4a)(\?|$)/i.test(url);
    if (!looksAudio) return null;
    if (cache) {
      try {
        await cache.put(url, response.clone());
      } catch {
        // Ignore Cache Storage quota errors
      }
    }
    const blob = await response.blob();
    if (!blob.size) return null;
    if (!blob.type) {
      return new Blob([blob], { type: "audio/mpeg" });
    }
    return blob;
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}

function shouldRetryBackendWithGoogleTts(
  operation: Operation,
  error?: unknown,
): boolean {
  // Block explicit mid-session google_* retry on locked local worker outages
  // unless parent opted in and the local worker is unconfigured.
  const isSessionLocked = Boolean(
    operation.voice.sessionId ?? getActiveSessionVoiceLock(),
  );
  if (
    isSessionLocked &&
    !(isLocalVoiceUnconfiguredError(error) || isLocalVoiceUnconfiguredHealth())
  ) {
    return false;
  }
  if (!canUseGoogleTtsFallback() || operation.voice.provider !== "local") {
    return false;
  }
  const health = getFreshVoiceEngineHealth();
  if (!health) return true;
  return health.google.tts_configured && !health.google.tts_cooldown;
}

const MALE_BROWSER_VOICE_RE =
  /\b(nam|minh|son|sơn|hung|hùng|tuan|tuấn|an|male|namminh)\b/i;
const FEMALE_BROWSER_VOICE_RE =
  /\b(hoai|hoài|my|mỹ|hoaimy|linh|lan|mai|nu|nữ|female|chi)\b/i;

const pinnedBrowserVoices = new Map<VoiceGender, SpeechSynthesisVoice>();

export function clearPinnedBrowserVoices(): void {
  pinnedBrowserVoices.clear();
}

registerVoiceCacheInvalidator(clearPinnedBrowserVoices);

function inferBrowserVoiceGender(
  voice: SpeechSynthesisVoice,
): VoiceGender | null {
  const name = voice.name ?? "";
  if (MALE_BROWSER_VOICE_RE.test(name)) return "male";
  if (FEMALE_BROWSER_VOICE_RE.test(name)) return "female";
  return null;
}

function pickVietnameseBrowserVoice(
  synth: SpeechSynthesis,
  preferredGender?: VoiceGender,
): {
  readonly voice: SpeechSynthesisVoice | null;
  readonly genderMismatch: boolean;
} {
  try {
    const voices = synth.getVoices?.() ?? [];
    const viVoices = voices.filter((v) =>
      (v.lang ?? "").toLowerCase().startsWith("vi"),
    );
    if (!viVoices.length) return { voice: null, genderMismatch: false };

    if (preferredGender) {
      const pinned = pinnedBrowserVoices.get(preferredGender);
      if (pinned && viVoices.some((v) => v.name === pinned.name)) {
        const inferred = inferBrowserVoiceGender(pinned);
        return {
          voice: pinned,
          genderMismatch: inferred !== null && inferred !== preferredGender,
        };
      }
    }

    const scoreVoice = (voice: SpeechSynthesisVoice): number => {
      const name = voice.name ?? "";
      let score = 0;
      if (/google/i.test(name)) score += 4;
      if (/natural|neural|online/i.test(name)) score += 2;
      if (preferredGender === "male") {
        if (MALE_BROWSER_VOICE_RE.test(name)) score += 10;
        if (FEMALE_BROWSER_VOICE_RE.test(name)) score -= 6;
      } else if (preferredGender === "female") {
        if (FEMALE_BROWSER_VOICE_RE.test(name)) score += 10;
        if (MALE_BROWSER_VOICE_RE.test(name)) score -= 6;
      }
      return score;
    };
    const chosen =
      [...viVoices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ??
      viVoices[0] ??
      null;
    if (chosen && preferredGender) {
      pinnedBrowserVoices.set(preferredGender, chosen);
    }
    const inferred = chosen ? inferBrowserVoiceGender(chosen) : null;
    const genderMismatch = Boolean(
      chosen &&
      preferredGender &&
      inferred !== null &&
      inferred !== preferredGender,
    );
    return { voice: chosen, genderMismatch };
  } catch {
    return { voice: null, genderMismatch: false };
  }
}

async function resolveVietnameseBrowserVoice(
  synth: SpeechSynthesis,
  signal: AbortSignal,
  preferredGender?: VoiceGender,
): Promise<{
  readonly voice: SpeechSynthesisVoice | null;
  readonly genderMismatch: boolean;
}> {
  const existing = pickVietnameseBrowserVoice(synth, preferredGender);
  if (existing.voice) return existing;
  try {
    const voices = synth.getVoices?.() ?? [];
    if (voices.length > 0 || typeof synth.addEventListener !== "function") {
      return { voice: null, genderMismatch: false };
    }
  } catch {
    return { voice: null, genderMismatch: false };
  }
  return new Promise<{
    readonly voice: SpeechSynthesisVoice | null;
    readonly genderMismatch: boolean;
  }>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      try {
        synth.removeEventListener?.("voiceschanged", onVoicesChanged);
      } catch {
        // Ignore cleanup errors
      }
      resolve(pickVietnameseBrowserVoice(synth, preferredGender));
    };
    const onVoicesChanged = () => done();
    signal.addEventListener("abort", done, { once: true });
    try {
      synth.addEventListener("voiceschanged", onVoicesChanged);
    } catch {
      done();
      return;
    }
    const timer = window.setTimeout(done, 350);
  });
}

function computeWordCharOffsets(
  text: string,
  words: readonly string[],
): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const word of words) {
    const idx = text.indexOf(word, cursor);
    if (idx >= 0) {
      offsets.push(idx);
      cursor = idx + word.length;
    } else {
      offsets.push(cursor);
      cursor += word.length + 1;
    }
  }
  return offsets;
}

function findWordIndexForCharOffset(
  offsets: readonly number[],
  charIndex: number,
): number {
  let matched = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    if (offsets[i] <= charIndex) {
      matched = i;
    } else {
      break;
    }
  }
  return matched;
}

function resolveOperationVoice(
  speedLimit = Infinity,
  speedScale = 1,
  bypassSessionLock = false,
  utteranceKind?: string,
): ResolvedOperationVoice {
  const rawActiveLock = bypassSessionLock ? null : getActiveSessionVoiceLock();
  const prefs = getSpeechPreferences();
  const prefsUpdatedAt = getGlobalVoiceSelectionUpdatedAt();
  const policy = getVoicePolicyPreferences();
  const lockTimestampMs = rawActiveLock
    ? Date.parse(rawActiveLock.lockedAt)
    : 0;
  const prefsNewerThanLock =
    Boolean(rawActiveLock) &&
    prefsUpdatedAt > 0 &&
    Number.isFinite(lockTimestampMs) &&
    prefsUpdatedAt > lockTimestampMs;
  const activeLock = prefsNewerThanLock ? null : rawActiveLock;

  const baseSpeed = activeLock ? activeLock.speed : prefs.speed;
  const limited = Math.min(baseSpeed, speedLimit);
  const scaled = speedScale === 1 ? limited : limited * speedScale;
  const effectiveSpeed = clampSpeed(scaled);

  if (activeLock) {
    return {
      sessionId: activeLock.sessionId,
      bypassSessionLock: false,
      utteranceKind,
      provider: activeLock.provider,
      requestedVoiceId: activeLock.voiceId,
      cacheVoiceId: activeLock.voiceId,
      region: activeLock.region,
      modelVersion: activeLock.modelVersion,
      speed: effectiveSpeed,
    };
  }

  const requestedVoiceId =
    prefs.voiceId ??
    getDefaultVoiceIdForRegionAndGender(
      policy.region,
      getSpeechPreferencesMeta().gender,
    ) ??
    REGION_DEFAULT_VOICE_ID[policy.region] ??
    DEFAULT_LOCAL_VOICE_ID;
  const cacheVoiceId = requestedVoiceId;
  const provider = inferProviderFromVoiceId(cacheVoiceId);
  const region = inferRegionFromVoiceId(cacheVoiceId, policy.region);
  const modelVersion = inferModelVersionForVoiceId(
    cacheVoiceId,
    policy.modelVersion,
  );

  return {
    sessionId:
      rawActiveLock && !bypassSessionLock ? rawActiveLock.sessionId : null,
    bypassSessionLock,
    utteranceKind,
    provider,
    requestedVoiceId,
    cacheVoiceId,
    region,
    modelVersion,
    speed: effectiveSpeed,
  };
}

export function computeEffectivePlaybackRate(
  requestedSpeed: number,
  cachedSpeed: number | null | undefined,
): number {
  if (
    typeof cachedSpeed !== "number" ||
    !Number.isFinite(cachedSpeed) ||
    cachedSpeed <= 0
  ) {
    return 1;
  }
  if (Math.abs(requestedSpeed - cachedSpeed) <= 0.01) {
    return 1;
  }
  return Math.min(2.0, Math.max(0.5, requestedSpeed / cachedSpeed));
}

export function inferPrecomputedCatalogUrlSpeed(
  rawUrl: string | null | undefined,
): number | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(
      rawUrl.trim(),
      typeof window !== "undefined"
        ? window.location.origin
        : "https://viread.local",
    );
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const speedSegment = segments[segments.length - 2];
    if (!/^\d\.\d{1,2}$/.test(speedSegment)) return null;
    const parsedSpeed = Number(speedSegment);
    if (
      !Number.isFinite(parsedSpeed) ||
      parsedSpeed < 0.5 ||
      parsedSpeed > 2.0
    ) {
      return null;
    }
    return parsedSpeed;
  } catch {
    return null;
  }
}

function findActivePhonicsStepIndex(
  timings: readonly PhonicsStepTiming[],
  currentTime: number,
): number {
  for (let i = timings.length - 1; i >= 0; i -= 1) {
    if (currentTime + 0.02 >= timings[i].start) {
      return i;
    }
  }
  return timings.length > 0 ? 0 : -1;
}

/**
 * Owns one synthesis operation, ordered chunk queue and media clock.
 * Strictly enforces "Một buổi, một giọng" (never switches to browser OS voice
 * or static third-party speaker recordings).
 */
export class TtsPlayback {
  private state: PlaybackState = "idle";
  private fallbackNotice: string | null = null;
  private readonly listeners = new Set<() => void>();

  getState = (): PlaybackState => this.state;
  getFallbackNotice = (): string | null => this.fallbackNotice;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setFallbackNotice = (notice: string | null): void => {
    if (notice === this.fallbackNotice) return;
    this.fallbackNotice = notice;
    this.listeners.forEach((listener) => listener());
  };

  private onState = (state: PlaybackState): void => {
    if (state === this.state) return;
    this.state = state;
    this.listeners.forEach((listener) => listener());
  };

  private current: Operation | null = null;
  private media: ActiveMedia | null = null;
  private frame: number | null = null;
  private readonly cache = new Map<string, TimedSpeech>();
  private cacheBytes = 0;
  private readonly shortCache = new Map<
    string,
    {
      readonly audio: Blob;
      readonly usedFallbackVoice: boolean;
      readonly cachedSpeed: number | null;
    }
  >();
  private readonly inFlightShortPrefetch = new Map<
    string,
    Promise<{
      readonly audio: Blob;
      readonly usedFallbackVoice: boolean;
      readonly cachedSpeed: number | null;
    } | null>
  >();
  private shortCacheBytes = 0;
  private readonly phonicsCache = new Map<string, SynthesizedPhonicsSpeech>();
  private phonicsCacheBytes = 0;
  private timedCooldownUntil = 0;
  private defaultCacheContext: TtsPlaybackCacheContext | null = null;

  constructor(
    private readonly speech: SpeechService,
    private readonly studio: VoiceStudioService,
  ) {
    installAndroidAudioUnlock();
  }

  setCacheContext = (context: TtsPlaybackCacheContext | null): void => {
    this.defaultCacheContext = context;
  };

  private resolveCacheMeta(
    options: {
      readonly bookId?: string | null;
      readonly pageId?: string | null;
      readonly pageRevisionId?: string | null;
      readonly cacheScope?: TtsCacheScope | null;
      readonly isPrivateBook?: boolean;
      readonly wordSample?: boolean;
      readonly coaching?: boolean;
    },
    defaultPublicScope: TtsCacheScope | undefined,
    includeIsPrivate: true,
  ): {
    readonly bookId?: string;
    readonly pageId?: string;
    readonly pageRevisionId?: string;
    readonly cacheScope?: TtsCacheScope;
    readonly isPrivateBook?: boolean;
  };
  private resolveCacheMeta(
    options: {
      readonly bookId?: string | null;
      readonly pageId?: string | null;
      readonly pageRevisionId?: string | null;
      readonly cacheScope?: TtsCacheScope | null;
      readonly isPrivateBook?: boolean;
      readonly wordSample?: boolean;
      readonly coaching?: boolean;
    },
    defaultPublicScope: TtsCacheScope | undefined,
    includeIsPrivate: false,
  ): {
    readonly bookId?: string;
    readonly pageId?: string;
    readonly pageRevisionId?: string;
    readonly cacheScope?: TtsCacheScope;
  };
  private resolveCacheMeta(
    options: {
      readonly bookId?: string | null;
      readonly pageId?: string | null;
      readonly pageRevisionId?: string | null;
      readonly cacheScope?: TtsCacheScope | null;
      readonly isPrivateBook?: boolean;
      readonly wordSample?: boolean;
      readonly coaching?: boolean;
    },
    defaultPublicScope: TtsCacheScope | undefined,
    includeIsPrivate: boolean,
  ): {
    readonly bookId?: string;
    readonly pageId?: string;
    readonly pageRevisionId?: string;
    readonly cacheScope?: TtsCacheScope;
    readonly isPrivateBook?: boolean;
  } {
    const bookId = options.bookId ?? this.defaultCacheContext?.bookId ?? null;
    const pageId = options.pageId ?? this.defaultCacheContext?.pageId ?? null;
    const pageRevisionId =
      options.pageRevisionId ??
      this.defaultCacheContext?.pageRevisionId ??
      null;
    const isPrivateBook =
      options.isPrivateBook ?? this.defaultCacheContext?.isPrivateBook;
    const cacheScope: TtsCacheScope | undefined = options.coaching
      ? "COACHING"
      : isPrivateBook
        ? "PRIVATE"
        : (options.cacheScope ??
          (this.defaultCacheContext ? defaultPublicScope : undefined));
    const attachBookRefs = cacheScope !== "COACHING";
    const resolvedIsPrivateBook =
      cacheScope === "COACHING" ? false : isPrivateBook;
    return {
      ...(attachBookRefs && bookId ? { bookId } : {}),
      ...(attachBookRefs && pageId ? { pageId } : {}),
      ...(attachBookRefs && pageRevisionId ? { pageRevisionId } : {}),
      ...(cacheScope ? { cacheScope } : {}),
      ...(includeIsPrivate && isPrivateBook !== undefined
        ? { isPrivateBook: resolvedIsPrivateBook }
        : {}),
    };
  }

  handlePreferencesChange = (): void => {
    this.timedCooldownUntil = 0;
    this.cache.clear();
    this.cacheBytes = 0;
    this.shortCache.clear();
    this.shortCacheBytes = 0;
    this.phonicsCache.clear();
    this.phonicsCacheBytes = 0;
    this.inFlightShortPrefetch.clear();
    clearPinnedBrowserVoices();
    this.setFallbackNotice(null);
    this.stop();
  };

  stop = (): void => {
    const operation = this.current;
    this.current = null;
    operation?.controller.abort(stopped());
    this.cancelFrame();
    this.onState("idle");
  };

  dispose = (): void => {
    this.stop();
    this.cache.clear();
    this.cacheBytes = 0;
    this.shortCache.clear();
    this.inFlightShortPrefetch.clear();
    this.shortCacheBytes = 0;
    this.phonicsCache.clear();
    this.phonicsCacheBytes = 0;
  };

  pause = (): void => {
    if (!this.current || this.current.paused) return;
    this.current.paused = true;
    this.cancelFrame();
    try {
      this.media?.pause();
      this.onState("paused");
    } catch {
      this.stop();
    }
  };

  resume = async (): Promise<void> => {
    const operation = this.current;
    if (!operation?.paused) return;
    operation.paused = false;
    operation.resumeWait?.();
    operation.resumeWait = undefined;
    if (this.media) await this.media.resume();
    if (this.current === operation)
      this.onState(this.media ? "playing" : "loading");
  };

  private cancelFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private ensure(operation: Operation): void {
    operation.controller.signal.throwIfAborted();
    if (this.current !== operation) throw stopped();
  }

  private async waitIfPaused(operation: Operation): Promise<void> {
    this.ensure(operation);
    if (!operation.paused) return;
    await this.wait(
      operation,
      new Promise<void>((resolve) => {
        operation.resumeWait = resolve;
      }),
    );
    this.ensure(operation);
  }

  private wait<T>(operation: Operation, promise: Promise<T>): Promise<T> {
    return withRequestDeadline(
      () => promise,
      operation.controller.signal,
      600_000,
    );
  }

  private async run(
    action: (operation: Operation) => Promise<void>,
    speedLimit = Infinity,
    speedScale = 1,
    bypassSessionLock = false,
    utteranceKind?: string,
  ): Promise<void> {
    this.stop();
    const operation: Operation = {
      controller: new AbortController(),
      voice: resolveOperationVoice(
        speedLimit,
        speedScale,
        bypassSessionLock,
        utteranceKind,
      ),
      paused: false,
      started: false,
    };
    this.current = operation;
    this.onState("loading");
    try {
      await action(operation);
      if (this.current === operation) this.onState("completed");
    } catch (error) {
      if (this.current === operation)
        this.onState(isAbort(error) ? "idle" : "error");
      throw error;
    } finally {
      if (this.current === operation) this.current = null;
    }
  }

  private started(operation: Operation, callback: () => void): void {
    this.ensure(operation);
    if (operation.started) return;
    operation.started = true;
    callback();
  }

  private promoteOperationToGoogleVoice(
    operation: Operation,
    googleVoiceId: string,
  ): void {
    const googleRegion = inferRegionFromVoiceId(
      googleVoiceId,
      operation.voice.region,
    );
    // Do NOT permanently overwrite SessionVoiceLock to Google during a temporary
    // local outage so subsequent utterances automatically return to Local Offline
    // VieNeu-TTS as soon as the local worker recovers.
    operation.voice = {
      ...operation.voice,
      provider: "google",
      requestedVoiceId: googleVoiceId,
      cacheVoiceId: googleVoiceId,
      region: googleRegion,
      modelVersion: GOOGLE_TTS_MODEL_VERSION,
    };
    recordTtsEngineUsage({
      provider: "google",
      fallbackUsed: true,
      fallbackReason: "LOCAL_TTS_UNAVAILABLE",
      voiceId: googleVoiceId,
      voiceGender: resolveVoiceGender(googleVoiceId),
    });
  }

  private async playAndroidNativeSpeech(
    operation: Operation,
    text: string,
    options: {
      readonly words?: readonly string[];
      readonly onStart?: (duration: number) => void;
      readonly onWord?: (index: number) => void;
      readonly onTime?: (time: number, duration: number) => void;
    } = {},
  ): Promise<number> {
    this.ensure(operation);
    if (!isAndroidNativeSpeechAvailable()) throw unavailable();
    await this.waitIfPaused(operation);
    this.ensure(operation);

    recordTtsEngineUsage({
      provider: "android_native",
      fallbackUsed: true,
      fallbackReason: "LOCAL_TTS_UNAVAILABLE",
      voiceId: "android_vi_vn",
      voiceGender: resolveVoiceGender(operation.voice.requestedVoiceId),
    });
    this.setFallbackNotice(getAndroidNativeFallbackVoiceNotice());

    const wordList =
      options.words && options.words.length > 0
        ? options.words
        : text.trim().split(/\s+/).filter(Boolean);
    const charOffsets = options.words
      ? computeWordCharOffsets(text, options.words)
      : [];
    const msPerWord = Math.max(
      140,
      Math.round(340 / Math.max(0.5, operation.voice.speed)),
    );
    const estimatedDuration = Math.max(
      0.4,
      (wordList.length * msPerWord) / 1000,
    );

    let sawRange = false;
    let lastWordIdx = -1;
    let approxTimer: number | null = null;
    let emittedStart = false;
    let pauseRequested = false;
    let nextCharOffset = 0;
    let sliceBaseOffset = 0;
    let totalElapsedSec = 0;
    const startedAt = Date.now();

    const clearTimers = () => {
      if (approxTimer !== null) {
        window.clearInterval(approxTimer);
        approxTimer = null;
      }
    };

    const emitWord = (idx: number) => {
      if (
        this.current !== operation ||
        operation.controller.signal.aborted ||
        !options.onWord ||
        !options.words?.length
      ) {
        return;
      }
      const clamped = Math.max(0, Math.min(options.words.length - 1, idx));
      if (clamped !== lastWordIdx) {
        lastWordIdx = clamped;
        options.onWord(clamped);
      }
    };

    const media: ActiveMedia = {
      pause: () => {
        pauseRequested = true;
        stopAndroidNativeTts();
      },
      resume: async () => undefined,
    };
    this.media = media;

    try {
      while (
        !operation.controller.signal.aborted &&
        this.current === operation
      ) {
        await this.waitIfPaused(operation);
        this.ensure(operation);
        const remainingRaw = text.slice(nextCharOffset);
        const remainingSlice = remainingRaw.trimStart();
        if (!remainingSlice) break;
        sliceBaseOffset = text.length - remainingSlice.length;
        pauseRequested = false;
        const startWordIdx = Math.max(0, lastWordIdx);
        let approxIdx = startWordIdx;

        try {
          const preferredGender = resolveVoiceGender(
            operation.voice.requestedVoiceId,
          );
          const elapsedSec = await speakWithAndroidNativeTts(remainingSlice, {
            rate: operation.voice.speed,
            pitch: 1.0,
            voiceId: operation.voice.requestedVoiceId,
            voiceGender: preferredGender,
            signal: operation.controller.signal,
            onStart: (meta) => {
              if (
                this.current !== operation ||
                operation.controller.signal.aborted
              )
                return;
              if (meta?.voiceGenderMismatch) {
                this.setFallbackNotice(
                  tSpeechPlayback(
                    "speech.playback.deviceVoiceGenderMismatchNotice",
                  ),
                );
              }
              this.onState("playing");
              if (!emittedStart) {
                emittedStart = true;
                options.onStart?.(estimatedDuration);
              }
              if (
                options.words?.length &&
                options.onWord &&
                approxTimer === null
              ) {
                emitWord(approxIdx);
                approxTimer = window.setInterval(() => {
                  if (
                    this.current !== operation ||
                    operation.controller.signal.aborted ||
                    operation.paused ||
                    sawRange
                  ) {
                    return;
                  }
                  approxIdx += 1;
                  if (approxIdx < options.words!.length) {
                    emitWord(approxIdx);
                    const approxOffset = charOffsets[approxIdx];
                    if (typeof approxOffset === "number") {
                      nextCharOffset = Math.max(nextCharOffset, approxOffset);
                    }
                    const elapsedNow = (Date.now() - startedAt) / 1000;
                    options.onTime?.(
                      Math.min(estimatedDuration, elapsedNow),
                      estimatedDuration,
                    );
                  } else {
                    clearTimers();
                  }
                }, msPerWord);
              }
            },
            onRangeStart: (start) => {
              if (
                this.current !== operation ||
                operation.controller.signal.aborted
              )
                return;
              const globalOffset = sliceBaseOffset + Math.max(0, start);
              nextCharOffset = Math.max(nextCharOffset, globalOffset);
              if (options.words?.length) {
                sawRange = true;
                clearTimers();
                emitWord(findWordIndexForCharOffset(charOffsets, globalOffset));
              }
            },
          });
          totalElapsedSec += elapsedSec;
          break;
        } catch (err) {
          clearTimers();
          if (
            pauseRequested &&
            !operation.controller.signal.aborted &&
            this.current === operation &&
            isAbort(err)
          ) {
            continue;
          }
          throw err;
        }
      }
      return totalElapsedSec;
    } finally {
      clearTimers();
      if (this.media === media) this.media = null;
    }
  }

  private async playDeviceFallbackSpeech(
    operation: Operation,
    text: string,
    options: {
      readonly words?: readonly string[];
      readonly onStart?: (duration: number) => void;
      readonly onWord?: (index: number) => void;
      readonly onTime?: (time: number, duration: number) => void;
    } = {},
  ): Promise<number> {
    const allowBrowserFallback =
      canUseGoogleTtsFallback() ||
      Boolean(
        operation.voice.bypassSessionLock &&
        operation.voice.utteranceKind === "voice_preview",
      );
    if (isAndroidNativeSpeechAvailable()) {
      try {
        return await this.playAndroidNativeSpeech(operation, text, options);
      } catch (error) {
        this.ensure(operation);
        if (isAbort(error)) throw error;
        if (!allowBrowserFallback || !canUseBrowserSpeechSynthesis()) {
          throw unavailable();
        }
      }
    }
    if (!allowBrowserFallback) {
      this.setFallbackNotice(getLockedVoiceUnavailableNotice());
      throw unavailable();
    }
    return this.playBrowserSpeech(operation, text, options);
  }

  private async playBrowserSpeech(
    operation: Operation,
    text: string,
    options: {
      readonly words?: readonly string[];
      readonly onStart?: (duration: number) => void;
      readonly onWord?: (index: number) => void;
      readonly onTime?: (time: number, duration: number) => void;
    } = {},
  ): Promise<number> {
    this.ensure(operation);
    if (!canUseBrowserSpeechSynthesis()) throw unavailable();
    await this.waitIfPaused(operation);
    this.ensure(operation);

    const synth = window.speechSynthesis;
    const preferredGender = resolveVoiceGender(
      operation.voice.requestedVoiceId,
    );
    const { voice: resolvedVoice, genderMismatch } =
      await resolveVietnameseBrowserVoice(
        synth,
        operation.controller.signal,
        preferredGender,
      );
    this.ensure(operation);
    if (!resolvedVoice) {
      this.setFallbackNotice(getLockedVoiceUnavailableNotice());
      throw unavailable();
    }
    recordTtsEngineUsage({
      provider: "browser",
      fallbackUsed: true,
      fallbackReason: genderMismatch
        ? "BROWSER_VOICE_GENDER_MISMATCH"
        : "LOCAL_TTS_UNAVAILABLE",
      voiceId: operation.voice.requestedVoiceId,
      voiceGender: preferredGender,
    });
    this.setFallbackNotice(
      genderMismatch
        ? tSpeechPlayback("speech.playback.deviceVoiceGenderMismatchNotice")
        : getBrowserFallbackVoiceNotice(),
    );

    const wordList =
      options.words && options.words.length > 0
        ? options.words
        : text.trim().split(/\s+/).filter(Boolean);
    const charOffsets = options.words
      ? computeWordCharOffsets(text, options.words)
      : [];
    const msPerWord = Math.max(
      140,
      Math.round(340 / Math.max(0.5, operation.voice.speed)),
    );
    const estimatedDuration = Math.max(
      0.4,
      (wordList.length * msPerWord) / 1000,
    );
    const maxWatchdogMs = Math.min(
      120_000,
      Math.max(8_000, Math.round(estimatedDuration * 1000 * 2.5) + 4_000),
    );

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let startedEmitted = false;
      let speakDispatched = false;
      let sawBoundary = false;
      let lastWordIdx = -1;
      let lastBoundaryCharIndex = 0;
      let currentOffsetBase = 0;
      let retriedFromPausedHang = false;
      let approxTimer: number | null = null;
      let speakDelayTimer: number | null = null;
      let resumeFallbackTimer: number | null = null;
      let watchdogTimer: number | null = null;
      let activeElapsedMs = 0;
      let lastWatchdogTickAt = Date.now();
      const startedAt = Date.now();
      const signal = operation.controller.signal;

      const clearTimers = () => {
        if (approxTimer !== null) {
          window.clearInterval(approxTimer);
          approxTimer = null;
        }
        if (speakDelayTimer !== null) {
          window.clearTimeout(speakDelayTimer);
          speakDelayTimer = null;
        }
        if (resumeFallbackTimer !== null) {
          window.clearTimeout(resumeFallbackTimer);
          resumeFallbackTimer = null;
        }
        if (watchdogTimer !== null) {
          window.clearInterval(watchdogTimer);
          watchdogTimer = null;
        }
      };

      const active = () =>
        !settled && this.current === operation && !signal.aborted;

      let activeUtterance = new SpeechSynthesisUtterance(text);

      const detachUtterance = (u: SpeechSynthesisUtterance) => {
        u.onstart = null;
        u.onend = null;
        u.onerror = null;
        u.onboundary = null;
      };

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimers();
        signal.removeEventListener("abort", onAbort);
        if (this.media === media) this.media = null;
        detachUtterance(activeUtterance);
        if (error) {
          reject(error);
        } else {
          const elapsedSec = Math.max(
            0.1,
            (Date.now() - startedAt) / 1000 || estimatedDuration,
          );
          resolve(elapsedSec);
        }
      };

      const emitWord = (idx: number) => {
        if (!active() || !options.onWord || !options.words?.length) return;
        const clamped = Math.max(0, Math.min(options.words.length - 1, idx));
        if (clamped !== lastWordIdx) {
          lastWordIdx = clamped;
          options.onWord(clamped);
        }
      };

      const ensureStarted = () => {
        if (startedEmitted || !active()) return;
        startedEmitted = true;
        this.onState("playing");
        options.onStart?.(estimatedDuration);
        if (options.words?.length && options.onWord) {
          emitWord(0);
          let approxIdx = 0;
          approxTimer = window.setInterval(() => {
            if (!active() || operation.paused || sawBoundary) return;
            approxIdx += 1;
            if (approxIdx < options.words!.length) {
              emitWord(approxIdx);
              const elapsedSec = (Date.now() - startedAt) / 1000;
              options.onTime?.(
                Math.min(estimatedDuration, elapsedSec),
                estimatedDuration,
              );
            } else if (approxTimer !== null) {
              window.clearInterval(approxTimer);
              approxTimer = null;
            }
          }, msPerWord);
        }
      };

      const wireUtterance = (
        u: SpeechSynthesisUtterance,
        baseOffset: number,
      ) => {
        u.lang = "vi-VN";
        u.rate = operation.voice.speed;
        u.voice = resolvedVoice;
        u.onstart = () => {
          ensureStarted();
        };
        u.onboundary = (event) => {
          if (!active()) return;
          ensureStarted();
          if (typeof event.charIndex === "number") {
            const globalCharIndex = baseOffset + Math.max(0, event.charIndex);
            lastBoundaryCharIndex = Math.max(
              lastBoundaryCharIndex,
              globalCharIndex,
            );
            if (options.words?.length) {
              sawBoundary = true;
              if (approxTimer !== null) {
                window.clearInterval(approxTimer);
                approxTimer = null;
              }
              emitWord(
                findWordIndexForCharOffset(charOffsets, globalCharIndex),
              );
            }
          }
        };
        u.onend = () => {
          if (!active()) return;
          ensureStarted();
          finish();
        };
        u.onerror = (event) => {
          if (!active()) return;
          const errName =
            (event as { error?: string } | undefined)?.error ?? "";
          if (
            signal.aborted ||
            errName === "canceled" ||
            errName === "interrupted"
          ) {
            finish(stopped());
          } else {
            finish(unavailable());
          }
        };
      };

      wireUtterance(activeUtterance, 0);

      const media: ActiveMedia = {
        pause: () => {
          if (resumeFallbackTimer !== null) {
            window.clearTimeout(resumeFallbackTimer);
            resumeFallbackTimer = null;
          }
          try {
            synth.pause?.();
          } catch {
            // Ignore browser pause error
          }
        },
        resume: async () => {
          lastWatchdogTickAt = Date.now();
          if (resumeFallbackTimer !== null) {
            window.clearTimeout(resumeFallbackTimer);
            resumeFallbackTimer = null;
          }
          try {
            synth.resume?.();
          } catch {
            // Ignore browser resume error
          }
          if (!retriedFromPausedHang) {
            const offsetAtResume = lastBoundaryCharIndex;
            resumeFallbackTimer = window.setTimeout(() => {
              resumeFallbackTimer = null;
              if (
                !active() ||
                operation.paused ||
                retriedFromPausedHang ||
                lastBoundaryCharIndex >= text.length
              ) {
                return;
              }
              const stillStuckPaused =
                Boolean((synth as { paused?: boolean }).paused) &&
                lastBoundaryCharIndex === offsetAtResume;
              if (!stillStuckPaused) return;
              const restRaw = text.slice(offsetAtResume);
              const restTrimmed = restRaw.trimStart();
              if (!restTrimmed) {
                finish();
                return;
              }
              retriedFromPausedHang = true;
              currentOffsetBase = text.length - restTrimmed.length;
              detachUtterance(activeUtterance);
              try {
                synth.cancel?.();
              } catch {
                // Ignore cancel error
              }
              activeUtterance = new SpeechSynthesisUtterance(restTrimmed);
              wireUtterance(activeUtterance, currentOffsetBase);
              try {
                synth.speak(activeUtterance);
              } catch {
                finish(unavailable());
              }
            }, 1_200);
          }
        },
      };
      this.media = media;

      const onAbort = () => {
        try {
          synth.cancel?.();
        } catch {
          // Ignore cancel error
        }
        finish(stopped());
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const dispatchSpeak = () => {
        if (!active()) return;
        speakDispatched = true;
        lastWatchdogTickAt = Date.now();
        try {
          synth.speak(activeUtterance);
          // If voice was paused right before speak, respect pause state
          if (operation.paused) {
            synth.pause?.();
          }
        } catch {
          finish(unavailable());
          return;
        }
        // Watchdog guards Chrome & Android WebView bugs where `onend` (or `onstart`)
        // is silently swallowed so reading & Quiz flows never hang permanently.
        watchdogTimer = window.setInterval(() => {
          if (!active()) {
            clearTimers();
            return;
          }
          const now = Date.now();
          const delta = Math.max(0, now - lastWatchdogTickAt);
          lastWatchdogTickAt = now;
          if (operation.paused) return;
          activeElapsedMs += delta;

          const synthStillBusy = Boolean(synth.speaking || synth.pending);
          if (activeElapsedMs >= maxWatchdogMs) {
            try {
              synth.cancel?.();
            } catch {
              // Ignore cancel error
            }
            ensureStarted();
            finish();
            return;
          }
          if (
            startedEmitted &&
            !synthStillBusy &&
            activeElapsedMs >=
              Math.max(2_000, Math.round(estimatedDuration * 1000) + 1_200)
          ) {
            finish();
            return;
          }
          if (
            !startedEmitted &&
            speakDispatched &&
            !synthStillBusy &&
            activeElapsedMs >= 3_500
          ) {
            ensureStarted();
            finish();
          }
        }, 250);
      };

      try {
        // Never call `synth.cancel(); synth.speak(utterance);` synchronously back-to-back:
        // Chrome and Android WebView frequently cancel the newly queued utterance.
        if (synth.speaking || synth.pending) {
          synth.cancel?.();
          speakDelayTimer = window.setTimeout(() => {
            speakDelayTimer = null;
            dispatchSpeak();
          }, 40);
        } else {
          dispatchSpeak();
        }
      } catch {
        finish(unavailable());
      }
    });
  }

  private canUsePrecomputedCatalogUrl(
    operation: Operation,
    options: {
      readonly precomputedAudioUrl?: string | null;
      readonly precomputedVoiceId?: string | null;
      readonly isPrivateBook?: boolean;
    },
    requireWordTimings = false,
  ): boolean {
    if (!options.precomputedAudioUrl) return false;
    if (options.isPrivateBook || this.defaultCacheContext?.isPrivateBook) {
      return false;
    }
    const expectedVoiceId =
      options.precomputedVoiceId?.trim() || DEFAULT_LOCAL_VOICE_ID;
    const expectedGender = resolveVoiceGender(expectedVoiceId);
    const activeGender = resolveVoiceGender(operation.voice.cacheVoiceId);
    if (
      operation.voice.provider !== "local" ||
      operation.voice.cacheVoiceId !== expectedVoiceId ||
      expectedGender !== activeGender
    ) {
      return false;
    }
    if (requireWordTimings) return false;
    return true;
  }

  private auditUtterance(
    operation: Operation,
    kind: string,
    textPreview: string,
    served?: {
      readonly provider?: string | null;
      readonly voiceId?: string | null;
      readonly region?: string | null;
      readonly modelVersion?: string | null;
    },
  ): void {
    // Voice previews explicitly bypass SessionVoiceLock and MUST NOT pollute
    // the active reading session's voice consistency audit.
    if (operation.voice.bypassSessionLock) {
      return;
    }
    const resolvedVoiceId =
      served?.voiceId?.trim() || operation.voice.cacheVoiceId;
    const rawProvider = served?.provider?.trim().toLowerCase();
    const resolvedProvider: VoiceProviderKind =
      rawProvider === "google" ||
      rawProvider === "google_cloud" ||
      inferProviderFromVoiceId(resolvedVoiceId) === "google"
        ? "google"
        : operation.voice.provider;
    const resolvedRegion: VoiceRegion =
      served?.region === "north" ||
      served?.region === "central" ||
      served?.region === "south"
        ? served.region
        : inferRegionFromVoiceId(resolvedVoiceId, operation.voice.region);
    const resolvedModelVersion =
      served?.modelVersion?.trim() ||
      inferModelVersionForVoiceId(
        resolvedVoiceId,
        resolvedProvider === operation.voice.provider
          ? operation.voice.modelVersion
          : undefined,
      );
    recordSessionUtteranceVoice(
      {
        kind,
        provider: resolvedProvider,
        voiceId: resolvedVoiceId,
        region: resolvedRegion,
        modelVersion: resolvedModelVersion,
        speed: operation.voice.speed,
        textPreview,
      },
      operation.voice.sessionId,
    );
  }

  private splitShortChunks(
    spokenText: string,
    voice: ResolvedOperationVoice,
    wordSample: boolean,
    hasCacheTarget = false,
  ) {
    // Avoid splintering into 95-char chunks when a precomputed/cacheable
    // full-page or coaching cache entry is targeted.
    const shouldSentencePipeline =
      !wordSample &&
      !hasCacheTarget &&
      voice.provider === "local" &&
      spokenText.length > 90 &&
      /[.!?…]\s+\S/u.test(spokenText);
    return splitSpeechText(
      spokenText,
      shouldSentencePipeline ? 95 : SHORT_TTS_MAX_CHARACTERS,
    );
  }

  prefetch = async (
    text: string,
    options: {
      readonly coaching?: boolean;
      readonly wordSample?: boolean;
      readonly speedScale?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<void> => {
    if (typeof this.speech.synthesize !== "function") return;
    if (options.signal?.aborted) return;
    const wordSample = Boolean(options.wordSample);
    const spokenText = wordSample
      ? normalizeVietnameseWord(text)
      : text.normalize("NFC");
    if (!spokenText.trim()) return;
    const voice = resolveOperationVoice(
      Infinity,
      options.speedScale ?? 1,
      Boolean(this.defaultCacheContext?.bypassSessionLock),
    );
    const hasCacheTarget = Boolean(
      options.coaching ||
      options.wordSample ||
      this.defaultCacheContext?.bookId ||
      this.defaultCacheContext?.pageId ||
      this.defaultCacheContext?.pageRevisionId,
    );
    if (shouldSkipBackendTtsForVoice(voice, hasCacheTarget)) return;
    const cacheMeta = this.resolveCacheMeta(
      options,
      wordSample ? "CATALOG" : "COACHING",
      true,
    );
    const chunks = this.splitShortChunks(
      spokenText,
      voice,
      wordSample,
      hasCacheTarget,
    );
    for (const chunk of chunks) {
      if (options.signal?.aborted) return;
      const normalized = chunk.text.normalize("NFC");
      const key = JSON.stringify([
        voice.provider,
        voice.cacheVoiceId,
        voice.modelVersion,
        voice.speed,
        normalized,
        wordSample,
      ]);
      if (this.shortCache.has(key)) continue;
      const existing = this.inFlightShortPrefetch.get(key);
      if (existing) {
        await existing;
        continue;
      }
      const task = (async (): Promise<{
        readonly audio: Blob;
        readonly usedFallbackVoice: boolean;
        readonly cachedSpeed: number | null;
      } | null> => {
        try {
          let source = await this.speech.synthesize(normalized, {
            voiceId: voice.requestedVoiceId ?? undefined,
            speed: voice.speed,
            wordSample,
            ...(voice.bypassSessionLock ? { bypassSessionLock: true } : {}),
            ...cacheMeta,
            signal: options.signal,
          });
          if (options.signal?.aborted) return null;
          const sourceMeta = getSynthesizedAudioMeta(source);
          const cachedSpeed = sourceMeta?.cachedSpeed ?? null;
          if (wordSample) {
            source = await prepareWordSampleAudio(source);
            if (options.signal?.aborted) return null;
            if (sourceMeta) {
              setSynthesizedAudioMeta(source, sourceMeta);
            }
          }
          const entry = {
            audio: source,
            usedFallbackVoice: Boolean(sourceMeta?.usedFallbackVoice),
            cachedSpeed,
          };
          this.cacheShort(key, entry);
          return entry;
        } catch {
          // Best-effort warmup only; never disturb active playback.
          return null;
        }
      })();
      this.inFlightShortPrefetch.set(key, task);
      try {
        await task;
      } finally {
        if (this.inFlightShortPrefetch.get(key) === task) {
          this.inFlightShortPrefetch.delete(key);
        }
      }
    }
  };

  play = (text: string, options: SpeechPlayOptions = {}): Promise<void> =>
    this.run(
      async (operation) => {
        const spokenText = options.wordSample
          ? normalizeVietnameseWord(text)
          : text.normalize("NFC");
        if (!spokenText.trim()) throw unavailable();

        const kind =
          options.utteranceKind ??
          (options.wordSample
            ? "word_sample"
            : options.coaching
              ? "coaching"
              : "prompt");
        let utteranceAudited = false;
        const recordActualUtterance = (served?: {
          readonly provider?: string | null;
          readonly voiceId?: string | null;
          readonly region?: string | null;
          readonly modelVersion?: string | null;
        }) => {
          if (utteranceAudited) return;
          utteranceAudited = true;
          this.auditUtterance(operation, kind, spokenText, served);
        };

        // Tier 1: Precomputed verified-catalog MP3 URL (gated strictly to DEFAULT_LOCAL_VOICE_ID & public books).
        if (this.canUsePrecomputedCatalogUrl(operation, options, false)) {
          const precomputedBlob = await fetchPrecomputedCatalogAudio(
            options.precomputedAudioUrl!,
            operation.controller.signal,
          );
          this.ensure(operation);
          if (precomputedBlob) {
            recordTtsEngineUsage({
              provider: "catalog_cache",
              fallbackUsed: false,
              fallbackReason: null,
              voiceId: operation.voice.requestedVoiceId,
              voiceGender: resolveVoiceGender(operation.voice.requestedVoiceId),
            });
            recordActualUtterance({
              provider: "local",
              voiceId:
                options.precomputedVoiceId?.trim() || DEFAULT_LOCAL_VOICE_ID,
            });
            this.setFallbackNotice(null);
            try {
              const precomputedPlaybackRate = computeEffectivePlaybackRate(
                operation.voice.speed,
                options.precomputedCachedSpeed ??
                  inferPrecomputedCatalogUrlSpeed(options.precomputedAudioUrl),
              );
              await this.playAudio(
                operation,
                precomputedBlob,
                undefined,
                0,
                (duration) =>
                  this.started(operation, () => options.onPlay?.(duration)),
                undefined,
                (time, duration) => options.onTimeUpdate?.(time, duration),
                precomputedPlaybackRate,
              );
              this.ensure(operation);
              options.onEnded?.();
              return;
            } catch (precomputedError) {
              this.ensure(operation);
              if (
                isAbort(precomputedError) ||
                isNotAllowedError(precomputedError) ||
                precomputedError instanceof PartialPlaybackError
              ) {
                if (isNotAllowedError(precomputedError)) {
                  this.setFallbackNotice(AUTOPLAY_BLOCKED_NOTICE);
                }
                throw precomputedError;
              }
              // Fall through cleanly to backend / Android native / browser TTS.
            }
          }
        }

        const hasCacheTarget = Boolean(
          options.bookId ||
          options.pageId ||
          options.pageRevisionId ||
          options.coaching ||
          options.wordSample ||
          options.cacheScope === "CATALOG" ||
          options.cacheScope === "COACHING" ||
          this.defaultCacheContext?.bookId ||
          this.defaultCacheContext?.pageId ||
          this.defaultCacheContext?.pageRevisionId,
        );

        let elapsed = 0;
        const chunks = this.splitShortChunks(
          spokenText,
          operation.voice,
          Boolean(options.wordSample),
          hasCacheTarget,
        );

        const fetchChunk = async (
          chunkText: string,
          audioFormat?: TtsAudioFormat,
        ): Promise<{
          audio: Blob;
          usedFallbackVoice: boolean;
          cachedSpeed: number | null;
          key: string;
        }> => {
          const normalized = chunkText.normalize("NFC");
          const makeKey = () =>
            JSON.stringify([
              operation.voice.provider,
              operation.voice.cacheVoiceId,
              operation.voice.modelVersion,
              operation.voice.speed,
              normalized,
              Boolean(options.wordSample),
            ]);
          const shortKey = makeKey();
          const cachedShort =
            audioFormat === undefined
              ? this.shortCache.get(shortKey)
              : undefined;
          if (cachedShort) {
            return {
              audio: cachedShort.audio,
              usedFallbackVoice: cachedShort.usedFallbackVoice,
              cachedSpeed: cachedShort.cachedSpeed,
              key: shortKey,
            };
          }
          const pendingPrefetch =
            audioFormat === undefined
              ? this.inFlightShortPrefetch.get(shortKey)
              : undefined;
          if (pendingPrefetch) {
            const prefetched = await this.wait(operation, pendingPrefetch);
            this.ensure(operation);
            if (prefetched) {
              return {
                audio: prefetched.audio,
                usedFallbackVoice: prefetched.usedFallbackVoice,
                cachedSpeed: prefetched.cachedSpeed,
                key: shortKey,
              };
            }
          }
          const cacheMeta = this.resolveCacheMeta(
            options,
            options.wordSample ? "CATALOG" : "COACHING",
            true,
          );
          let source: Blob;
          let forcedFallbackVoice = false;
          try {
            source = await this.wait(
              operation,
              this.speech.synthesize(normalized, {
                voiceId: operation.voice.requestedVoiceId ?? undefined,
                speed: operation.voice.speed,
                wordSample: Boolean(options.wordSample),
                ...(audioFormat ? { audioFormat } : {}),
                ...(operation.voice.bypassSessionLock
                  ? { bypassSessionLock: true }
                  : {}),
                ...cacheMeta,
                signal: operation.controller.signal,
              }),
            );
          } catch (error) {
            this.ensure(operation);
            if (isAbort(error)) throw error;
            if (shouldRetryBackendWithGoogleTts(operation, error)) {
              if (operation.voice.sessionId) {
                approveSessionVoiceSwitch(operation.voice.sessionId);
              }
              const googleVoiceId = mapLocalVoiceToGoogleBackup(
                operation.voice.requestedVoiceId,
                operation.voice.region,
              );
              source = await this.wait(
                operation,
                this.speech.synthesize(normalized, {
                  voiceId: googleVoiceId,
                  speed: operation.voice.speed,
                  wordSample: Boolean(options.wordSample),
                  ...(audioFormat ? { audioFormat } : {}),
                  ...(operation.voice.bypassSessionLock
                    ? { bypassSessionLock: true }
                    : {}),
                  ...cacheMeta,
                  signal: operation.controller.signal,
                }),
              );
              this.ensure(operation);
              this.promoteOperationToGoogleVoice(operation, googleVoiceId);
              forcedFallbackVoice = true;
            } else {
              throw error;
            }
          }
          this.ensure(operation);
          const resolvedKey = makeKey();
          const sourceMeta = getSynthesizedAudioMeta(source);
          const cachedSpeed = sourceMeta?.cachedSpeed ?? null;
          const usedFallbackVoice =
            forcedFallbackVoice || Boolean(sourceMeta?.usedFallbackVoice);
          if (options.wordSample) {
            source = await this.wait(operation, prepareWordSampleAudio(source));
            if (sourceMeta) {
              setSynthesizedAudioMeta(source, sourceMeta);
            }
          }
          this.cacheShort(resolvedKey, {
            audio: source,
            usedFallbackVoice,
            cachedSpeed,
          });
          return {
            audio: source,
            usedFallbackVoice,
            cachedSpeed,
            key: resolvedKey,
          };
        };

        let nextPrefetch: Promise<{
          audio: Blob;
          usedFallbackVoice: boolean;
          cachedSpeed: number | null;
          key: string;
        }> | null = null;
        let useBrowserFallback = shouldSkipBackendTtsForBrowserFallback(
          operation,
          hasCacheTarget,
        );

        for (let idx = 0; idx < chunks.length; idx += 1) {
          const chunk = chunks[idx];
          await this.waitIfPaused(operation);
          this.ensure(operation);
          const onStart = (duration: number) =>
            this.started(operation, () => options.onPlay?.(duration));
          const onTime = (time: number, duration: number) =>
            options.onTimeUpdate?.(elapsed + time, elapsed + duration);

          if (useBrowserFallback) {
            recordActualUtterance({
              provider: isAndroidNativeSpeechAvailable()
                ? "android_native"
                : "browser",
              voiceId: isAndroidNativeSpeechAvailable()
                ? "android_vi_vn"
                : operation.voice.cacheVoiceId,
            });
            elapsed += await this.playDeviceFallbackSpeech(
              operation,
              chunk.text,
              {
                onStart,
                onTime,
              },
            );
            continue;
          }

          let fetched: {
            audio: Blob;
            usedFallbackVoice: boolean;
            cachedSpeed: number | null;
            key: string;
          };
          try {
            fetched = await (nextPrefetch ?? fetchChunk(chunk.text));
            nextPrefetch = null;
            this.ensure(operation);
          } catch (error) {
            nextPrefetch = null;
            this.ensure(operation);
            if (isAbort(error)) throw error;
            if (canUseAllowedDeviceFallbackTts(operation, error)) {
              useBrowserFallback = true;
              recordActualUtterance({
                provider: isAndroidNativeSpeechAvailable()
                  ? "android_native"
                  : "browser",
                voiceId: isAndroidNativeSpeechAvailable()
                  ? "android_vi_vn"
                  : operation.voice.cacheVoiceId,
              });
              elapsed += await this.playDeviceFallbackSpeech(
                operation,
                chunk.text,
                {
                  onStart,
                  onTime,
                },
              );
              continue;
            }
            this.setFallbackNotice(getLockedVoiceUnavailableNotice());
            throw unavailable();
          }

          const servedMeta = getSynthesizedAudioMeta(fetched.audio);
          recordActualUtterance({
            provider: servedMeta?.provider ?? operation.voice.provider,
            voiceId:
              servedMeta?.resolvedVoiceId ?? operation.voice.cacheVoiceId,
            region: servedMeta?.region ?? operation.voice.region,
            modelVersion:
              servedMeta?.modelVersion ?? operation.voice.modelVersion,
          });

          // Prefetch the next sentence in parallel while the current sentence plays!
          if (idx + 1 < chunks.length) {
            nextPrefetch = fetchChunk(chunks[idx + 1].text);
            // Suppress unhandled rejection if playback aborts before nextPrefetch is awaited
            nextPrefetch.catch(() => undefined);
          }

          this.setFallbackNotice(
            fetched.usedFallbackVoice ? getServerFallbackVoiceNotice() : null,
          );
          try {
            const playbackRate = computeEffectivePlaybackRate(
              operation.voice.speed,
              fetched.cachedSpeed,
            );
            elapsed += await this.playAudio(
              operation,
              fetched.audio,
              undefined,
              0,
              onStart,
              undefined,
              onTime,
              playbackRate,
            );
          } catch (error) {
            this.ensure(operation);
            if (isAbort(error) || error instanceof PartialPlaybackError)
              throw error;
            if (isNotAllowedError(error)) {
              // Autoplay gesture blocked: keep valid cached audio intact and prompt tap-to-play.
              this.setFallbackNotice(AUTOPLAY_BLOCKED_NOTICE);
              throw error;
            }
            const existingShort = this.shortCache.get(fetched.key);
            if (existingShort) {
              this.shortCacheBytes = Math.max(
                0,
                this.shortCacheBytes - existingShort.audio.size,
              );
              this.shortCache.delete(fetched.key);
            }
            if (error instanceof CompressedAudioDecodeError) {
              try {
                const wavRetry = await fetchChunk(chunk.text, "wav");
                if (
                  wavRetry.audio.type.trim().length > 0 &&
                  !isWavAudioBlob(wavRetry.audio)
                ) {
                  this.setFallbackNotice(getLockedVoiceUnavailableNotice());
                  throw unavailable();
                }
                this.setFallbackNotice(
                  wavRetry.usedFallbackVoice
                    ? getServerFallbackVoiceNotice()
                    : null,
                );
                const wavPlaybackRate = computeEffectivePlaybackRate(
                  operation.voice.speed,
                  wavRetry.cachedSpeed,
                );
                elapsed += await this.playAudio(
                  operation,
                  wavRetry.audio,
                  undefined,
                  0,
                  onStart,
                  undefined,
                  onTime,
                  wavPlaybackRate,
                );
                continue;
              } catch (wavError) {
                this.ensure(operation);
                if (
                  isAbort(wavError) ||
                  isNotAllowedError(wavError) ||
                  wavError instanceof PartialPlaybackError
                ) {
                  if (isNotAllowedError(wavError)) {
                    this.setFallbackNotice(AUTOPLAY_BLOCKED_NOTICE);
                  }
                  throw wavError;
                }
                this.setFallbackNotice(getLockedVoiceUnavailableNotice());
                throw unavailable();
              }
            }
            this.setFallbackNotice(getLockedVoiceUnavailableNotice());
            throw error;
          }
        }
        this.ensure(operation);
        options.onEnded?.();
      },
      Infinity,
      options.speedScale,
      Boolean(
        options.bypassSessionLock ||
        this.defaultCacheContext?.bypassSessionLock,
      ),
      options.utteranceKind,
    );

  playPhonicsLesson = (
    lesson: SupportedPhonicsLessonPlan,
    options: PhonicsPlayOptions = {},
  ): Promise<void> =>
    this.run(
      async (operation) => {
        if (!lesson.steps.length) throw unavailable();
        const phonicsPreview = lesson.steps.map((s) => s.spokenText).join(" ");
        let phonicsAudited = false;
        const recordPhonicsUtterance = (served?: {
          readonly provider?: string | null;
          readonly voiceId?: string | null;
          readonly region?: string | null;
          readonly modelVersion?: string | null;
        }) => {
          if (phonicsAudited) return;
          phonicsAudited = true;
          this.auditUtterance(
            operation,
            "phonics_lesson",
            phonicsPreview,
            served,
          );
        };

        const playPhonicsViaBrowser = async () => {
          recordPhonicsUtterance({
            provider: isAndroidNativeSpeechAvailable()
              ? "android_native"
              : "browser",
            voiceId: isAndroidNativeSpeechAvailable()
              ? "android_vi_vn"
              : operation.voice.cacheVoiceId,
          });
          let browserElapsed = 0;
          for (const step of lesson.steps) {
            await this.waitIfPaused(operation);
            this.ensure(operation);
            options.onStepChange?.(step.index, step);
            browserElapsed += await this.playDeviceFallbackSpeech(
              operation,
              step.spokenText.normalize("NFC"),
              {
                onStart: (duration) =>
                  this.started(operation, () => options.onPlay?.(duration)),
                onTime: (time, duration) =>
                  options.onTimeUpdate?.(
                    browserElapsed + time,
                    browserElapsed + duration,
                  ),
              },
            );
            await this.wait(
              operation,
              new Promise<void>((resolve) => {
                window.setTimeout(resolve, Math.min(250, step.pauseAfterMs));
              }),
            );
          }
          this.ensure(operation);
          options.onEnded?.();
        };

        const hasPhonicsCacheTarget = Boolean(
          options.bookId ||
          options.pageId ||
          options.pageRevisionId ||
          options.cacheScope === "CATALOG" ||
          options.cacheScope === "COACHING" ||
          this.defaultCacheContext?.bookId ||
          this.defaultCacheContext?.pageId ||
          this.defaultCacheContext?.pageRevisionId,
        );
        if (
          shouldSkipBackendTtsForBrowserFallback(
            operation,
            hasPhonicsCacheTarget,
          )
        ) {
          await playPhonicsViaBrowser();
          return;
        }

        const phonicsKey = JSON.stringify([
          operation.voice.provider,
          operation.voice.cacheVoiceId,
          operation.voice.modelVersion,
          operation.voice.speed,
          lesson.steps.map((s) => [
            s.id,
            s.spokenText.normalize("NFC"),
            s.pauseAfterMs,
          ]),
        ]);

        const tryPlayPhonicsViaCachedWordSynthesize =
          async (): Promise<boolean> => {
            const wholeStep =
              lesson.steps.find((s) => s.kind === "whole_syllable") ??
              lesson.steps[lesson.steps.length - 1];
            if (!wholeStep) return false;
            const focusWord = normalizeVietnameseWord(
              lesson.focusSyllable || wholeStep.spokenText,
            );
            const syllableCandidates = lesson.syllables
              .map((s) => normalizeVietnameseWord(s))
              .filter(Boolean);
            const wordList =
              syllableCandidates.length > 1
                ? syllableCandidates
                : focusWord
                  ? [focusWord]
                  : [];
            if (!wordList.length) return false;

            const wordCacheMeta = this.resolveCacheMeta(
              { ...options, cacheScope: undefined, coaching: false },
              "CATALOG",
              true,
            );
            const fetchSingleWord = async (
              word: string,
            ): Promise<{
              readonly audio: Blob;
              readonly cachedSpeed: number | null;
              readonly key: string;
            } | null> => {
              const stepKey = JSON.stringify([
                operation.voice.provider,
                operation.voice.cacheVoiceId,
                operation.voice.modelVersion,
                operation.voice.speed,
                word,
                true,
              ]);
              const cached = this.shortCache.get(stepKey);
              if (cached) {
                return {
                  audio: cached.audio,
                  cachedSpeed: cached.cachedSpeed,
                  key: stepKey,
                };
              }
              try {
                let blob = await this.wait(
                  operation,
                  this.speech.synthesize(word, {
                    voiceId: operation.voice.requestedVoiceId ?? undefined,
                    speed: operation.voice.speed,
                    wordSample: true,
                    ...(operation.voice.bypassSessionLock
                      ? { bypassSessionLock: true }
                      : {}),
                    ...wordCacheMeta,
                    signal: operation.controller.signal,
                  }),
                );
                this.ensure(operation);
                const meta = getSynthesizedAudioMeta(blob);
                const cachedSpeed = meta?.cachedSpeed ?? null;
                blob = await this.wait(operation, prepareWordSampleAudio(blob));
                if (meta) {
                  setSynthesizedAudioMeta(blob, meta);
                }
                this.cacheShort(stepKey, {
                  audio: blob,
                  usedFallbackVoice: Boolean(meta?.usedFallbackVoice),
                  cachedSpeed,
                });
                return { audio: blob, cachedSpeed, key: stepKey };
              } catch (err) {
                this.ensure(operation);
                if (isAbort(err)) throw err;
                return null;
              }
            };

            const parallelResults = await Promise.all(
              wordList.map((word) => fetchSingleWord(word)),
            );
            const fetchedBlobs = parallelResults.filter(
              (
                item,
              ): item is {
                readonly audio: Blob;
                readonly cachedSpeed: number | null;
                readonly key: string;
              } => item !== null,
            );
            if (!fetchedBlobs.length && focusWord && wordList.length > 1) {
              const focusItem = await fetchSingleWord(focusWord);
              if (focusItem) fetchedBlobs.push(focusItem);
            }
            if (!fetchedBlobs.length) return false;

            this.setFallbackNotice(null);
            let fallbackElapsed = 0;
            let activeItem: {
              readonly audio: Blob;
              readonly cachedSpeed: number | null;
              readonly key: string;
            } | null = null;
            try {
              for (let i = 0; i < fetchedBlobs.length; i += 1) {
                await this.waitIfPaused(operation);
                this.ensure(operation);
                const item = fetchedBlobs[i];
                activeItem = item;
                const rate = computeEffectivePlaybackRate(
                  operation.voice.speed,
                  item.cachedSpeed,
                );
                fallbackElapsed += await this.playAudio(
                  operation,
                  item.audio,
                  undefined,
                  0,
                  (duration) =>
                    this.started(operation, () => {
                      options.onPlay?.(duration);
                      options.onStepChange?.(wholeStep.index, wholeStep);
                    }),
                  undefined,
                  (time, duration) =>
                    options.onTimeUpdate?.(
                      fallbackElapsed + time,
                      fallbackElapsed + duration,
                    ),
                  rate,
                );
              }
            } catch (playFallbackError) {
              this.ensure(operation);
              if (
                isAbort(playFallbackError) ||
                playFallbackError instanceof PartialPlaybackError
              ) {
                throw playFallbackError;
              }
              if (activeItem) {
                const cachedEntry = this.shortCache.get(activeItem.key);
                if (cachedEntry && cachedEntry.audio === activeItem.audio) {
                  this.shortCacheBytes = Math.max(
                    0,
                    this.shortCacheBytes - cachedEntry.audio.size,
                  );
                  this.shortCache.delete(activeItem.key);
                }
              }
              if (fallbackElapsed > 0) {
                throw playFallbackError;
              }
              return false;
            }
            this.ensure(operation);
            options.onEnded?.();
            return true;
          };

        // Preferred path: single combined step-timed WAV from `/voice/text-to-speech/phonics`
        if (this.speech.synthesizePhonics) {
          const makePhonicsKey = () =>
            JSON.stringify([
              operation.voice.provider,
              operation.voice.cacheVoiceId,
              operation.voice.modelVersion,
              operation.voice.speed,
              lesson.steps.map((s) => [
                s.id,
                s.spokenText.normalize("NFC"),
                s.pauseAfterMs,
              ]),
            ]);
          const normalizedSteps = lesson.steps.map((s) => ({
            id: s.id,
            spokenText: s.spokenText.normalize("NFC"),
            pauseAfterMs: s.pauseAfterMs,
          }));
          const phonicsCacheMeta = this.resolveCacheMeta(
            options,
            options.cacheScope ?? "COACHING",
            true,
          );
          let synthesized = this.phonicsCache.get(phonicsKey);
          if (!synthesized) {
            try {
              synthesized = await this.wait(
                operation,
                this.speech.synthesizePhonics(normalizedSteps, {
                  voiceId: operation.voice.requestedVoiceId ?? undefined,
                  speed: operation.voice.speed,
                  ...(operation.voice.bypassSessionLock
                    ? { bypassSessionLock: true }
                    : {}),
                  ...phonicsCacheMeta,
                  signal: operation.controller.signal,
                }),
              );
              this.ensure(operation);
              this.cachePhonics(phonicsKey, synthesized);
            } catch (error) {
              this.ensure(operation);
              if (isAbort(error)) throw error;
              if (canUseGoogleTtsFallback()) {
                if (shouldRetryBackendWithGoogleTts(operation, error)) {
                  if (operation.voice.sessionId) {
                    approveSessionVoiceSwitch(operation.voice.sessionId);
                  }
                  const googleVoiceId = mapLocalVoiceToGoogleBackup(
                    operation.voice.requestedVoiceId,
                    operation.voice.region,
                  );
                  try {
                    synthesized = await this.wait(
                      operation,
                      this.speech.synthesizePhonics(normalizedSteps, {
                        voiceId: googleVoiceId,
                        speed: operation.voice.speed,
                        ...(operation.voice.bypassSessionLock
                          ? { bypassSessionLock: true }
                          : {}),
                        ...phonicsCacheMeta,
                        signal: operation.controller.signal,
                      }),
                    );
                    this.ensure(operation);
                    this.promoteOperationToGoogleVoice(
                      operation,
                      googleVoiceId,
                    );
                    this.cachePhonics(makePhonicsKey(), synthesized);
                  } catch (googleError) {
                    this.ensure(operation);
                    if (isAbort(googleError)) throw googleError;
                  }
                }
              }
              if (!synthesized) {
                if (canUseAllowedDeviceFallbackTts(operation, error)) {
                  await playPhonicsViaBrowser();
                  return;
                }
                if (await tryPlayPhonicsViaCachedWordSynthesize()) {
                  return;
                }
                this.setFallbackNotice(getLockedVoiceUnavailableNotice());
                throw unavailable();
              }
            }
          }

          const activePhonics = synthesized;
          recordPhonicsUtterance({
            provider: activePhonics.provider,
            voiceId: activePhonics.resolvedVoiceId,
            region: activePhonics.region,
            modelVersion: activePhonics.modelVersion,
          });
          this.setFallbackNotice(null);
          let lastEmittedStep = -1;
          const emitStepForTime = (
            phonics: SynthesizedPhonicsSpeech,
            currentTime: number,
          ) => {
            const idx = findActivePhonicsStepIndex(
              phonics.stepTimings,
              currentTime,
            );
            if (idx >= 0 && idx !== lastEmittedStep && lesson.steps[idx]) {
              lastEmittedStep = idx;
              options.onStepChange?.(idx, lesson.steps[idx]);
            }
          };

          const phonicsPlaybackRate = computeEffectivePlaybackRate(
            operation.voice.speed,
            activePhonics.cachedSpeed ??
              getSynthesizedAudioMeta(activePhonics.audio)?.cachedSpeed,
          );
          try {
            await this.playAudio(
              operation,
              activePhonics.audio,
              undefined,
              0,
              (duration) =>
                this.started(operation, () => {
                  options.onPlay?.(duration);
                  emitStepForTime(activePhonics, 0);
                }),
              undefined,
              (currentTime, duration) => {
                emitStepForTime(activePhonics, currentTime);
                options.onTimeUpdate?.(currentTime, duration);
              },
              phonicsPlaybackRate,
            );
          } catch (playErr) {
            this.ensure(operation);
            if (isNotAllowedError(playErr)) {
              this.setFallbackNotice(AUTOPLAY_BLOCKED_NOTICE);
              throw playErr;
            }
            if (
              playErr instanceof CompressedAudioDecodeError &&
              this.speech.synthesizePhonics
            ) {
              const stale = this.phonicsCache.get(phonicsKey);
              if (stale) {
                this.phonicsCacheBytes = Math.max(
                  0,
                  this.phonicsCacheBytes - stale.audio.size,
                );
                this.phonicsCache.delete(phonicsKey);
              }
              const wavPhonics = await this.wait(
                operation,
                this.speech.synthesizePhonics(normalizedSteps, {
                  voiceId: operation.voice.requestedVoiceId ?? undefined,
                  speed: operation.voice.speed,
                  audioFormat: "wav",
                  ...(operation.voice.bypassSessionLock
                    ? { bypassSessionLock: true }
                    : {}),
                  ...phonicsCacheMeta,
                  signal: operation.controller.signal,
                }),
              );
              this.ensure(operation);
              if (
                wavPhonics.audio.type.trim().length > 0 &&
                !isWavAudioBlob(wavPhonics.audio)
              ) {
                throw unavailable();
              }
              this.cachePhonics(makePhonicsKey(), wavPhonics);
              const wavPhonicsPlaybackRate = computeEffectivePlaybackRate(
                operation.voice.speed,
                wavPhonics.cachedSpeed ??
                  getSynthesizedAudioMeta(wavPhonics.audio)?.cachedSpeed,
              );
              await this.playAudio(
                operation,
                wavPhonics.audio,
                undefined,
                0,
                (duration) =>
                  this.started(operation, () => {
                    options.onPlay?.(duration);
                    emitStepForTime(wavPhonics, 0);
                  }),
                undefined,
                (currentTime, duration) => {
                  emitStepForTime(wavPhonics, currentTime);
                  options.onTimeUpdate?.(currentTime, duration);
                },
                wavPhonicsPlaybackRate,
              );
            } else {
              throw playErr;
            }
          }
          this.ensure(operation);
          options.onEnded?.();
          return;
        }

        // Fallback for unit-test mocks that only implement `speech.synthesize`:
        // plays each step sequentially in the exact same locked voice with deterministic pauses.
        let elapsed = 0;
        for (const step of lesson.steps) {
          await this.waitIfPaused(operation);
          this.ensure(operation);
          const stepKey = JSON.stringify([
            operation.voice.provider,
            operation.voice.cacheVoiceId,
            operation.voice.modelVersion,
            operation.voice.speed,
            step.spokenText.normalize("NFC"),
            true,
          ]);
          const cachedStep = this.shortCache.get(stepKey);
          let stepBlob = cachedStep?.audio ?? null;
          let stepCachedSpeed = cachedStep?.cachedSpeed ?? null;
          if (!stepBlob) {
            try {
              const stepCacheMeta = this.resolveCacheMeta(
                options,
                options.cacheScope ?? "COACHING",
                true,
              );
              stepBlob = await this.wait(
                operation,
                this.speech.synthesize(step.spokenText.normalize("NFC"), {
                  voiceId: operation.voice.requestedVoiceId ?? undefined,
                  speed: operation.voice.speed,
                  wordSample: true,
                  ...(operation.voice.bypassSessionLock
                    ? { bypassSessionLock: true }
                    : {}),
                  ...stepCacheMeta,
                  signal: operation.controller.signal,
                }),
              );
              this.ensure(operation);
              stepCachedSpeed =
                getSynthesizedAudioMeta(stepBlob)?.cachedSpeed ?? null;
              this.cacheShort(stepKey, {
                audio: stepBlob,
                usedFallbackVoice: false,
                cachedSpeed: stepCachedSpeed,
              });
            } catch (error) {
              this.ensure(operation);
              if (isAbort(error)) throw error;
              if (canUseAllowedDeviceFallbackTts(operation, error)) {
                options.onStepChange?.(step.index, step);
                elapsed += await this.playDeviceFallbackSpeech(
                  operation,
                  step.spokenText.normalize("NFC"),
                  {
                    onStart: (duration) =>
                      this.started(operation, () => options.onPlay?.(duration)),
                    onTime: (time, duration) =>
                      options.onTimeUpdate?.(
                        elapsed + time,
                        elapsed + duration,
                      ),
                  },
                );
                await this.wait(
                  operation,
                  new Promise<void>((resolve) => {
                    window.setTimeout(
                      resolve,
                      Math.min(200, step.pauseAfterMs),
                    );
                  }),
                );
                continue;
              }
              this.setFallbackNotice(getLockedVoiceUnavailableNotice());
              throw unavailable();
            }
          }

          this.setFallbackNotice(null);
          options.onStepChange?.(step.index, step);
          elapsed += await this.playAudio(
            operation,
            stepBlob,
            undefined,
            0,
            (duration) =>
              this.started(operation, () => options.onPlay?.(duration)),
            undefined,
            (time, duration) =>
              options.onTimeUpdate?.(elapsed + time, elapsed + duration),
            computeEffectivePlaybackRate(
              operation.voice.speed,
              stepCachedSpeed,
            ),
          );
          await this.wait(
            operation,
            new Promise<void>((resolve) => {
              window.setTimeout(resolve, Math.min(200, step.pauseAfterMs));
            }),
          );
        }
        this.ensure(operation);
        options.onEnded?.();
      },
      Infinity,
      options.speedScale,
      Boolean(
        options.bypassSessionLock ||
        this.defaultCacheContext?.bypassSessionLock,
      ),
      "phonics_lesson",
    );

  playWithWordTimings = (
    words: readonly string[],
    options: WordTimedPlayOptions,
    fallback?: () => Promise<void>,
  ): Promise<void> =>
    this.run(
      async (operation) => {
        const text = (options.text ?? words.join(" ")).normalize("NFC");
        if (!text.trim()) throw unavailable();
        let timedAudited = false;
        const recordTimedUtterance = (served?: {
          readonly provider?: string | null;
          readonly voiceId?: string | null;
          readonly region?: string | null;
          readonly modelVersion?: string | null;
        }) => {
          if (timedAudited) return;
          timedAudited = true;
          this.auditUtterance(operation, "page_sample", text, served);
        };

        const canMap = hasMatchingSpeechWords(text, words);
        if (!canMap) options.onWordChange?.(-1);
        const requireWordTimings =
          Boolean(options.onWordChange) &&
          !options.precomputedWordTimings?.length;

        // Tier 1: Precomputed verified-catalog MP3 URL — strictly gated on
        // exact DEFAULT_LOCAL_VOICE_ID, public catalog book, and !requireWordTimings.
        if (
          this.canUsePrecomputedCatalogUrl(
            operation,
            options,
            requireWordTimings,
          )
        ) {
          const precomputedBlob = await fetchPrecomputedCatalogAudio(
            options.precomputedAudioUrl!,
            operation.controller.signal,
          );
          this.ensure(operation);
          if (precomputedBlob) {
            recordTtsEngineUsage({
              provider: "catalog_cache",
              fallbackUsed: false,
              fallbackReason: null,
              voiceId: operation.voice.requestedVoiceId,
              voiceGender: resolveVoiceGender(operation.voice.requestedVoiceId),
            });
            recordTimedUtterance({
              provider: "local",
              voiceId:
                options.precomputedVoiceId?.trim() || DEFAULT_LOCAL_VOICE_ID,
            });
            this.setFallbackNotice(null);
            try {
              const precomputedPlaybackRate = computeEffectivePlaybackRate(
                operation.voice.speed,
                options.precomputedCachedSpeed ??
                  inferPrecomputedCatalogUrlSpeed(options.precomputedAudioUrl),
              );
              await this.playAudio(
                operation,
                precomputedBlob,
                options.precomputedWordTimings ?? undefined,
                0,
                () =>
                  this.started(operation, () => {
                    options.onPlay?.();
                    if (
                      (!canMap || !options.precomputedWordTimings?.length) &&
                      options.onPlay
                    ) {
                      options.onWordChange?.(-1);
                    }
                  }),
                (index) => {
                  if (canMap) options.onWordChange?.(index);
                },
                undefined,
                precomputedPlaybackRate,
              );
              this.ensure(operation);
              options.onEnded?.();
              return;
            } catch (precomputedError) {
              this.ensure(operation);
              if (
                isAbort(precomputedError) ||
                isNotAllowedError(precomputedError) ||
                precomputedError instanceof PartialPlaybackError
              ) {
                if (isNotAllowedError(precomputedError)) {
                  this.setFallbackNotice(AUTOPLAY_BLOCKED_NOTICE);
                }
                throw precomputedError;
              }
              // Fall through cleanly to Tier 2/3/4.
            }
          }
        }

        let elapsed = 0;
        let completedChunks = 0;
        const hasTimedCacheTarget = Boolean(
          options.bookId ||
          options.pageId ||
          options.pageRevisionId ||
          options.cacheScope === "CATALOG" ||
          options.cacheScope === "COACHING" ||
          this.defaultCacheContext?.bookId ||
          this.defaultCacheContext?.pageId ||
          this.defaultCacheContext?.pageRevisionId,
        );
        let useBrowserFallback = shouldSkipBackendTtsForBrowserFallback(
          operation,
          hasTimedCacheTarget,
        );
        const chunks = splitSpeechText(text);
        const timedCacheMeta = this.resolveCacheMeta(options, "CATALOG", true);
        const makeTimedKeyForWords = (chunkWords: readonly string[]) =>
          JSON.stringify([
            operation.voice.provider,
            operation.voice.cacheVoiceId,
            operation.voice.modelVersion,
            operation.voice.speed,
            chunkWords,
          ]);
        const fetchTimedChunk = async (
          chunkWords: readonly string[],
          audioFormat?: TtsAudioFormat,
        ): Promise<TimedSpeech> => {
          const key = makeTimedKeyForWords(chunkWords);
          if (audioFormat === undefined) {
            const cached = this.cache.get(key);
            if (cached) return cached;
          }
          let timed: TimedSpeech;
          try {
            timed = await this.wait(
              operation,
              this.studio.synthesizeTimed(chunkWords, {
                voiceId: operation.voice.requestedVoiceId,
                speed: operation.voice.speed,
                ...(audioFormat ? { audioFormat } : {}),
                ...(operation.voice.bypassSessionLock
                  ? { bypassSessionLock: true }
                  : {}),
                ...timedCacheMeta,
                signal: operation.controller.signal,
              }),
            );
          } catch (synthError) {
            this.ensure(operation);
            if (isAbort(synthError)) throw synthError;
            if (shouldRetryBackendWithGoogleTts(operation, synthError)) {
              if (operation.voice.sessionId) {
                approveSessionVoiceSwitch(operation.voice.sessionId);
              }
              const googleVoiceId = mapLocalVoiceToGoogleBackup(
                operation.voice.requestedVoiceId,
                operation.voice.region,
              );
              timed = await this.wait(
                operation,
                this.studio.synthesizeTimed(chunkWords, {
                  voiceId: googleVoiceId,
                  speed: operation.voice.speed,
                  ...(audioFormat ? { audioFormat } : {}),
                  ...(operation.voice.bypassSessionLock
                    ? { bypassSessionLock: true }
                    : {}),
                  ...timedCacheMeta,
                  signal: operation.controller.signal,
                }),
              );
              this.ensure(operation);
              this.promoteOperationToGoogleVoice(operation, googleVoiceId);
            } else {
              throw synthError;
            }
          }
          this.ensure(operation);
          this.timedCooldownUntil = 0;
          this.cacheTimed(makeTimedKeyForWords(chunkWords), timed);
          return timed;
        };

        let nextTimedPrefetch: Promise<TimedSpeech> | null = null;
        for (let idx = 0; idx < chunks.length; idx += 1) {
          const chunk = chunks[idx];
          await this.waitIfPaused(operation);
          this.ensure(operation);
          const onStart = () =>
            this.started(operation, () => {
              options.onPlay?.();
              if (!canMap && options.onPlay) options.onWordChange?.(-1);
            });
          const onWord = (index: number) => {
            if (canMap) options.onWordChange?.(chunk.wordOffset + index);
          };
          if (useBrowserFallback) {
            nextTimedPrefetch = null;
            elapsed += await this.playDeviceFallbackSpeech(
              operation,
              chunk.words.join(" "),
              {
                words: chunk.words,
                onStart: () => onStart(),
                onWord,
              },
            );
            completedChunks += 1;
            continue;
          }
          const key = makeTimedKeyForWords(chunk.words);
          let synthesizedTimedOk = false;
          try {
            let timed = this.cache.get(key);
            if (!timed) {
              if (
                !nextTimedPrefetch &&
                fallback &&
                !canUseGoogleTtsFallback() &&
                Date.now() < this.timedCooldownUntil
              ) {
                await fallback();
                return;
              }
              timed = await (nextTimedPrefetch ?? fetchTimedChunk(chunk.words));
            }
            nextTimedPrefetch = null;
            this.ensure(operation);
            synthesizedTimedOk = true;
            const timedMeta = getSynthesizedAudioMeta(timed.audio);
            recordTimedUtterance({
              provider: timedMeta?.provider ?? operation.voice.provider,
              voiceId:
                timed.resolvedVoiceId ??
                timedMeta?.resolvedVoiceId ??
                operation.voice.cacheVoiceId,
              region: timedMeta?.region ?? operation.voice.region,
              modelVersion:
                timedMeta?.modelVersion ?? operation.voice.modelVersion,
            });
            this.setFallbackNotice(
              timed.usedFallbackVoice ? getServerFallbackVoiceNotice() : null,
            );
            // Prefetch the next timed chunk in parallel once playback of the
            // current chunk is underway so multi-chunk pages have zero
            // inter-chunk synthesis stalls without wasting synthesis if stopped
            // immediately or failing autoplay.
            let prefetchedNextChunk = false;
            const maybePrefetchNextChunk =
              idx + 1 < chunks.length
                ? (currentTime: number, duration: number) => {
                    if (
                      prefetchedNextChunk ||
                      operation.controller.signal.aborted
                    ) {
                      return;
                    }
                    if (
                      currentTime > 0 &&
                      (currentTime >= 1.0 ||
                        (Number.isFinite(duration) &&
                          duration > 0 &&
                          currentTime / duration >= 0.25))
                    ) {
                      prefetchedNextChunk = true;
                      nextTimedPrefetch = fetchTimedChunk(
                        chunks[idx + 1].words,
                      );
                      nextTimedPrefetch.catch(() => undefined);
                    }
                  }
                : undefined;
            try {
              const timedPlaybackRate = computeEffectivePlaybackRate(
                operation.voice.speed,
                timed.cachedSpeed,
              );
              elapsed += await this.playAudio(
                operation,
                timed.audio,
                timed.words,
                elapsed,
                onStart,
                onWord,
                maybePrefetchNextChunk,
                timedPlaybackRate,
              );
            } catch (playErr) {
              this.ensure(operation);
              if (isNotAllowedError(playErr)) {
                this.setFallbackNotice(AUTOPLAY_BLOCKED_NOTICE);
                throw playErr;
              }
              if (playErr instanceof CompressedAudioDecodeError) {
                const stale = this.cache.get(key);
                if (stale) {
                  this.cacheBytes = Math.max(
                    0,
                    this.cacheBytes - stale.audio.size,
                  );
                  this.cache.delete(key);
                }
                const wavTimed = await fetchTimedChunk(chunk.words, "wav");
                this.ensure(operation);
                if (
                  wavTimed.audio.type.trim().length > 0 &&
                  !isWavAudioBlob(wavTimed.audio)
                ) {
                  throw unavailable();
                }
                const wavTimedPlaybackRate = computeEffectivePlaybackRate(
                  operation.voice.speed,
                  wavTimed.cachedSpeed,
                );
                elapsed += await this.playAudio(
                  operation,
                  wavTimed.audio,
                  wavTimed.words,
                  elapsed,
                  onStart,
                  onWord,
                  undefined,
                  wavTimedPlaybackRate,
                );
              } else {
                throw playErr;
              }
            }
          } catch (error) {
            nextTimedPrefetch = null;
            this.ensure(operation);
            if (isAbort(error) || error instanceof PartialPlaybackError)
              throw error;
            if (isNotAllowedError(error)) {
              // Autoplay blocked: NEVER evict valid cached audio or trigger timedCooldownUntil!
              this.setFallbackNotice(AUTOPLAY_BLOCKED_NOTICE);
              throw error;
            }
            const invalid = this.cache.get(key);
            if (invalid) {
              this.cacheBytes = Math.max(
                0,
                this.cacheBytes - invalid.audio.size,
              );
              this.cache.delete(key);
            }
            const errProviderCode =
              typeof error === "object" && error !== null
                ? ((
                    error as {
                      provider_code?: unknown;
                      providerCode?: unknown;
                    }
                  ).provider_code ??
                  (error as { providerCode?: unknown }).providerCode)
                : undefined;
            const isUnconfiguredLocalErr =
              errProviderCode === "LOCAL_VOICE_UNCONFIGURED";
            // Prefer the same locked voice via the short endpoint before
            // switching providers, unless local worker is unconfigured without
            // a precomputed public catalog URL (avoiding a duplicate 503 roundtrip).
            if (
              !completedChunks &&
              fallback &&
              !(isUnconfiguredLocalErr && !options.precomputedAudioUrl)
            ) {
              this.timedCooldownUntil = Date.now() + 15_000;
              await fallback();
              return;
            }
            if (
              (!synthesizedTimedOk || !fallback) &&
              canUseAllowedDeviceFallbackTts(operation, error)
            ) {
              useBrowserFallback = true;
              elapsed += await this.playDeviceFallbackSpeech(
                operation,
                chunk.words.join(" "),
                {
                  words: chunk.words,
                  onStart: () => onStart(),
                  onWord,
                },
              );
              completedChunks += 1;
              continue;
            }
            this.timedCooldownUntil = Date.now() + 15_000;
            this.setFallbackNotice(getLockedVoiceUnavailableNotice());
            throw unavailable();
          }
          completedChunks += 1;
        }
        this.ensure(operation);
        options.onEnded?.();
      },
      Infinity,
      1,
      Boolean(
        options.bypassSessionLock ||
        this.defaultCacheContext?.bypassSessionLock,
      ),
      options.utteranceKind,
    );

  private cacheShort(
    key: string,
    entry: {
      readonly audio: Blob;
      readonly usedFallbackVoice: boolean;
      readonly cachedSpeed: number | null;
    },
  ): void {
    if (entry.audio.size > 4 * 1024 * 1024) return;
    const prev = this.shortCache.get(key);
    if (prev) {
      this.shortCacheBytes = Math.max(
        0,
        this.shortCacheBytes - prev.audio.size,
      );
      this.shortCache.delete(key);
    }
    this.shortCache.set(key, entry);
    this.shortCacheBytes += entry.audio.size;
    while (
      this.shortCache.size > 24 ||
      this.shortCacheBytes > 12 * 1024 * 1024
    ) {
      const first = this.shortCache.keys().next().value;
      if (first === undefined) break;
      this.shortCacheBytes = Math.max(
        0,
        this.shortCacheBytes - (this.shortCache.get(first)?.audio.size ?? 0),
      );
      this.shortCache.delete(first);
    }
  }

  private cacheTimed(key: string, speech: TimedSpeech): void {
    if (speech.audio.size > 8 * 1024 * 1024) return;
    const prev = this.cache.get(key);
    if (prev) {
      this.cacheBytes = Math.max(0, this.cacheBytes - prev.audio.size);
      this.cache.delete(key);
    }
    this.cache.set(key, speech);
    this.cacheBytes += speech.audio.size;
    while (this.cache.size > 6 || this.cacheBytes > 16 * 1024 * 1024) {
      const first = this.cache.keys().next().value;
      if (first === undefined) break;
      this.cacheBytes = Math.max(
        0,
        this.cacheBytes - (this.cache.get(first)?.audio.size ?? 0),
      );
      this.cache.delete(first);
    }
  }

  private cachePhonics(key: string, speech: SynthesizedPhonicsSpeech): void {
    if (speech.audio.size > 6 * 1024 * 1024) return;
    const prev = this.phonicsCache.get(key);
    if (prev) {
      this.phonicsCacheBytes = Math.max(
        0,
        this.phonicsCacheBytes - prev.audio.size,
      );
      this.phonicsCache.delete(key);
    }
    this.phonicsCache.set(key, speech);
    this.phonicsCacheBytes += speech.audio.size;
    while (
      this.phonicsCache.size > 16 ||
      this.phonicsCacheBytes > 12 * 1024 * 1024
    ) {
      const first = this.phonicsCache.keys().next().value;
      if (first === undefined) break;
      this.phonicsCacheBytes = Math.max(
        0,
        this.phonicsCacheBytes -
          (this.phonicsCache.get(first)?.audio.size ?? 0),
      );
      this.phonicsCache.delete(first);
    }
  }

  private async playAudio(
    operation: Operation,
    source: Blob | string,
    timeline: readonly WordTiming[] | undefined,
    offset: number,
    onStart: (duration: number) => void,
    onWord?: (index: number) => void,
    onTime?: (time: number, duration: number) => void,
    playbackRate = 1,
  ): Promise<number> {
    this.ensure(operation);
    if (
      typeof source !== "string" &&
      (!source.size || !source.type.startsWith("audio/"))
    )
      throw unavailable();
    await this.waitIfPaused(operation);
    this.ensure(operation);
    const url =
      typeof source === "string" ? source : URL.createObjectURL(source);
    const releaseUrl = () => {
      if (typeof source !== "string") URL.revokeObjectURL(url);
    };
    const borrowedAudio = canReuseUnlockedMobileAudio()
      ? acquireUnlockedAudioElement()
      : null;
    let audio: HTMLAudioElement;
    const applyPlaybackRate = (el: HTMLAudioElement) => {
      // Exact speed matches use playbackRate=1; speed-fallback cache hits scale
      // cleanly to requestedSpeed / cachedSpeed while preserving pitch and word timings.
      el.defaultPlaybackRate = playbackRate;
      el.playbackRate = playbackRate;
      el.preservesPitch = true;
    };
    try {
      if (borrowedAudio) {
        audio = borrowedAudio.audio;
        audio.muted = false;
        audio.src = url;
      } else {
        audio = new Audio(url);
      }
      applyPlaybackRate(audio);
      audio.volume = 1;
      this.ensure(operation);
    } catch (error) {
      borrowedAudio?.release();
      releaseUrl();
      throw error;
    }
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let lastIndex = -1;
      let validated = !timeline;
      let lastObservedAudioTime = audio.currentTime;
      let lastProgressAt = Date.now();
      let stallWatchdogTimer: number | null = null;
      const absolute = timeline?.map((word) => ({
        ...word,
        start: word.start + offset,
        end: word.end + offset,
      }));
      const signal = operation.controller.signal;
      const active = () =>
        !settled && this.current === operation && !signal.aborted;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (stallWatchdogTimer !== null) {
          window.clearInterval(stallWatchdogTimer);
          stallWatchdogTimer = null;
        }
        const duration = Number.isFinite(audio.duration)
          ? audio.duration
          : (timeline?.at(-1)?.end ?? 0);
        signal.removeEventListener("abort", abort);
        this.cancelFrame();
        if (this.media === media) this.media = null;
        audio.onended =
          audio.onerror =
          audio.ontimeupdate =
          audio.onloadedmetadata =
          audio.onstalled =
          audio.onwaiting =
            null;
        audio.pause();
        audio.src = "";
        borrowedAudio?.release();
        releaseUrl();
        if (error) reject(error);
        else resolve(duration);
      };
      const fail = () => {
        if (
          audio.currentTime <= 0 &&
          typeof source !== "string" &&
          !isWavAudioBlob(source)
        ) {
          finish(new CompressedAudioDecodeError());
          return;
        }
        finish(
          audio.currentTime > 0 ? new PartialPlaybackError() : unavailable(),
        );
      };
      const validate = () => {
        if (validated) return;
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        if (timeline && absolute && timeline.length > 0) {
          const maxEnd = timeline.reduce(
            (max, word) =>
              Number.isFinite(word.end) ? Math.max(max, word.end) : max,
            0,
          );
          if (maxEnd <= 0) {
            fail();
            return;
          }
          // Proportionally rescale & clamp timings to actual decoded audio.duration
          // for realistic MP3 encoder framing/padding deltas (up to +25% or +0.5s),
          // while still rejecting wildly mismatched corrupt sidecar timelines.
          const maxRescalableEnd = Math.max(
            audio.duration * 1.25,
            audio.duration + 0.5,
          );
          if (maxEnd > maxRescalableEnd) {
            fail();
            return;
          }
          if (maxEnd > audio.duration + 0.01) {
            const scale = audio.duration / maxEnd;
            let prevEnd = offset;
            for (let i = 0; i < absolute.length; i += 1) {
              const src = timeline[i];
              const scaledStart = Math.max(
                prevEnd,
                Math.min(offset + audio.duration, offset + src.start * scale),
              );
              const scaledEnd = Math.max(
                scaledStart,
                Math.min(offset + audio.duration, offset + src.end * scale),
              );
              absolute[i] = {
                ...src,
                start: scaledStart,
                end: scaledEnd,
              };
              prevEnd = scaledEnd;
            }
          }
        }
        validated = true;
      };
      const recordAudioProgress = () => {
        if (audio.currentTime > lastObservedAudioTime + 0.005) {
          lastObservedAudioTime = audio.currentTime;
          lastProgressAt = Date.now();
        }
      };
      const tick = () => {
        if (!active() || operation.paused || audio.paused || audio.ended)
          return;
        recordAudioProgress();
        validate();
        if (!active()) return;
        if (absolute && validated) {
          const position = findActiveWordIndex(
            absolute,
            audio.currentTime + offset + HIGHLIGHT_LEAD_SECONDS,
          );
          if (position >= 0 && position !== lastIndex) {
            lastIndex = position;
            onWord?.(absolute[position].index);
          }
        }
        if (Number.isFinite(audio.duration) && audio.duration > 0)
          onTime?.(audio.currentTime, audio.duration);
        this.frame = requestAnimationFrame(tick);
      };
      const begin = async () => {
        try {
          lastProgressAt = Date.now();
          applyPlaybackRate(audio);
          await audio.play();
          lastProgressAt = Date.now();
          applyPlaybackRate(audio);
          if (!active()) {
            audio.pause();
            return;
          }
          validate();
          if (!active()) return;
          if (operation.paused) {
            audio.pause();
            return;
          }
          this.onState("playing");
          onStart(audio.duration);
          if (stallWatchdogTimer === null) {
            stallWatchdogTimer = window.setInterval(() => {
              if (!active()) return;
              if (operation.paused || audio.paused || audio.ended) {
                lastProgressAt = Date.now();
                return;
              }
              if (audio.currentTime > lastObservedAudioTime + 0.005) {
                lastObservedAudioTime = audio.currentTime;
                lastProgressAt = Date.now();
                return;
              }
              if (Date.now() - lastProgressAt >= 12_000) {
                fail();
              }
            }, 1_500);
          }
          this.cancelFrame();
          this.frame = requestAnimationFrame(tick);
        } catch (error) {
          if (active()) {
            if (error instanceof Error && error.name === "NotAllowedError") {
              const blocked = new Error(
                tSpeechPlayback("speech.playback.autoplayBlocked"),
              );
              blocked.name = "NotAllowedError";
              finish(blocked);
              return;
            }
            const isDecodeReject =
              error instanceof Error &&
              (error.name === "NotSupportedError" ||
                error.name === "EncodingError" ||
                /decode|codec|format|unsupported/i.test(error.message));
            if (
              isDecodeReject &&
              audio.currentTime <= 0 &&
              typeof source !== "string" &&
              !isWavAudioBlob(source) &&
              !isAbort(error)
            ) {
              finish(new CompressedAudioDecodeError());
              return;
            }
            finish(error);
          }
        }
      };
      const media: ActiveMedia = { pause: () => audio.pause(), resume: begin };
      this.media = media;
      const abort = () => finish(stopped());
      signal.addEventListener("abort", abort, { once: true });
      audio.onloadedmetadata = () => {
        if (active()) {
          applyPlaybackRate(audio);
          validate();
        }
      };
      audio.ontimeupdate = () => {
        if (active()) {
          recordAudioProgress();
          this.cancelFrame();
          tick();
        }
      };
      audio.onstalled = () => {
        if (active()) {
          recordAudioProgress();
        }
      };
      audio.onwaiting = () => {
        if (active()) {
          recordAudioProgress();
        }
      };
      audio.onended = () => {
        if (active()) finish();
      };
      audio.onerror = () => {
        if (active()) fail();
      };
      void begin();
    });
  }
}

class PartialPlaybackError extends Error {
  constructor() {
    super(tSpeechPlayback("speech.playback.partialPlayback"));
  }
}

class CompressedAudioDecodeError extends Error {
  constructor() {
    super("Compressed TTS audio failed to decode; retrying with WAV fallback.");
    this.name = "CompressedAudioDecodeError";
  }
}
