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
  update: (value: Parameters<typeof setSpeechPreferences>[0]) => void;
} {
  const preferences = useSyncExternalStore(
    subscribeSpeechPreferences,
    getSpeechPreferences,
    () => SERVER_SNAPSHOT,
  );
  const update = useCallback(
    (value: Parameters<typeof setSpeechPreferences>[0]) => {
      setSpeechPreferences(value);
    },
    [],
  );
  return { preferences, update };
}
