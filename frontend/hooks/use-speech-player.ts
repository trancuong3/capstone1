"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createSpeechService } from "@/lib/api/speech-service";
import {
  createVoiceStudioService,
  type TimedSpeech,
} from "@/lib/api/voice-studio-service";
import { getSpeechPreferences } from "@/lib/reading/speech-preferences";
import {
  findActiveWordIndex,
  HIGHLIGHT_LEAD_SECONDS,
} from "@/lib/reading/word-timeline";

export interface SpeechPlayOptions {
  onPlay?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
}

export interface WordTimedPlayOptions {
  onPlay?: () => void;
  /** Called whenever the spoken word changes, with its index in `words`. */
  onWordChange?: (index: number) => void;
  onEnded?: () => void;
}

export interface SpeechPlayer {
  readonly isPlaying: boolean;
  play(text: string, options?: SpeechPlayOptions): Promise<void>;
  /**
   * Plays `words` with the chosen voice and speed and reports the exact word
   * being spoken. When word timings are unavailable nothing is played and
   * `fallback` runs instead, so reading a sample never gets worse than before.
   */
  playWithWordTimings(
    words: readonly string[],
    options: WordTimedPlayOptions,
    fallback: () => Promise<void>,
  ): Promise<void>;
  stop(): void;
}

