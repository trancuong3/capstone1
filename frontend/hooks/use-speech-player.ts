"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createSpeechService } from "@/lib/api/speech-service";
import { createVoiceStudioService } from "@/lib/api/voice-studio-service";
import { subscribeSpeechPreferences } from "@/lib/reading/speech-preferences";
import {
  TtsPlayback,
  type PlaybackState,
  type SpeechPlayOptions,
  type WordTimedPlayOptions,
} from "@/lib/reading/tts-playback";

export type { SpeechPlayOptions, WordTimedPlayOptions };

export interface SpeechPlayer {
  readonly isPlaying: boolean;
  readonly isPaused: boolean;
  readonly state: PlaybackState;
  play(text: string, options?: SpeechPlayOptions): Promise<void>;
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
  const actions = useMemo(
    () => ({
      play: (text: string, options?: SpeechPlayOptions) =>
        mounted.current
          ? player.play(text, options)
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
    }),
    [player],
  );
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeSpeechPreferences(player.stop);
    return () => {
      mounted.current = false;
      unsubscribe();
      player.dispose();
    };
  }, [player]);
  return {
    ...actions,
    state,
    isPlaying: ["loading", "playing", "paused", "fallback"].includes(state),
    isPaused: state === "paused",
    pause: player.pause,
    resume: player.resume,
    stop: player.stop,
  };
}
