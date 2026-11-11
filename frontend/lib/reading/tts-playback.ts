import type { SpeechService } from "@/lib/api/speech-service";
import type {
  TimedSpeech,
  VoiceStudioService,
  WordTiming,
} from "@/lib/api/voice-studio-service";
import { withRequestDeadline } from "@/lib/api/request-deadline";
import {
  getSpeechPreferences,
  type SpeechPreferences,
} from "@/lib/reading/speech-preferences";
import {
  hasMatchingSpeechWords,
  SHORT_TTS_MAX_CHARACTERS,
  speechWordAtCharacter,
  splitSpeechText,
} from "@/lib/reading/tts-text";
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
  onPlay?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  /** Browser boundaries only; audio without timing never guesses word indexes. */
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
interface Operation {
  readonly controller: AbortController;
  readonly preferences: SpeechPreferences;
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
    "Không có giọng đọc tiếng Việt khả dụng. Bé có thể thử lại nhé.",
  );
}
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Owns one synthesis operation, ordered chunk queue and media clock. */
export class TtsPlayback {
  private state: PlaybackState = "idle";
  private readonly listeners = new Set<() => void>();
  getState = (): PlaybackState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private onState = (state: PlaybackState): void => {
    if (state === this.state) return;
    this.state = state;
    this.listeners.forEach((listener) => listener());
  };
  private current: Operation | null = null;
  private media: ActiveMedia | null = null;
  private frame: number | null = null;
  private serverRetryAfter = 0;
  private timedRetryAfter = 0;
  private readonly cache = new Map<string, TimedSpeech>();
  private cacheBytes = 0;
  constructor(
    private readonly speech: SpeechService,
    private readonly studio: VoiceStudioService,
  ) {}

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
    } // Unsupported device pause is an honest stop.
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
    // Cancellation must settle even if an adapter ignores its AbortSignal.
    return withRequestDeadline(
      () => promise,
      operation.controller.signal,
      600_000,
    );
  }
  private async run(
    action: (operation: Operation) => Promise<void>,
  ): Promise<void> {
    this.stop();
    const operation: Operation = {
      controller: new AbortController(),
      preferences: getSpeechPreferences(),
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

  play = (text: string, options: SpeechPlayOptions = {}): Promise<void> =>
    this.run(async (operation) => {
      if (!text.trim()) throw unavailable();
      let elapsed = 0;
      for (const chunk of splitSpeechText(text, SHORT_TTS_MAX_CHARACTERS)) {
        await this.waitIfPaused(operation);
        this.ensure(operation);
        const onStart = (duration: number) =>
          this.started(operation, () => options.onPlay?.(duration));
        const onTime = (time: number, duration: number) =>
          options.onTimeUpdate?.(elapsed + time, elapsed + duration);
        let source: Blob | null = null;
        if (Date.now() >= this.serverRetryAfter) {
          try {
            source = await this.wait(
              operation,
              this.speech.synthesize(chunk.text, {
                voiceId: operation.preferences.voiceId ?? undefined,
                speed: operation.preferences.speed,
                signal: operation.controller.signal,
              }),
            );
            this.ensure(operation);
          } catch (error) {
            this.ensure(operation);
            if (isAbort(error)) throw error;
            this.serverRetryAfter = Date.now() + 60_000;
          }
        }
        let duration = 0;
        if (source) {
          try {
            duration = await this.playAudio(
              operation,
              source,
              undefined,
              0,
              onStart,
              undefined,
              onTime,
            );
          } catch (error) {
            this.ensure(operation);
            if (isAbort(error) || error instanceof PartialPlaybackError)
              throw error;
            source = null;
          }
        }
        if (!source) {
          this.onState("fallback");
          duration = await this.playBrowser(
            operation,
            chunk.text,
            onStart,
            (index) => options.onWordChange?.(chunk.wordOffset + index),
            onTime,
          );
        }
        elapsed += duration;
      }
      this.ensure(operation);
      options.onEnded?.();
    });

  playWithWordTimings = (
    words: readonly string[],
    options: WordTimedPlayOptions,
    fallback?: () => Promise<void>,
  ): Promise<void> =>
    this.run(async (operation) => {
      const text = options.text ?? words.join(" ");
      if (!text.trim()) throw unavailable();
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
          operation.preferences.voiceId,
          operation.preferences.speed,
          chunk.words,
        ]);
        try {
          if (Date.now() < this.timedRetryAfter) throw unavailable();
          let timed = this.cache.get(key);
          if (!timed) {
            timed = await this.wait(
              operation,
              this.studio.synthesizeTimed(chunk.words, {
                voiceId: operation.preferences.voiceId,
                speed: operation.preferences.speed,
                signal: operation.controller.signal,
              }),
            );
            this.ensure(operation);
            this.cacheTimed(key, timed);
          }
          elapsed += await this.playAudio(
            operation,
            timed.audio,
            timed.words,
            elapsed,
            onStart,
            onWord,
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
          this.timedRetryAfter = Date.now() + 30_000;
          if (!completedChunks && fallback) {
            // Compatibility for an explicit entire-page fallback. A later
            // chunk failure must never replay a previously completed chunk.
            await fallback();
            return;
          }
          this.onState("fallback");
          for (const part of splitSpeechText(
            chunk.text,
            SHORT_TTS_MAX_CHARACTERS,
          )) {
            await this.waitIfPaused(operation);
            elapsed += await this.playBrowser(
              operation,
              part.text,
              onStart,
              (index) => onWord(part.wordOffset + index),
            );
          }
        }
        completedChunks += 1;
      }
      this.ensure(operation);
      options.onEnded?.();
    });

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

  private async playAudio(
    operation: Operation,
    source: Blob,
    timeline: readonly WordTiming[] | undefined,
    offset: number,
    onStart: (duration: number) => void,
    onWord?: (index: number) => void,
    onTime?: (time: number, duration: number) => void,
  ): Promise<number> {
    this.ensure(operation);
    if (!source.size || !source.type.startsWith("audio/")) throw unavailable();
    await this.waitIfPaused(operation);
    this.ensure(operation);
    const url = URL.createObjectURL(source);
    let audio: HTMLAudioElement;
    try {
      audio = new Audio(url);
      this.ensure(operation);
    } catch (error) {
      URL.revokeObjectURL(url);
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
        URL.revokeObjectURL(url);
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

  private async vietnameseVoice(
    operation: Operation,
    synthesis: SpeechSynthesis,
  ): Promise<SpeechSynthesisVoice> {
    const choose = () =>
      synthesis.getVoices().find((voice) => /^vi(?:[-_]|$)/iu.test(voice.lang));
    const voice = choose();
    if (voice) return voice;
    if (synthesis.getVoices().length) throw unavailable();
    return new Promise((resolve, reject) => {
      const signal = operation.controller.signal;
      const finish = (found?: SpeechSynthesisVoice, error?: unknown) => {
        clearTimeout(timer);
        synthesis.removeEventListener?.("voiceschanged", changed);
        signal.removeEventListener("abort", abort);
        if (found) resolve(found);
        else reject(error ?? unavailable());
      };
      const changed = () => {
        const found = choose();
        if (found) finish(found);
      };
      const abort = () => finish(undefined, stopped());
      const timer = setTimeout(() => finish(), 1_500);
      synthesis.addEventListener?.("voiceschanged", changed);
      signal.addEventListener("abort", abort, { once: true });
      changed();
    });
  }

  private async playBrowser(
    operation: Operation,
    text: string,
    onStart: (duration: number) => void,
    onWord?: (index: number) => void,
    onTime?: (time: number, duration: number) => void,
  ): Promise<number> {
    this.ensure(operation);
    if (
      !window.speechSynthesis ||
      typeof SpeechSynthesisUtterance === "undefined"
    )
      throw unavailable();
    const synthesis = window.speechSynthesis;
    const voice = await this.vietnameseVoice(operation, synthesis);
    await this.waitIfPaused(operation);
    this.ensure(operation);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "vi-VN";
    utterance.voice = voice;
    utterance.rate = operation.preferences.speed;
    utterance.pitch = 1;
    const estimate = Math.max(
      0.5,
      (text.match(/\S+/gu)?.length ?? 0) / (2.25 * operation.preferences.speed),
    );
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const signal = operation.controller.signal;
      const active = () =>
        !settled && this.current === operation && !signal.aborted;
      const finish = (error?: unknown, duration = estimate) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        utterance.onstart =
          utterance.onboundary =
          utterance.onend =
          utterance.onerror =
            null;
        if (this.media === media) this.media = null;
        if (error) reject(error);
        else resolve(duration);
      };
      const cancel = () => {
        try {
          synthesis.cancel();
        } catch {
          /* Already released our listeners and promise. */
        }
      };
      const abort = () => {
        finish(stopped());
        cancel();
      };
      let timer = setTimeout(
        () => {
          finish(unavailable());
          cancel();
        },
        Math.max(15_000, estimate * 4_000),
      );
      const media: ActiveMedia = {
        pause: () => {
          if (!synthesis.pause) throw unavailable();
          clearTimeout(timer);
          synthesis.pause();
        },
        resume: async () => {
          if (!synthesis.resume) throw unavailable();
          synthesis.resume();
          timer = setTimeout(
            () => {
              finish(unavailable());
              cancel();
            },
            Math.max(15_000, estimate * 4_000),
          );
        },
      };
      this.media = media;
      signal.addEventListener("abort", abort, { once: true });
      utterance.onstart = () => {
        if (active()) {
          this.onState(operation.paused ? "paused" : "playing");
          if (operation.paused) media.pause();
          onStart(estimate);
        }
      };
      let lastIndex = -1;
      utterance.onboundary = (event) => {
        if (!active() || operation.paused) return;
        const index = speechWordAtCharacter(text, event.charIndex);
        if (index >= 0 && index !== lastIndex) {
          lastIndex = index;
          onWord?.(index);
        }
        if (Number.isFinite(event.elapsedTime))
          onTime?.(event.elapsedTime, estimate);
      };
      utterance.onend = (event) => {
        if (!active()) return;
        const duration =
          Number.isFinite(event.elapsedTime) && event.elapsedTime > 0
            ? event.elapsedTime
            : estimate;
        onTime?.(duration, duration);
        finish(undefined, duration);
      };
      utterance.onerror = (event) => {
        if (active())
          finish(
            ["canceled", "interrupted"].includes(event.error)
              ? stopped()
              : unavailable(),
          );
      };
      try {
        synthesis.speak(utterance);
      } catch (error) {
        finish(error);
      }
    });
  }
}

/** A started chunk cannot automatically be replayed without repeating words. */
class PartialPlaybackError extends Error {
  constructor() {
    super("Âm thanh bị gián đoạn. Bé có thể nghe lại từ đầu nhé.");
  }
}