interface ActivePlayback {
  readonly audio: HTMLAudioElement;
  readonly objectUrl: string;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

interface ActiveBrowserPlayback {
  readonly utterance: SpeechSynthesisUtterance;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

function playbackError(message: string): Error {
  return new Error(message);
}

function playbackStoppedError(): Error {
  const error = new Error("Audio playback was stopped.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function estimateSpeechDuration(text: string): number {
  const wordCount = text.trim().split(/\s+/u).filter(Boolean).length;
  return Math.max(0.5, wordCount / 2.25);
}

const SERVER_TTS_RETRY_DELAY_MS = 60_000;
const TIMED_TTS_RETRY_DELAY_MS = 30_000;
const TIMED_CACHE_LIMIT = 6;

/** Uses server TTS when available, with the device's Vietnamese voice as fallback. */
export function useSpeechPlayer(): SpeechPlayer {
  const speechService = useMemo(() => createSpeechService(), []);
  const voiceStudio = useMemo(() => createVoiceStudioService(), []);
  const timedUnavailableUntilRef = useRef(0);
  const timedCacheRef = useRef(new Map<string, TimedSpeech>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const activePlaybackRef = useRef<ActivePlayback | null>(null);
  const activeBrowserPlaybackRef = useRef<ActiveBrowserPlayback | null>(null);
  const serverTtsRetryAfterRef = useRef(0);
  const playGenerationRef = useRef(0);
  const animFrameRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const stop = useCallback(() => {
    playGenerationRef.current += 1;
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    const playback = activePlaybackRef.current;
    activePlaybackRef.current = null;
    const browserPlayback = activeBrowserPlaybackRef.current;
    activeBrowserPlaybackRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.ontimeupdate = null;
      audio.onloadedmetadata = null;
      audio.pause();
      audio.src = "";
    }

    const objectUrl = objectUrlRef.current;
    objectUrlRef.current = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (mountedRef.current) setIsPlaying(false);
    if (playback && !playback.settled) {
      playback.settled = true;
      playback.reject(playbackStoppedError());
    }
    if (browserPlayback && !browserPlayback.settled) {
      browserPlayback.settled = true;
      try {
        window.speechSynthesis?.cancel();
      } catch {
        // Ignore browser speech cancellation failures during cleanup.
      }
      browserPlayback.reject(playbackStoppedError());
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  const play = useCallback(
    async (text: string, options?: SpeechPlayOptions) => {
      if (!mountedRef.current) {
        throw playbackError("Audio player is not ready.");
      }

      stop();
      const generation = playGenerationRef.current;
      const playOnDevice = async (serverError: unknown): Promise<void> => {
        if (!mountedRef.current || generation !== playGenerationRef.current) {
          throw playbackStoppedError();
        }
        if (
          typeof window === "undefined" ||
          !window.speechSynthesis ||
          typeof SpeechSynthesisUtterance === "undefined"
        ) {
          throw serverError instanceof Error
            ? serverError
            : playbackError("Không có giọng đọc khả dụng trên thiết bị này.");
        }

        const synthesis = window.speechSynthesis;
        const utterance = new SpeechSynthesisUtterance(text);
        const duration = estimateSpeechDuration(text);
        utterance.lang = "vi-VN";
        utterance.rate = 0.92;
        utterance.pitch = 1;
        const vietnameseVoice = synthesis
          .getVoices()
          .find((voice) => /^vi(?:[-_]|$)/iu.test(voice.lang));
        if (vietnameseVoice) utterance.voice = vietnameseVoice;

        setIsPlaying(true);
        await new Promise<void>((resolve, reject) => {
          const browserPlayback: ActiveBrowserPlayback = {
            utterance,
            reject,
            settled: false,
          };
          activeBrowserPlaybackRef.current = browserPlayback;

          const finish = (error?: Error) => {
            if (browserPlayback.settled) return;
            browserPlayback.settled = true;
            if (activeBrowserPlaybackRef.current === browserPlayback) {
              activeBrowserPlaybackRef.current = null;
            }
            utterance.onstart = null;
            utterance.onboundary = null;
            utterance.onend = null;
            utterance.onerror = null;
            if (mountedRef.current) setIsPlaying(false);
            if (error) reject(error);
            else resolve();
          };

          utterance.onstart = () => {
            if (activeBrowserPlaybackRef.current !== browserPlayback) return;
            options?.onPlay?.(duration);
          };
          utterance.onboundary = (event) => {
            if (
              activeBrowserPlaybackRef.current !== browserPlayback ||
              !text.length
            ) {
              return;
            }
            const progress = Math.max(
              0,
              Math.min(1, event.charIndex / text.length),
            );
            options?.onTimeUpdate?.(progress * duration, duration);
          };
          utterance.onend = () => {
            if (activeBrowserPlaybackRef.current !== browserPlayback) return;
            options?.onTimeUpdate?.(duration, duration);
            try {
              options?.onEnded?.();
            } finally {
              finish();
            }
          };
          utterance.onerror = (event) => {
            const error =
              event.error === "canceled" || event.error === "interrupted"
                ? playbackStoppedError()
                : playbackError("Không thể phát âm thanh trên thiết bị này.");
            finish(error);
          };

          try {
            synthesis.speak(utterance);
          } catch (error) {
            finish(
              error instanceof Error
                ? error
                : playbackError("Không thể phát âm thanh trên thiết bị này."),
            );
          }
        });
      };

      if (Date.now() < serverTtsRetryAfterRef.current) {
        await playOnDevice(
          playbackError("Using the device's built-in Vietnamese voice."),
        );
        return;
      }

      let source: Blob;
      try {
        const voiceId = getSpeechPreferences().voiceId;
        source = await (voiceId
          ? speechService.synthesize(text, { voiceId })
          : speechService.synthesize(text));
        serverTtsRetryAfterRef.current = 0;
      } catch (error) {
        serverTtsRetryAfterRef.current = Date.now() + SERVER_TTS_RETRY_DELAY_MS;
        await playOnDevice(error);
        return;
      }
      if (!mountedRef.current || generation !== playGenerationRef.current) {
        throw playbackStoppedError();
      }

      let objectUrl: string | null = null;
      let audio: HTMLAudioElement;
      try {
        objectUrl = URL.createObjectURL(source);
        audio = new Audio(objectUrl);
      } catch (error) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        await playOnDevice(error);
        return;
      }
      objectUrlRef.current = objectUrl;
      audioRef.current = audio;
      setIsPlaying(true);

      try {
        await new Promise<void>((resolve, reject) => {
          const playback: ActivePlayback = {
            audio,
            objectUrl,
            reject,
            settled: false,
          };
          activePlaybackRef.current = playback;

          const finish = (error?: Error) => {
            if (playback.settled) return;
            playback.settled = true;
            if (activePlaybackRef.current === playback) {
              activePlaybackRef.current = null;
              audioRef.current = null;
              objectUrlRef.current = null;
            }
            audio.onended = null;
            audio.onerror = null;
            audio.ontimeupdate = null;
            audio.onloadedmetadata = null;
            if (animFrameRef.current !== null) {
              cancelAnimationFrame(animFrameRef.current);
              animFrameRef.current = null;
            }
            audio.pause();
            audio.src = "";
            URL.revokeObjectURL(objectUrl);
            if (mountedRef.current) setIsPlaying(false);
            if (error) reject(error);
            else resolve();
          };

          audio.onended = () => {
            try {
              options?.onEnded?.();
            } finally {
              finish();
            }
          };
          audio.onerror = () =>
            finish(
              playbackError("Không thể phát âm thanh. Bé thử nghe lại nhé."),
            );

          const updateProgress = () => {
            if (
              activePlaybackRef.current !== playback ||
              audio.paused ||
              audio.ended
            ) {
              return;
            }
            const duration = audio.duration;
            if (duration && Number.isFinite(duration) && duration > 0) {
              options?.onTimeUpdate?.(audio.currentTime, duration);
              animFrameRef.current = requestAnimationFrame(updateProgress);
            }
          };

          audio.onloadedmetadata = () => {
            const duration = audio.duration;
            if (duration && Number.isFinite(duration) && duration > 0) {
              options?.onPlay?.(duration);
            }
          };
          audio.ontimeupdate = () => {
            const duration = audio.duration;
            if (duration && Number.isFinite(duration) && duration > 0) {
              options?.onTimeUpdate?.(audio.currentTime, duration);
            }
          };

          void audio
            .play()
            .then(() => {
              if (activePlaybackRef.current !== playback) return;
              const duration = audio.duration;
              if (duration && Number.isFinite(duration) && duration > 0) {
                options?.onPlay?.(duration);
              }
              if (options?.onTimeUpdate) {
                animFrameRef.current = requestAnimationFrame(updateProgress);
              }
            })
            .catch((error: unknown) => {
              finish(
                error instanceof Error
                  ? error
                  : playbackError(
                      "Không thể phát âm thanh. Bé thử nghe lại nhé.",
                    ),
              );
            });
        });
      } catch (error) {
        if (
          isAbortError(error) ||
          !mountedRef.current ||
          generation !== playGenerationRef.current
        ) {
          throw error;
        }
        await playOnDevice(error);
      }
    },
    [speechService, stop],
  );

  const playWithWordTimings = useCallback(
    async (
      words: readonly string[],
      options: WordTimedPlayOptions,
      fallback: () => Promise<void>,
    ) => {
      if (!mountedRef.current) {
        throw playbackError("Audio player is not ready.");
      }
      stop();
      const generation = playGenerationRef.current;
      if (words.length === 0 || Date.now() < timedUnavailableUntilRef.current) {
        return fallback();
      }

      const { voiceId, speed } = getSpeechPreferences();
      const cacheKey = `${voiceId ?? ""}|${speed}|${words.join(" ")}`;
      const cache = timedCacheRef.current;
      let timed = cache.get(cacheKey);
      if (!timed) {
        try {
          timed = await voiceStudio.synthesizeTimed(words, { voiceId, speed });
        } catch {
          if (!mountedRef.current || generation !== playGenerationRef.current) {
            throw playbackStoppedError();
          }
          timedUnavailableUntilRef.current =
            Date.now() + TIMED_TTS_RETRY_DELAY_MS;
          return fallback();
        }
        cache.set(cacheKey, timed);
        if (cache.size > TIMED_CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
      if (!mountedRef.current || generation !== playGenerationRef.current) {
        throw playbackStoppedError();
      }

      const timeline = timed.words;
      let objectUrl: string | null = null;
      let audio: HTMLAudioElement;
      try {
        objectUrl = URL.createObjectURL(timed.audio);
        audio = new Audio(objectUrl);
      } catch {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return fallback();
      }
      const url = objectUrl;
      objectUrlRef.current = url;
      audioRef.current = audio;
      setIsPlaying(true);

      try {
        await new Promise<void>((resolve, reject) => {
          const playback: ActivePlayback = {
            audio,
            objectUrl: url,
            reject,
            settled: false,
          };
          activePlaybackRef.current = playback;
          let lastIndex = -1;

          const finish = (error?: Error) => {
            if (playback.settled) return;
            playback.settled = true;
            if (activePlaybackRef.current === playback) {
              activePlaybackRef.current = null;
              audioRef.current = null;
              objectUrlRef.current = null;
            }
            audio.onended = null;
            audio.onerror = null;
            if (animFrameRef.current !== null) {
              cancelAnimationFrame(animFrameRef.current);
              animFrameRef.current = null;
            }
            audio.pause();
            audio.src = "";
            URL.revokeObjectURL(url);
            if (mountedRef.current) setIsPlaying(false);
            if (error) reject(error);
            else resolve();
          };

          // Drive the highlight from the audio clock, not from an estimate.
          const tick = () => {
            if (
              activePlaybackRef.current !== playback ||
              audio.paused ||
              audio.ended
            ) {
              return;
            }
            const index = findActiveWordIndex(
              timeline,
              audio.currentTime + HIGHLIGHT_LEAD_SECONDS,
            );
            if (index >= 0 && index !== lastIndex) {
              lastIndex = index;
              options.onWordChange?.(index);
            }
            animFrameRef.current = requestAnimationFrame(tick);
          };

          audio.onended = () => {
            try {
              options.onEnded?.();
            } finally {
              finish();
            }
          };
          audio.onerror = () =>
            finish(
              playbackError("Không thể phát âm thanh. Bé thử nghe lại nhé."),
            );

          void audio
            .play()
            .then(() => {
              if (activePlaybackRef.current !== playback) return;
              options.onPlay?.();
              animFrameRef.current = requestAnimationFrame(tick);
            })
            .catch((error: unknown) => {
              finish(
                error instanceof Error
                  ? error
                  : playbackError(
                      "Không thể phát âm thanh. Bé thử nghe lại nhé.",
                    ),
              );
            });
        });
      } catch (error) {
        if (
          isAbortError(error) ||
          !mountedRef.current ||
          generation !== playGenerationRef.current
        ) {
          throw error;
        }
        return fallback();
      }
    },
    [stop, voiceStudio],
  );

  return { isPlaying, play, playWithWordTimings, stop };
}
