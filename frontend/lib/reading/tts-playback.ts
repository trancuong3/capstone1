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
import { installAndroidAudioUnlock } from "@/lib/reading/android-audio-unlock";
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
  DEFAULT_LOCAL_VOICE_ID,
  getActiveSessionVoiceLock,
  getVoicePolicyPreferences,
  GOOGLE_TTS_MODEL_VERSION,
  inferModelVersionForVoiceId,
  inferProviderFromVoiceId,
  inferRegionFromVoiceId,
  recordSessionUtteranceVoice,
  REGION_DEFAULT_VOICE_ID,
  type VoiceProviderKind,
  type VoiceRegion,
} from "@/lib/reading/session-voice-lock";
import { prepareWordSampleAudio } from "@/lib/reading/short-word-audio";
import {
  clampSpeed,
  getSpeechPreferences,
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
import { resolveVoiceGender } from "@/lib/reading/voice-persona";
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
}

interface ResolvedOperationVoice {
  readonly sessionId: string | null;
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
  return error instanceof Error && error.name === "AbortError";
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

function canUseAllowedDeviceFallbackTts(): boolean {
  if (isAndroidNativeSpeechAvailable()) {
    return true;
  }
  return canUseGoogleTtsFallback() && canUseBrowserSpeechSynthesis();
}

function shouldSkipBackendTtsForBrowserFallback(
  operation: Operation,
  hasBackendCacheTarget = false,
): boolean {
  if (
    hasBackendCacheTarget ||
    !canUseAllowedDeviceFallbackTts() ||
    operation.voice.provider !== "local"
  ) {
    return false;
  }
  const health = getFreshVoiceEngineHealth();
  if (!health) return false;
  return (
    (!health.local.available || !health.local.tts_ready) &&
    (!health.google.tts_configured || health.google.tts_cooldown)
  );
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

function shouldRetryBackendWithGoogleTts(operation: Operation): boolean {
  if (!canUseGoogleTtsFallback() || operation.voice.provider !== "local") {
    return false;
  }
  const health = getFreshVoiceEngineHealth();
  if (!health) return true;
  return health.google.tts_configured && !health.google.tts_cooldown;
}

function pickVietnameseBrowserVoice(
  synth: SpeechSynthesis,
): SpeechSynthesisVoice | null {
  try {
    const voices = synth.getVoices?.() ?? [];
    const viVoices = voices.filter((v) =>
      (v.lang ?? "").toLowerCase().startsWith("vi"),
    );
    if (!viVoices.length) return null;
    return (
      viVoices.find((v) => /google/i.test(v.name ?? "")) ?? viVoices[0] ?? null
    );
  } catch {
    return null;
  }
}

async function resolveVietnameseBrowserVoice(
  synth: SpeechSynthesis,
  signal: AbortSignal,
): Promise<SpeechSynthesisVoice | null> {
  const existing = pickVietnameseBrowserVoice(synth);
  if (existing) return existing;
  try {
    const voices = synth.getVoices?.() ?? [];
    if (voices.length > 0 || typeof synth.addEventListener !== "function") {
      return null;
    }
  } catch {
    return null;
  }
  return new Promise<SpeechSynthesisVoice | null>((resolve) => {
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
      resolve(pickVietnameseBrowserVoice(synth));
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
): ResolvedOperationVoice {
  const activeLock = getActiveSessionVoiceLock();
  const prefs = getSpeechPreferences();
  const policy = getVoicePolicyPreferences();

  const baseSpeed = activeLock ? activeLock.speed : prefs.speed;
  const limited = Math.min(baseSpeed, speedLimit);
  const scaled = speedScale === 1 ? limited : limited * speedScale;
  const effectiveSpeed = clampSpeed(scaled);

  if (activeLock) {
    return {
      sessionId: activeLock.sessionId,
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
    sessionId: null,
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
  ): Promise<void> {
    this.stop();
    const operation: Operation = {
      controller: new AbortController(),
      voice: resolveOperationVoice(speedLimit, speedScale),
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
        stopAndroidNativeTts();
      },
      resume: async () => undefined,
    };
    this.media = media;

    try {
      const elapsedSec = await speakWithAndroidNativeTts(text, {
        rate: operation.voice.speed,
        pitch: 1.0,
        signal: operation.controller.signal,
        onStart: () => {
          if (this.current !== operation || operation.controller.signal.aborted)
            return;
          this.onState("playing");
          options.onStart?.(estimatedDuration);
          if (options.words?.length && options.onWord) {
            emitWord(0);
            let approxIdx = 0;
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
          if (this.current !== operation || operation.controller.signal.aborted)
            return;
          if (options.words?.length) {
            sawRange = true;
            clearTimers();
            emitWord(findWordIndexForCharOffset(charOffsets, start));
          }
        },
      });
      return elapsedSec;
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
    if (isAndroidNativeSpeechAvailable()) {
      try {
        return await this.playAndroidNativeSpeech(operation, text, options);
      } catch (error) {
        this.ensure(operation);
        if (isAbort(error)) throw error;
        if (!canUseGoogleTtsFallback() || !canUseBrowserSpeechSynthesis()) {
          throw unavailable();
        }
      }
    }
    if (!canUseGoogleTtsFallback()) {
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
    const resolvedVoice = await resolveVietnameseBrowserVoice(
      synth,
      operation.controller.signal,
    );
    this.ensure(operation);
    if (!resolvedVoice) {
      this.setFallbackNotice(getLockedVoiceUnavailableNotice());
      throw unavailable();
    }
    recordTtsEngineUsage({
      provider: "browser",
      fallbackUsed: true,
      fallbackReason: "LOCAL_TTS_UNAVAILABLE",
      voiceId: operation.voice.requestedVoiceId,
      voiceGender: resolveVoiceGender(operation.voice.requestedVoiceId),
    });
    this.setFallbackNotice(getBrowserFallbackVoiceNotice());

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

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let startedEmitted = false;
      let sawBoundary = false;
      let lastWordIdx = -1;
      let approxTimer: number | null = null;
      const startedAt = Date.now();
      const signal = operation.controller.signal;

      const clearTimers = () => {
        if (approxTimer !== null) {
          window.clearInterval(approxTimer);
          approxTimer = null;
        }
      };

      const active = () =>
        !settled && this.current === operation && !signal.aborted;

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimers();
        signal.removeEventListener("abort", onAbort);
        if (this.media === media) this.media = null;
        utterance.onstart = null;
        utterance.onend = null;
        utterance.onerror = null;
        utterance.onboundary = null;
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
            } else {
              clearTimers();
            }
          }, msPerWord);
        }
      };

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "vi-VN";
      utterance.rate = operation.voice.speed;
      utterance.voice = resolvedVoice;

      const media: ActiveMedia = {
        pause: () => {
          try {
            synth.pause?.();
          } catch {
            // Ignore browser pause error
          }
        },
        resume: async () => {
          try {
            synth.resume?.();
          } catch {
            // Ignore browser resume error
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

      utterance.onstart = () => {
        ensureStarted();
      };
      utterance.onboundary = (event) => {
        if (!active()) return;
        ensureStarted();
        if (options.words?.length && typeof event.charIndex === "number") {
          sawBoundary = true;
          clearTimers();
          emitWord(findWordIndexForCharOffset(charOffsets, event.charIndex));
        }
      };
      utterance.onend = () => {
        if (!active()) return;
        ensureStarted();
        finish();
      };
      utterance.onerror = (event) => {
        if (!active()) return;
        const errName = (event as { error?: string } | undefined)?.error ?? "";
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

      try {
        synth.cancel?.();
        synth.speak(utterance);
        // If voice was paused right before speak, respect pause state
        if (operation.paused) {
          synth.pause?.();
        }
      } catch {
        finish(unavailable());
      }
    });
  }

  private auditUtterance(
    operation: Operation,
    kind: string,
    textPreview: string,
  ): void {
    recordSessionUtteranceVoice(
      {
        kind,
        provider: operation.voice.provider,
        voiceId: operation.voice.cacheVoiceId,
        region: operation.voice.region,
        modelVersion: operation.voice.modelVersion,
        speed: operation.voice.speed,
        textPreview,
      },
      operation.voice.sessionId,
    );
  }

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
        this.auditUtterance(operation, kind, spokenText);

        // Tier 1: Precomputed verified-catalog MP3 URL (cached in Cache Storage, 0 B repeat egress).
        if (options.precomputedAudioUrl) {
          const precomputedBlob = await fetchPrecomputedCatalogAudio(
            options.precomputedAudioUrl,
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
            this.setFallbackNotice(null);
            try {
              const precomputedPlaybackRate = computeEffectivePlaybackRate(
                operation.voice.speed,
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
                precomputedError instanceof PartialPlaybackError
              ) {
                throw precomputedError;
              }
              // Fall through cleanly to backend / Android native / browser TTS.
            }
          }
        }

        let elapsed = 0;
        const shouldSentencePipeline =
          !options.wordSample &&
          operation.voice.provider === "local" &&
          spokenText.length > 90 &&
          /[.!?…]\s+\S/u.test(spokenText);
        const chunks = splitSpeechText(
          spokenText,
          shouldSentencePipeline ? 95 : SHORT_TTS_MAX_CHARACTERS,
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
                ...cacheMeta,
                signal: operation.controller.signal,
              }),
            );
          } catch (error) {
            this.ensure(operation);
            if (isAbort(error)) throw error;
            if (shouldRetryBackendWithGoogleTts(operation)) {
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
            if (canUseAllowedDeviceFallbackTts()) {
              useBrowserFallback = true;
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
            this.shortCacheBytes -= fetched.audio.size;
            this.shortCache.delete(fetched.key);
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
                  wavError instanceof PartialPlaybackError
                ) {
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
    );

  playPhonicsLesson = (
    lesson: SupportedPhonicsLessonPlan,
    options: PhonicsPlayOptions = {},
  ): Promise<void> =>
    this.run(
      async (operation) => {
        if (!lesson.steps.length) throw unavailable();
        this.auditUtterance(
          operation,
          "phonics_lesson",
          lesson.steps.map((s) => s.spokenText).join(" "),
        );

        const playPhonicsViaBrowser = async () => {
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

            const fetchedBlobs: {
              readonly audio: Blob;
              readonly cachedSpeed: number | null;
              readonly key: string;
            }[] = [];
            for (const word of wordList) {
              const item = await fetchSingleWord(word);
              if (item) fetchedBlobs.push(item);
            }
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
                  this.shortCacheBytes -= cachedEntry.audio.size;
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
                if (shouldRetryBackendWithGoogleTts(operation)) {
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
                if (await tryPlayPhonicsViaCachedWordSynthesize()) {
                  return;
                }
                if (canUseAllowedDeviceFallbackTts()) {
                  await playPhonicsViaBrowser();
                  return;
                }
                this.setFallbackNotice(getLockedVoiceUnavailableNotice());
                throw unavailable();
              }
            }
          }

          const activePhonics = synthesized;
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
            if (
              playErr instanceof CompressedAudioDecodeError &&
              this.speech.synthesizePhonics
            ) {
              const stale = this.phonicsCache.get(phonicsKey);
              if (stale) {
                this.phonicsCacheBytes -= stale.audio.size;
                this.phonicsCache.delete(phonicsKey);
              }
              const wavPhonics = await this.wait(
                operation,
                this.speech.synthesizePhonics(normalizedSteps, {
                  voiceId: operation.voice.requestedVoiceId ?? undefined,
                  speed: operation.voice.speed,
                  audioFormat: "wav",
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
              if (canUseAllowedDeviceFallbackTts()) {
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
    );

  playWithWordTimings = (
    words: readonly string[],
    options: WordTimedPlayOptions,
    fallback?: () => Promise<void>,
  ): Promise<void> =>
    this.run(async (operation) => {
      const text = (options.text ?? words.join(" ")).normalize("NFC");
      if (!text.trim()) throw unavailable();
      this.auditUtterance(operation, "page_sample", text);

      const canMap = hasMatchingSpeechWords(text, words);
      if (!canMap) options.onWordChange?.(-1);

      // Tier 1: Precomputed verified-catalog MP3 URL (cached in Cache Storage).
      if (options.precomputedAudioUrl) {
        const precomputedBlob = await fetchPrecomputedCatalogAudio(
          options.precomputedAudioUrl,
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
          this.setFallbackNotice(null);
          try {
            const precomputedPlaybackRate = computeEffectivePlaybackRate(
              operation.voice.speed,
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
              precomputedError instanceof PartialPlaybackError
            ) {
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
      for (const chunk of splitSpeechText(text)) {
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
        const makeTimedKey = () =>
          JSON.stringify([
            operation.voice.provider,
            operation.voice.cacheVoiceId,
            operation.voice.modelVersion,
            operation.voice.speed,
            chunk.words,
          ]);
        const key = makeTimedKey();
        let synthesizedTimedOk = false;
        try {
          let timed = this.cache.get(key);
          if (!timed) {
            if (
              fallback &&
              !canUseGoogleTtsFallback() &&
              Date.now() < this.timedCooldownUntil
            ) {
              await fallback();
              return;
            }
            const timedCacheMeta = this.resolveCacheMeta(
              options,
              "CATALOG",
              false,
            );
            try {
              timed = await this.wait(
                operation,
                this.studio.synthesizeTimed(chunk.words, {
                  voiceId: operation.voice.requestedVoiceId,
                  speed: operation.voice.speed,
                  ...timedCacheMeta,
                  signal: operation.controller.signal,
                }),
              );
            } catch (synthError) {
              this.ensure(operation);
              if (isAbort(synthError)) throw synthError;
              if (shouldRetryBackendWithGoogleTts(operation)) {
                const googleVoiceId = mapLocalVoiceToGoogleBackup(
                  operation.voice.requestedVoiceId,
                  operation.voice.region,
                );
                timed = await this.wait(
                  operation,
                  this.studio.synthesizeTimed(chunk.words, {
                    voiceId: googleVoiceId,
                    speed: operation.voice.speed,
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
            this.cacheTimed(makeTimedKey(), timed);
          }
          synthesizedTimedOk = true;
          this.setFallbackNotice(
            timed.usedFallbackVoice ? getServerFallbackVoiceNotice() : null,
          );
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
              undefined,
              timedPlaybackRate,
            );
          } catch (playErr) {
            this.ensure(operation);
            if (playErr instanceof CompressedAudioDecodeError) {
              const stale = this.cache.get(key);
              if (stale) {
                this.cacheBytes -= stale.audio.size;
                this.cache.delete(key);
              }
              const wavTimedCacheMeta = this.resolveCacheMeta(
                options,
                "CATALOG",
                false,
              );
              const wavTimed = await this.wait(
                operation,
                this.studio.synthesizeTimed(chunk.words, {
                  voiceId: operation.voice.requestedVoiceId,
                  speed: operation.voice.speed,
                  audioFormat: "wav",
                  ...wavTimedCacheMeta,
                  signal: operation.controller.signal,
                }),
              );
              this.ensure(operation);
              if (
                wavTimed.audio.type.trim().length > 0 &&
                !isWavAudioBlob(wavTimed.audio)
              ) {
                throw unavailable();
              }
              this.cacheTimed(makeTimedKey(), wavTimed);
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
          this.ensure(operation);
          if (isAbort(error) || error instanceof PartialPlaybackError)
            throw error;
          const invalid = this.cache.get(key);
          if (invalid) {
            this.cacheBytes -= invalid.audio.size;
            this.cache.delete(key);
          }
          // Prefer the same locked voice via the short endpoint before
          // switching providers, and never replay already completed chunks.
          if (!completedChunks && fallback) {
            this.timedCooldownUntil = Date.now() + 15_000;
            await fallback();
            return;
          }
          if (
            (!synthesizedTimedOk || !fallback) &&
            canUseAllowedDeviceFallbackTts()
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
    });

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
      this.shortCacheBytes -= prev.audio.size;
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
      this.shortCacheBytes -= this.shortCache.get(first)?.audio.size ?? 0;
      this.shortCache.delete(first);
    }
  }

  private cacheTimed(key: string, speech: TimedSpeech): void {
    if (speech.audio.size > 8 * 1024 * 1024) return;
    this.cache.set(key, speech);
    this.cacheBytes += speech.audio.size;
    while (this.cache.size > 6 || this.cacheBytes > 16 * 1024 * 1024) {
      const first = this.cache.keys().next().value;
      if (first === undefined) break;
      this.cacheBytes -= this.cache.get(first)?.audio.size ?? 0;
      this.cache.delete(first);
    }
  }

  private cachePhonics(key: string, speech: SynthesizedPhonicsSpeech): void {
    if (speech.audio.size > 6 * 1024 * 1024) return;
    const prev = this.phonicsCache.get(key);
    if (prev) {
      this.phonicsCacheBytes -= prev.audio.size;
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
      this.phonicsCacheBytes -= this.phonicsCache.get(first)?.audio.size ?? 0;
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
    let audio: HTMLAudioElement;
    const applyPlaybackRate = (el: HTMLAudioElement) => {
      // Exact speed matches use playbackRate=1; speed-fallback cache hits scale
      // cleanly to requestedSpeed / cachedSpeed while preserving pitch and word timings.
      el.defaultPlaybackRate = playbackRate;
      el.playbackRate = playbackRate;
      el.preservesPitch = true;
    };
    try {
      audio = new Audio(url);
      applyPlaybackRate(audio);
      audio.volume = 1;
      this.ensure(operation);
    } catch (error) {
      releaseUrl();
      throw error;
    }
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let lastIndex = -1;
      let validated = !timeline;
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
            null;
        audio.pause();
        audio.src = "";
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
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        if (
          timeline &&
          timeline.some((word) => word.end > audio.duration + 0.05)
        ) {
          fail();
          return;
        }
        validated = true;
      };
      const tick = () => {
        if (!active() || operation.paused || audio.paused || audio.ended)
          return;
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
          applyPlaybackRate(audio);
          await audio.play();
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
          this.cancelFrame();
          tick();
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
