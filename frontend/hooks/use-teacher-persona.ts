"use client";

import { useSyncExternalStore } from "react";

import {
  getEffectiveTeacherPersona,
  subscribeVoiceLock,
  subscribeVoicePolicy,
} from "@/lib/reading/session-voice-lock";
import { subscribeSpeechPreferences } from "@/lib/reading/speech-preferences";
import {
  getTeacherPersona,
  type TeacherPersona,
} from "@/lib/reading/voice-persona";

const DEFAULT_SERVER_PERSONA: TeacherPersona = getTeacherPersona("female");

function subscribeTeacherPersona(listener: () => void): () => void {
  const unsubPolicy = subscribeVoicePolicy(listener);
  const unsubLock = subscribeVoiceLock(listener);
  const unsubSpeech = subscribeSpeechPreferences(listener);
  return () => {
    unsubPolicy();
    unsubLock();
    unsubSpeech();
  };
}

function getServerTeacherPersona(): TeacherPersona {
  return DEFAULT_SERVER_PERSONA;
}

/**
 * Reactively subscribes to the active Teacher Persona ("Cô giáo AI" vs "Thầy giáo AI")
 * across voice policy, session voice lock, and speech preference updates.
 */
export function useTeacherPersona(): TeacherPersona {
  return useSyncExternalStore(
    subscribeTeacherPersona,
    getEffectiveTeacherPersona,
    getServerTeacherPersona,
  );
}
