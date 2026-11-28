"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createSpeechService } from "@/lib/api/speech-service";
import { createVoiceStudioService } from "@/lib/api/voice-studio-service";
import type { SupportedPhonicsLessonPlan } from "@/lib/reading/phonics-lesson";
import { subscribeVoicePolicyPreferences } from "@/lib/reading/session-voice-lock";
import { subscribeSpeechPreferences } from "@/lib/reading/speech-preferences";
import {
  TtsPlayback,
  type PhonicsPlayOptions,
  type PlaybackState,
  type SpeechPlayOptions,
  type TtsPlaybackCacheContext,
  type WordTimedPlayOptions,
} from "@/lib/reading/tts-playback";

export type {
  PhonicsPlayOptions,
  SpeechPlayOptions,
  TtsPlaybackCacheContext,
  WordTimedPlayOptions,
};

export interface SpeechPlayer {
  readonly isPlaying: boolean;
  readonly isPaused: boolean;
  readonly state: PlaybackState;
  readonly fallbackNotice: string | null;
  setCacheContext?: (context: TtsPlaybackCacheContext | null) => void;
  play(text: string, options?: SpeechPlayOptions): Promise<void>;
  prefetch?(
    text: string,
    options?: {
      readonly coaching?: boolean;
      readonly wordSample?: boolean;
      readonly speedScale?: number;
      readonly bypassSessionLock?: boolean;
      readonly cacheScope?: SpeechPlayOptions["cacheScope"];
      readonly signal?: AbortSignal;
    },
  ): Promise<void>;
  playPhonicsLesson(
    lesson: SupportedPhonicsLessonPlan,
    options?: PhonicsPlayOptions,
  ): Promise<void>;
  playWithWordTimings(
    words: readonly string[],
    options: WordTimedPlayOptions,
    fallback?: () => Promise<void>,
  ): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  stop(): void;
}

export function useSpeechPlayer(): SpeechPlayer {
  const mounted = useRef(false);
  const player = useMemo(
    () => new TtsPlayback(createSpeechService(), createVoiceStudioService()),
    [],
  );
  const state = useSyncExternalStore(
    player.subscribe,
    player.getState,
    () => "idle" as PlaybackState,
  );
  const fallbackNotice = useSyncExternalStore(
    player.subscribe,
    player.getFallbackNotice,
    () => null,
  );
  const actions = useMemo(
    () => ({
      play: (text: string, options?: SpeechPlayOptions) =>
        mounted.current
          ? player.play(text, options)
          : Promise.reject(
              new DOMException("Audio player is not ready", "AbortError"),
            ),
      prefetch: (
        text: string,
        options?: {
          readonly coaching?: boolean;
          readonly wordSample?: boolean;
          readonly speedScale?: number;
          readonly bypassSessionLock?: boolean;
          readonly cacheScope?: SpeechPlayOptions["cacheScope"];
          readonly signal?: AbortSignal;
        },
      ) =>
        mounted.current ? player.prefetch(text, options) : Promise.resolve(),
      playPhonicsLesson: (
        lesson: SupportedPhonicsLessonPlan,
        options?: PhonicsPlayOptions,
      ) =>
        mounted.current
          ? player.playPhonicsLesson(lesson, options)
          : Promise.reject(
              new DOMException("Audio player is not ready", "AbortError"),
            ),
      playWithWordTimings: (
        words: readonly string[],
        options: WordTimedPlayOptions,
        fallback?: () => Promise<void>,
      ) =>
        mounted.current
          ? player.playWithWordTimings(words, options, fallback)
          : Promise.reject(
              new DOMException("Audio player is not ready", "AbortError"),
            ),
      setCacheContext: player.setCacheContext,
    }),
    [player],
  );
  useEffect(() => {
    mounted.current = true;
    const unsubSpeech = subscribeSpeechPreferences(
      player.handlePreferencesChange,
    );
    const unsubPolicy = subscribeVoicePolicyPreferences(
      player.handlePreferencesChange,
    );
    const onAndroidBackground = () => {
      player.stop();
    };
    document.addEventListener("viread:android-background", onAndroidBackground);
    return () => {
      mounted.current = false;
      document.removeEventListener(
        "viread:android-background",
        onAndroidBackground,
      );
      unsubSpeech();
      unsubPolicy();
      player.dispose();
    };
  }, [player]);
  return useMemo(
    () => ({
      ...actions,
      state,
      fallbackNotice,
      isPlaying: ["loading", "playing", "paused", "fallback"].includes(state),
      isPaused: state === "paused",
      pause: player.pause,
      resume: player.resume,
      stop: player.stop,
    }),
    [actions, state, fallbackNotice, player],
  );
}
