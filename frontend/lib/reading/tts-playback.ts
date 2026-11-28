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
import { getSynthesizedAudioMeta } from "@/lib/reading/synthesized-audio-meta";
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
  onPlay?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onWordChange?: (index: number) => void;
  onEnded?: () => void;
}

export interface WordTimedPlayOptions {
  /** Verified page text, preserving its punctuation and paragraphs. */
  text?: string;
  onPlay?: () => void;
  /** -1 clears the cursor if text and OCR words cannot be safely mapped. */
  onWordChange?: (index: number) => void;
  onEnded?: () => void;
}

export interface PhonicsPlayOptions {
  speedScale?: number;
  onPlay?: (duration: number) => void;
  onStepChange?: (stepIndex: number, step: PhonicsLessonStep) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
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

function stopped(): Error {
  return new DOMException("Audio playback was stopped.", "AbortError");
}

function unavailable(): Error {
  return new Error(
    "Giọng đọc trên máy hiện chưa sẵn sàng. Ba mẹ và bé có thể xem chữ trên màn hình và bấm Thử lại nhé.",
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const LOCKED_VOICE_UNAVAILABLE_NOTICE =
  "Giọng đọc đã khóa đang tạm bận. ViRead giữ nguyên hướng dẫn bằng chữ để không tự đổi giọng khác — bé bấm Thử lại nhé.";
const SERVER_FALLBACK_VOICE_NOTICE =
  "Giọng đã chọn hiện chưa khả dụng, hệ thống đang đọc bằng giọng dự phòng.";
const BROWSER_FALLBACK_VOICE_NOTICE =
  "Giọng đọc trên máy chưa bật — ViRead đang dùng giọng Online của trình duyệt.";

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

function shouldSkipBackendTtsForVoice(voice: ResolvedOperationVoice): boolean {
  if (
    !canUseGoogleTtsFallback() ||
    !canUseBrowserSpeechSynthesis() ||
    voice.provider !== "local"
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

function shouldSkipBackendTtsForBrowserFallback(operation: Operation): boolean {
  return shouldSkipBackendTtsForVoice(operation.voice);
}

function shouldRetryBackendWithGoogleTts(operation: Operation): boolean {
  if (!canUseGoogleTtsFallback() || operation.voice.provider !== "local") {
    return false;
  }
  const health = getFreshVoiceEngineHealth();
  if (!health) return true;
  return health.google.tts_configured && !health.google.tts_cooldown;
}

// Unicode-aware boundaries so Vietnamese diacritic endings ("nữ", "mỹ", "sơn", "hùng") match accurately.
// Note: Windows OneCore "Microsoft An - Vietnamese" is a female voice, while "NamMinh" is male.
const MALE_BROWSER_VOICE_RE =
  /(?:^|[^\p{L}\p{N}])(nam|minh|son|sơn|hung|hùng|tuan|tuấn|male|namminh)(?=$|[^\p{L}\p{N}])/iu;
const FEMALE_BROWSER_VOICE_RE =
  /(?:^|[^\p{L}\p{N}])(hoai|hoài|my|mỹ|hoaimy|linh|lan|mai|nu|nữ|female|chi|microsoft\s+an)(?=$|[^\p{L}\p{N}])/iu;

function pickVietnameseBrowserVoice(
  synth: SpeechSynthesis,
  preferredGender?: VoiceGender,
): SpeechSynthesisVoice | null {
  try {
    const voices = synth.getVoices?.() ?? [];
    const viVoices = voices.filter((v) =>
      (v.lang ?? "").toLowerCase().startsWith("vi"),
    );
    if (!viVoices.length) return null;
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
    return (
      [...viVoices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ??
      viVoices[0] ??
      null
    );
  } catch {
    return null;
  }
}

async function waitForBrowserVoices(
  synth: SpeechSynthesis,
  signal: AbortSignal,
  timeoutMs = 350,
): Promise<void> {
  try {
    const existing = synth.getVoices?.() ?? [];
    if (existing.length > 0 || signal.aborted) return;
  } catch {
    return;
  }
  if (typeof synth.addEventListener !== "function") return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      try {
        synth.removeEventListener("voiceschanged", onVoicesChanged);
      } catch {
        // Ignore cleanup errors
      }
      resolve();
    };
    const onVoicesChanged = () => {
      finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    signal.addEventListener("abort", finish, { once: true });
    try {
      synth.addEventListener("voiceschanged", onVoicesChanged, { once: true });
    } catch {
      finish();
    }
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
    { readonly audio: Blob; readonly usedFallbackVoice: boolean }
  >();
  private readonly inFlightShortPrefetch = new Map<
    string,
    Promise<{
      readonly audio: Blob;
      readonly usedFallbackVoice: boolean;
    } | null>
  >();
  private shortCacheBytes = 0;
  private readonly phonicsCache = new Map<string, SynthesizedPhonicsSpeech>();
  private phonicsCacheBytes = 0;
  private timedCooldownUntil = 0;

  constructor(
    private readonly speech: SpeechService,
    private readonly studio: VoiceStudioService,
  ) {
    installAndroidAudioUnlock();
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
    recordTtsEngineUsage({
      provider: "browser",
      fallbackUsed: true,
      fallbackReason: "LOCAL_TTS_UNAVAILABLE",
      voiceId: operation.voice.requestedVoiceId,
      voiceGender: preferredGender,
    });
    this.setFallbackNotice(BROWSER_FALLBACK_VOICE_NOTICE);

    // Chromium/Android WebView often return [] from getVoices() on the first call
    // before `voiceschanged` fires. Wait briefly when empty (0ms when already loaded).
    await waitForBrowserVoices(synth, operation.controller.signal);
    this.ensure(operation);

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
    const maxWatchdogMs = Math.max(
      8_000,
      Math.round(estimatedDuration * 1000 * 2.5) + 4_000,
    );

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let startedEmitted = false;
      let speakDispatched = false;
      let sawBoundary = false;
      let lastWordIdx = -1;
      let approxTimer: number | null = null;
      let speakDelayTimer: number | null = null;
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
        if (watchdogTimer !== null) {
          window.clearInterval(watchdogTimer);
          watchdogTimer = null;
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
              if (approxTimer !== null) {
                window.clearInterval(approxTimer);
                approxTimer = null;
              }
            }
          }, msPerWord);
        }
      };

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "vi-VN";
      utterance.rate = operation.voice.speed;
      const viVoice = pickVietnameseBrowserVoice(synth, preferredGender);
      if (viVoice) {
        utterance.voice = viVoice;
      }

      const media: ActiveMedia = {
        pause: () => {
          try {
            synth.pause?.();
          } catch {
            // Ignore browser pause error
          }
        },
        resume: async () => {
          lastWatchdogTickAt = Date.now();
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
          if (approxTimer !== null) {
            window.clearInterval(approxTimer);
            approxTimer = null;
          }
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

      const dispatchSpeak = () => {
        if (!active()) return;
        speakDispatched = true;
        lastWatchdogTickAt = Date.now();
        try {
          synth.speak(utterance);
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

  private splitShortChunks(
    spokenText: string,
    voice: ResolvedOperationVoice,
    wordSample: boolean,
  ) {
    const shouldSentencePipeline =
      !wordSample &&
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
    const voice = resolveOperationVoice(Infinity, options.speedScale ?? 1);
    if (shouldSkipBackendTtsForVoice(voice)) return;
    const chunks = this.splitShortChunks(spokenText, voice, wordSample);
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
      } | null> => {
        try {
          let source = await this.speech.synthesize(normalized, {
            voiceId: voice.requestedVoiceId ?? undefined,
            speed: voice.speed,
            wordSample,
            signal: options.signal,
          });
          if (options.signal?.aborted) return null;
          if (wordSample) {
            source = await prepareWordSampleAudio(source);
            if (options.signal?.aborted) return null;
          }
          const entry = {
            audio: source,
            usedFallbackVoice: Boolean(
              getSynthesizedAudioMeta(source)?.usedFallbackVoice,
            ),
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
        let audited = false;
        const ensureAudited = () => {
          if (audited) return;
          audited = true;
          this.auditUtterance(operation, kind, spokenText);
        };

        let elapsed = 0;
        const chunks = this.splitShortChunks(
          spokenText,
          operation.voice,
          Boolean(options.wordSample),
        );

        const fetchChunk = async (
          chunkText: string,
        ): Promise<{
          audio: Blob;
          usedFallbackVoice: boolean;
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
          const cachedShort = this.shortCache.get(shortKey);
          if (cachedShort) {
            return {
              audio: cachedShort.audio,
              usedFallbackVoice: cachedShort.usedFallbackVoice,
              key: shortKey,
            };
          }
          const pendingPrefetch = this.inFlightShortPrefetch.get(shortKey);
          if (pendingPrefetch) {
            const prefetched = await this.wait(operation, pendingPrefetch);
            this.ensure(operation);
            if (prefetched) {
              return {
                audio: prefetched.audio,
                usedFallbackVoice: prefetched.usedFallbackVoice,
                key: shortKey,
              };
            }
          }
          let source: Blob;
          let forcedFallbackVoice = false;
          try {
            source = await this.wait(
              operation,
              this.speech.synthesize(normalized, {
                voiceId: operation.voice.requestedVoiceId ?? undefined,
                speed: operation.voice.speed,
                wordSample: Boolean(options.wordSample),
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
          const usedFallbackVoice =
            forcedFallbackVoice ||
            Boolean(getSynthesizedAudioMeta(source)?.usedFallbackVoice);
          if (options.wordSample) {
            source = await this.wait(operation, prepareWordSampleAudio(source));
          }
          this.cacheShort(resolvedKey, {
            audio: source,
            usedFallbackVoice,
          });
          return { audio: source, usedFallbackVoice, key: resolvedKey };
        };

        let nextPrefetch: Promise<{
          audio: Blob;
          usedFallbackVoice: boolean;
          key: string;
        }> | null = null;
        let useBrowserFallback =
          shouldSkipBackendTtsForBrowserFallback(operation);

        for (let idx = 0; idx < chunks.length; idx += 1) {
          const chunk = chunks[idx];
          await this.waitIfPaused(operation);
          this.ensure(operation);
          const onStart = (duration: number) =>
            this.started(operation, () => options.onPlay?.(duration));
          const onTime = (time: number, duration: number) =>
            options.onTimeUpdate?.(elapsed + time, elapsed + duration);

          if (useBrowserFallback) {
            ensureAudited();
            elapsed += await this.playBrowserSpeech(operation, chunk.text, {
              onStart,
              onTime,
            });
            continue;
          }

          let fetched: {
            audio: Blob;
            usedFallbackVoice: boolean;
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
            if (canUseGoogleTtsFallback() && canUseBrowserSpeechSynthesis()) {
              useBrowserFallback = true;
              ensureAudited();
              elapsed += await this.playBrowserSpeech(operation, chunk.text, {
                onStart,
                onTime,
              });
              continue;
            }
            this.setFallbackNotice(LOCKED_VOICE_UNAVAILABLE_NOTICE);
            throw unavailable();
          }

          // Prefetch the next sentence in parallel while the current sentence plays!
          if (idx + 1 < chunks.length) {
            nextPrefetch = fetchChunk(chunks[idx + 1].text);
            // Suppress unhandled rejection if playback aborts before nextPrefetch is awaited
            nextPrefetch.catch(() => undefined);
          }

          ensureAudited();
          this.setFallbackNotice(
            fetched.usedFallbackVoice ? SERVER_FALLBACK_VOICE_NOTICE : null,
          );
          try {
            // Speed is already applied once at generation -> playbackRate MUST stay 1.0!
            elapsed += await this.playAudio(
              operation,
              fetched.audio,
              undefined,
              0,
              onStart,
              undefined,
              onTime,
              1,
            );
          } catch (error) {
            this.ensure(operation);
            if (isAbort(error) || error instanceof PartialPlaybackError)
              throw error;
            this.shortCacheBytes -= fetched.audio.size;
            this.shortCache.delete(fetched.key);
            this.setFallbackNotice(LOCKED_VOICE_UNAVAILABLE_NOTICE);
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
        const phonicsTextPreview = lesson.steps
          .map((s) => s.spokenText)
          .join(" ");
        let audited = false;
        const ensureAudited = () => {
          if (audited) return;
          audited = true;
          this.auditUtterance(operation, "phonics_lesson", phonicsTextPreview);
        };

        const playPhonicsViaBrowser = async () => {
          ensureAudited();
          let browserElapsed = 0;
          for (const step of lesson.steps) {
            await this.waitIfPaused(operation);
            this.ensure(operation);
            options.onStepChange?.(step.index, step);
            browserElapsed += await this.playBrowserSpeech(
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

        if (shouldSkipBackendTtsForBrowserFallback(operation)) {
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
          let synthesized = this.phonicsCache.get(phonicsKey);
          let forcedFallbackVoice = false;
          if (!synthesized) {
            try {
              synthesized = await this.wait(
                operation,
                this.speech.synthesizePhonics(normalizedSteps, {
                  voiceId: operation.voice.requestedVoiceId ?? undefined,
                  speed: operation.voice.speed,
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
                        signal: operation.controller.signal,
                      }),
                    );
                    this.ensure(operation);
                    this.promoteOperationToGoogleVoice(
                      operation,
                      googleVoiceId,
                    );
                    forcedFallbackVoice = true;
                    this.cachePhonics(makePhonicsKey(), synthesized);
                  } catch (googleError) {
                    this.ensure(operation);
                    if (isAbort(googleError)) throw googleError;
                  }
                }
                if (!synthesized && canUseBrowserSpeechSynthesis()) {
                  await playPhonicsViaBrowser();
                  return;
                }
              }
              if (!synthesized) {
                this.setFallbackNotice(LOCKED_VOICE_UNAVAILABLE_NOTICE);
                throw unavailable();
              }
            }
          }

          ensureAudited();
          this.setFallbackNotice(
            forcedFallbackVoice ? SERVER_FALLBACK_VOICE_NOTICE : null,
          );
          let lastEmittedStep = -1;
          const emitStepForTime = (currentTime: number) => {
            const idx = findActivePhonicsStepIndex(
              synthesized.stepTimings,
              currentTime,
            );
            if (idx >= 0 && idx !== lastEmittedStep && lesson.steps[idx]) {
              lastEmittedStep = idx;
              options.onStepChange?.(idx, lesson.steps[idx]);
            }
          };

          await this.playAudio(
            operation,
            synthesized.audio,
            undefined,
            0,
            (duration) =>
              this.started(operation, () => {
                options.onPlay?.(duration);
                emitStepForTime(0);
              }),
            undefined,
            (currentTime, duration) => {
              emitStepForTime(currentTime);
              options.onTimeUpdate?.(currentTime, duration);
            },
            1,
          );
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
          let stepBlob = this.shortCache.get(stepKey)?.audio ?? null;
          if (!stepBlob) {
            try {
              stepBlob = await this.wait(
                operation,
                this.speech.synthesize(step.spokenText.normalize("NFC"), {
                  voiceId: operation.voice.requestedVoiceId ?? undefined,
                  speed: operation.voice.speed,
                  wordSample: true,
                  signal: operation.controller.signal,
                }),
              );
              this.ensure(operation);
              this.cacheShort(stepKey, {
                audio: stepBlob,
                usedFallbackVoice: false,
              });
            } catch (error) {
              this.ensure(operation);
              if (isAbort(error)) throw error;
              if (canUseGoogleTtsFallback() && canUseBrowserSpeechSynthesis()) {
                ensureAudited();
                options.onStepChange?.(step.index, step);
                elapsed += await this.playBrowserSpeech(
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
              this.setFallbackNotice(LOCKED_VOICE_UNAVAILABLE_NOTICE);
              throw unavailable();
            }
          }

          ensureAudited();
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
            1,
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
      let audited = false;
      const ensureAudited = () => {
        if (audited) return;
        audited = true;
        this.auditUtterance(operation, "page_sample", text);
      };

      const canMap = hasMatchingSpeechWords(text, words);
      if (!canMap) options.onWordChange?.(-1);
      let elapsed = 0;
      let completedChunks = 0;
      let useBrowserFallback =
        shouldSkipBackendTtsForBrowserFallback(operation);
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
          ensureAudited();
          elapsed += await this.playBrowserSpeech(
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
        let resolvedKey = key;
        let forcedFallbackVoice = false;
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
            try {
              timed = await this.wait(
                operation,
                this.studio.synthesizeTimed(chunk.words, {
                  voiceId: operation.voice.requestedVoiceId,
                  speed: operation.voice.speed,
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
                    signal: operation.controller.signal,
                  }),
                );
                this.ensure(operation);
                this.promoteOperationToGoogleVoice(operation, googleVoiceId);
                forcedFallbackVoice = true;
              } else {
                throw synthError;
              }
            }
            this.ensure(operation);
            this.timedCooldownUntil = 0;
            resolvedKey = makeTimedKey();
            this.cacheTimed(resolvedKey, timed);
          }
          synthesizedTimedOk = true;
          ensureAudited();
          this.setFallbackNotice(
            forcedFallbackVoice || timed.usedFallbackVoice
              ? SERVER_FALLBACK_VOICE_NOTICE
              : null,
          );
          elapsed += await this.playAudio(
            operation,
            timed.audio,
            timed.words,
            elapsed,
            onStart,
            onWord,
            undefined,
            1,
          );
        } catch (error) {
          this.ensure(operation);
          if (isAbort(error) || error instanceof PartialPlaybackError)
            throw error;
          const invalid = this.cache.get(resolvedKey);
          if (invalid) {
            this.cacheBytes -= invalid.audio.size;
            this.cache.delete(resolvedKey);
          }
          if (
            (!synthesizedTimedOk || !fallback) &&
            canUseGoogleTtsFallback() &&
            canUseBrowserSpeechSynthesis()
          ) {
            useBrowserFallback = true;
            ensureAudited();
            elapsed += await this.playBrowserSpeech(
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
          if (!completedChunks && fallback) {
            await fallback();
            return;
          }
          this.setFallbackNotice(LOCKED_VOICE_UNAVAILABLE_NOTICE);
          throw unavailable();
        }
        completedChunks += 1;
      }
      this.ensure(operation);
      options.onEnded?.();
    });

  private cacheShort(
    key: string,
    entry: { readonly audio: Blob; readonly usedFallbackVoice: boolean },
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
    const prev = this.cache.get(key);
    if (prev) {
      this.cacheBytes -= prev.audio.size;
      this.cache.delete(key);
    }
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
    try {
      audio = new Audio(url);
      // Synthesized audio already includes the requested speed once.
      audio.defaultPlaybackRate = playbackRate;
      audio.playbackRate = playbackRate;
      audio.preservesPitch = true;
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
      const fail = () =>
        finish(
          audio.currentTime > 0 ? new PartialPlaybackError() : unavailable(),
        );
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
          await audio.play();
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
          if (active()) finish(error);
        }
      };
      const media: ActiveMedia = { pause: () => audio.pause(), resume: begin };
      this.media = media;
      const abort = () => finish(stopped());
      signal.addEventListener("abort", abort, { once: true });
      audio.onloadedmetadata = () => {
        if (active()) validate();
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
    super("Âm thanh bị gián đoạn. Bé có thể nghe lại từ đầu nhé.");
  }
}
