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
  readonly voice: ResolvedOperationVoice;
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
  "Giọng đã chọn hiện chưa khả dụng, hệ thống đang đọc bằng giọng mặc định.";

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
        ): Promise<{
          audio: Blob;
          usedFallbackVoice: boolean;
          key: string;
        }> => {
          const normalized = chunkText.normalize("NFC");
          const shortKey = JSON.stringify([
            operation.voice.provider,
            operation.voice.cacheVoiceId,
            operation.voice.modelVersion,
            operation.voice.speed,
            normalized,
            Boolean(options.wordSample),
          ]);
          const cachedShort = this.shortCache.get(shortKey);
          if (cachedShort) {
            return {
              audio: cachedShort.audio,
              usedFallbackVoice: cachedShort.usedFallbackVoice,
              key: shortKey,
            };
          }
          let source = await this.wait(
            operation,
            this.speech.synthesize(normalized, {
              voiceId: operation.voice.requestedVoiceId ?? undefined,
              speed: operation.voice.speed,
              wordSample: Boolean(options.wordSample),
              signal: operation.controller.signal,
            }),
          );
          this.ensure(operation);
          const usedFallbackVoice = Boolean(
            getSynthesizedAudioMeta(source)?.usedFallbackVoice,
          );
          if (options.wordSample) {
            source = await this.wait(operation, prepareWordSampleAudio(source));
          }
          this.cacheShort(shortKey, {
            audio: source,
            usedFallbackVoice,
          });
          return { audio: source, usedFallbackVoice, key: shortKey };
        };

        let nextPrefetch: Promise<{
          audio: Blob;
          usedFallbackVoice: boolean;
          key: string;
        }> | null = null;

        for (let idx = 0; idx < chunks.length; idx += 1) {
          const chunk = chunks[idx];
          await this.waitIfPaused(operation);
          this.ensure(operation);
          const onStart = (duration: number) =>
            this.started(operation, () => options.onPlay?.(duration));
          const onTime = (time: number, duration: number) =>
            options.onTimeUpdate?.(elapsed + time, elapsed + duration);

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
            this.setFallbackNotice(LOCKED_VOICE_UNAVAILABLE_NOTICE);
            throw unavailable();
          }

          // Prefetch the next sentence in parallel while the current sentence plays!
          if (idx + 1 < chunks.length) {
            nextPrefetch = fetchChunk(chunks[idx + 1].text);
            // Suppress unhandled rejection if playback aborts before nextPrefetch is awaited
            nextPrefetch.catch(() => undefined);
          }

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
        this.auditUtterance(
          operation,
          "phonics_lesson",
          lesson.steps.map((s) => s.spokenText).join(" "),
        );

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
          let synthesized = this.phonicsCache.get(phonicsKey);
          if (!synthesized) {
            try {
              synthesized = await this.wait(
                operation,
                this.speech.synthesizePhonics(
                  lesson.steps.map((s) => ({
                    id: s.id,
                    spokenText: s.spokenText.normalize("NFC"),
                    pauseAfterMs: s.pauseAfterMs,
                  })),
                  {
                    voiceId: operation.voice.requestedVoiceId ?? undefined,
                    speed: operation.voice.speed,
                    signal: operation.controller.signal,
                  },
                ),
              );
              this.ensure(operation);
              this.cachePhonics(phonicsKey, synthesized);
            } catch (error) {
              this.ensure(operation);
              if (isAbort(error)) throw error;
              this.setFallbackNotice(LOCKED_VOICE_UNAVAILABLE_NOTICE);
              throw unavailable();
            }
          }

          this.setFallbackNotice(null);
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
              this.setFallbackNotice(LOCKED_VOICE_UNAVAILABLE_NOTICE);
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
      this.auditUtterance(operation, "page_sample", text);

      const canMap = hasMatchingSpeechWords(text, words);
      if (!canMap) options.onWordChange?.(-1);
      let elapsed = 0;
      let completedChunks = 0;
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
        const key = JSON.stringify([
          operation.voice.provider,
          operation.voice.cacheVoiceId,
          operation.voice.modelVersion,
          operation.voice.speed,
          chunk.words,
        ]);
        try {
          let timed = this.cache.get(key);
          if (!timed) {
            if (fallback && Date.now() < this.timedCooldownUntil) {
              await fallback();
              return;
            }
            timed = await this.wait(
              operation,
              this.studio.synthesizeTimed(chunk.words, {
                voiceId: operation.voice.requestedVoiceId,
                speed: operation.voice.speed,
                signal: operation.controller.signal,
              }),
            );
            this.ensure(operation);
            this.timedCooldownUntil = 0;
            this.cacheTimed(key, timed);
          }
          this.setFallbackNotice(
            timed.usedFallbackVoice ? SERVER_FALLBACK_VOICE_NOTICE : null,
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
          const invalid = this.cache.get(key);
          if (invalid) {
            this.cacheBytes -= invalid.audio.size;
            this.cache.delete(key);
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
