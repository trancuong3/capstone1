"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  getSpeechPreferences,
  setSpeechPreferences,
  subscribeSpeechPreferences,
  type SpeechPreferences,
} from "@/lib/reading/speech-preferences";

const SERVER_SNAPSHOT: SpeechPreferences = { voiceId: null, speed: 0.9 };

/** Voice and speed chosen for the sample reading, shared across components. */
export function useSpeechPreferences(): {
  preferences: SpeechPreferences;
  update: (value: Partial<SpeechPreferences>) => void;
} {
  const preferences = useSyncExternalStore(
    subscribeSpeechPreferences,
    getSpeechPreferences,
    () => SERVER_SNAPSHOT,
  );
  const update = useCallback((value: Partial<SpeechPreferences>) => {
    setSpeechPreferences(value);
  }, []);
  return { preferences, update };
}
