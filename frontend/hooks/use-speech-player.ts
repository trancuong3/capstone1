"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createSpeechService } from "@/lib/api/speech-service";
import { createVoiceStudioService } from "@/lib/api/voice-studio-service";
import {
  getAndroidSpeechCapabilities,
  isAndroidNativeSpeechAvailable,
  openAndroidTtsInstallSettings,
} from "@/lib/reading/native-speech-bridge";
import type { SupportedPhonicsLessonPlan } from "@/lib/reading/phonics-lesson";
import { subscribeVoicePolicy } from "@/lib/reading/session-voice-lock";
import { subscribeSpeechPreferences } from "@/lib/reading/speech-preferences";
import {
  TtsPlayback,
  type ActiveAudioKind,
  type PhonicsPlayOptions,
  type PlaybackState,
  type SpeechPlayOptions,
  type TtsPlaybackCacheContext,
  type WordTimedPlayOptions,
} from "@/lib/reading/tts-playback";
import {
  getServerVoiceEngineStatus,
  getVoiceEngineStatus,
  subscribeVoiceEngineStatus,
  type TtsUnavailableReason,
} from "@/lib/reading/voice-engine-status";

export type {
  ActiveAudioKind,
  PhonicsPlayOptions,
  SpeechPlayOptions,
  TtsPlaybackCacheContext,
  TtsUnavailableReason,
  WordTimedPlayOptions,
};

export interface SpeechPlayer {
  readonly isPlaying: boolean;
  readonly isLoading?: boolean;
  readonly isActuallyPlaying?: boolean;
  readonly isPaused: boolean;
  readonly state: PlaybackState;
  readonly activeAudioKind?: ActiveAudioKind;
  readonly fallbackNotice: string | null;
  readonly voiceNotice?: string | null;
  readonly ttsUnavailableReason?: TtsUnavailableReason | null;
  readonly canInstallVietnameseTtsVoice?: boolean;
  openTtsInstallSettings?: () => Promise<boolean>;
  setCacheContext?: (context: TtsPlaybackCacheContext | null) => void;
  play(text: string, options?: SpeechPlayOptions): Promise<void>;
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
  const activeAudioKind = useSyncExternalStore(
    player.subscribe,
    player.getActiveAudioKind,
    () => "idle" as ActiveAudioKind,
  );
  const fallbackNotice = useSyncExternalStore(
    player.subscribe,
    player.getFallbackNotice,
    () => null,
  );
  const engineStatus = useSyncExternalStore(
    subscribeVoiceEngineStatus,
    getVoiceEngineStatus,
    getServerVoiceEngineStatus,
  );
  const actions = useMemo(
    () => ({
      play: (text: string, options?: SpeechPlayOptions) =>
        mounted.current
          ? player.play(text, options)
          : Promise.reject(
              new DOMException("Audio player is not ready", "AbortError"),
            ),
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
      openTtsInstallSettings: async () => {
        const opened = await openAndroidTtsInstallSettings();
        if (opened) {
          void getAndroidSpeechCapabilities({ forceRefresh: true }).catch(
            () => null,
          );
        }
        return opened;
      },
    }),
    [player],
  );
  useEffect(() => {
    mounted.current = true;
    if (isAndroidNativeSpeechAvailable()) {
      void getAndroidSpeechCapabilities().catch(() => null);
    }
    const unsubSpeech = subscribeSpeechPreferences(
      player.handlePreferencesChange,
    );
    const unsubPolicy = subscribeVoicePolicy(player.handlePreferencesChange);
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
  return {
    ...actions,
    state,
    activeAudioKind,
    fallbackNotice,
    voiceNotice: engineStatus.voiceNotice,
    ttsUnavailableReason: engineStatus.ttsUnavailableReason,
    canInstallVietnameseTtsVoice: engineStatus.canInstallVietnameseTtsVoice,
    isPlaying: ["loading", "playing", "paused", "fallback"].includes(state),
    isLoading: state === "loading",
    isActuallyPlaying: state === "playing",
    isPaused: state === "paused",
    pause: player.pause,
    resume: player.resume,
    stop: player.stop,
  };
}
