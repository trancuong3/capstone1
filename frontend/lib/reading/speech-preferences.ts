/**
 * Child-friendly AI teacher voice choices, remembered locally and synced
 * across tabs + persisted per child profile.
 */

import {
  inferIntrinsicVoiceGender,
  normalizeVoiceGender,
  type VoiceGender,
} from "@/lib/reading/voice-persona";

export const SPEED_MIN = 0.7;
export const SPEED_MAX = 1.2;
export const SPEED_STEP = 0.05;
export const DEFAULT_SPEED = 0.9;

export interface SpeechPreferences {
  /** `null` means the server's default voice (female north). */
  readonly voiceId: string | null;
  readonly speed: number;
}

export interface SpeechPreferencesMeta {
  readonly gender: VoiceGender;
  readonly updatedAt: number;
  /** Timestamp stamped ONLY by explicit global teacher voice switches (not bare low-level setSpeechPreferences). */
  readonly globalSelectionUpdatedAt: number;
  /** Child profile ID that currently owns this active voice preference (null when unassigned). */
  readonly childId?: string | null;
}

export const SPEECH_PREFERENCES_STORAGE_KEY = "viread.speech-preferences.v1";
export const SPEECH_PREFERENCES_META_STORAGE_KEY =
  "viread.speech-preferences.meta.v1";
const DEFAULT_PREFERENCES: SpeechPreferences = {
  voiceId: null,
  speed: DEFAULT_SPEED,
};
const DEFAULT_META: SpeechPreferencesMeta = {
  gender: "female",
  updatedAt: 0,
  globalSelectionUpdatedAt: 0,
  childId: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: SpeechPreferences | null = null;
let cachedMeta: SpeechPreferencesMeta | null = null;
let storageSyncInstalled = false;

export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPEED;
  const stepped = Math.round(value / SPEED_STEP) * SPEED_STEP;
  return Number(Math.min(SPEED_MAX, Math.max(SPEED_MIN, stepped)).toFixed(2));
}

function sanitize(value: unknown): SpeechPreferences {
  if (typeof value !== "object" || value === null) return DEFAULT_PREFERENCES;
  const record = value as Record<string, unknown>;
  const voiceId =
    typeof record.voiceId === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(record.voiceId)
      ? record.voiceId
      : null;
  const speed =
    typeof record.speed === "number" ? clampSpeed(record.speed) : DEFAULT_SPEED;
  return { voiceId, speed };
}

function sanitizeMeta(
  value: unknown,
  voiceId: string | null,
): SpeechPreferencesMeta {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const explicitGender =
    typeof record.gender === "string"
      ? normalizeVoiceGender(record.gender)
      : null;
  const gender: VoiceGender =
    (voiceId ? inferIntrinsicVoiceGender(voiceId) : null) ??
    explicitGender ??
    "female";
  const updatedAt =
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt) &&
    record.updatedAt >= 0
      ? Math.floor(record.updatedAt)
      : 0;
  const globalSelectionUpdatedAt =
    typeof record.globalSelectionUpdatedAt === "number" &&
    Number.isFinite(record.globalSelectionUpdatedAt) &&
    record.globalSelectionUpdatedAt >= 0
      ? Math.floor(record.globalSelectionUpdatedAt)
      : 0;
  const childId =
    typeof record.childId === "string" &&
    record.childId.trim().length > 0 &&
    record.childId.trim().length <= 100
      ? record.childId.trim()
      : null;
  return { gender, updatedAt, globalSelectionUpdatedAt, childId };
}

function read(): SpeechPreferences {
  try {
    const raw = window.localStorage.getItem(SPEECH_PREFERENCES_STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_PREFERENCES;
  } catch {
    // Private mode or blocked storage: keep working with defaults.
    return DEFAULT_PREFERENCES;
  }
}

function readMeta(voiceId: string | null): SpeechPreferencesMeta {
  try {
    const raw = window.localStorage.getItem(
      SPEECH_PREFERENCES_META_STORAGE_KEY,
    );
    return raw
      ? sanitizeMeta(JSON.parse(raw), voiceId)
      : sanitizeMeta(null, voiceId);
  } catch {
    return sanitizeMeta(null, voiceId);
  }
}

function ensureStorageSync(): void {
  if (storageSyncInstalled || typeof window === "undefined") return;
  storageSyncInstalled = true;
  window.addEventListener("storage", (event) => {
    if (
      event.key !== SPEECH_PREFERENCES_STORAGE_KEY &&
      event.key !== SPEECH_PREFERENCES_META_STORAGE_KEY
    ) {
      return;
    }
    if (event.key === SPEECH_PREFERENCES_STORAGE_KEY) {
      cached = event.newValue
        ? (() => {
            try {
              return sanitize(JSON.parse(event.newValue));
            } catch {
              return DEFAULT_PREFERENCES;
            }
          })()
        : DEFAULT_PREFERENCES;
    }
    cachedMeta = readMeta((cached ?? read()).voiceId);
    listeners.forEach((listener) => listener());
  });
}

export function getSpeechPreferences(): SpeechPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  ensureStorageSync();
  if (cached === null) cached = read();
  return cached;
}

export function getSpeechPreferencesMeta(): SpeechPreferencesMeta {
  if (typeof window === "undefined") return DEFAULT_META;
  ensureStorageSync();
  const prefs = getSpeechPreferences();
  if (cachedMeta === null) cachedMeta = readMeta(prefs.voiceId);
  return cachedMeta;
}

export function getSpeechPreferencesUpdatedAt(): number {
  return getSpeechPreferencesMeta().updatedAt;
}

export function getGlobalVoiceSelectionUpdatedAt(): number {
  return getSpeechPreferencesMeta().globalSelectionUpdatedAt;
}

export function setSpeechPreferencesMeta(
  update: Partial<SpeechPreferencesMeta>,
): SpeechPreferencesMeta {
  const prefs = getSpeechPreferences();
  const current = getSpeechPreferencesMeta();
  const next = sanitizeMeta(
    {
      ...current,
      ...update,
    },
    prefs.voiceId,
  );
  cachedMeta = next;
  try {
    window.localStorage.setItem(
      SPEECH_PREFERENCES_META_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // Keep in-memory copy when storage is unavailable.
  }
  return next;
}

export function setSpeechPreferences(
  update: Partial<SpeechPreferences> & {
    readonly gender?: VoiceGender;
    readonly updatedAt?: number;
    readonly globalSelectionUpdatedAt?: number;
    readonly childId?: string | null;
  },
): SpeechPreferences {
  const current = getSpeechPreferences();
  const next = sanitize({
    voiceId: update.voiceId !== undefined ? update.voiceId : current.voiceId,
    speed: update.speed !== undefined ? update.speed : current.speed,
  });
  const currentMeta = getSpeechPreferencesMeta();
  const intrinsicGender =
    next.voiceId !== null ? inferIntrinsicVoiceGender(next.voiceId) : null;
  const fallbackExplicit =
    update.gender ??
    (next.voiceId === current.voiceId ? currentMeta.gender : undefined);
  const nextGender: VoiceGender =
    intrinsicGender ?? fallbackExplicit ?? "female";
  const nextUpdatedAt =
    update.updatedAt !== undefined ? update.updatedAt : Date.now();
  const nextGlobalSelectionUpdatedAt =
    update.globalSelectionUpdatedAt !== undefined
      ? update.globalSelectionUpdatedAt
      : currentMeta.globalSelectionUpdatedAt;
  const nextChildId =
    update.childId !== undefined
      ? update.childId
      : (currentMeta.childId ?? null);
  const nextMeta = sanitizeMeta(
    {
      gender: nextGender,
      updatedAt: nextUpdatedAt,
      globalSelectionUpdatedAt: nextGlobalSelectionUpdatedAt,
      childId: nextChildId,
    },
    next.voiceId,
  );
  cached = next;
  cachedMeta = nextMeta;
  try {
    window.localStorage.setItem(
      SPEECH_PREFERENCES_STORAGE_KEY,
      JSON.stringify(next),
    );
    window.localStorage.setItem(
      SPEECH_PREFERENCES_META_STORAGE_KEY,
      JSON.stringify(nextMeta),
    );
  } catch {
    // The choice still applies for this page view.
  }
  listeners.forEach((listener) => listener());
  return next;
}

export function subscribeSpeechPreferences(listener: Listener): () => void {
  ensureStorageSync();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset persisted teacher voice preferences on sign-out or parent account switch. */
export function resetSpeechPreferencesForActorSwitch(): void {
  const prevPrefs = cached;
  const prevMeta = cachedMeta;
  cached = DEFAULT_PREFERENCES;
  cachedMeta = DEFAULT_META;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(SPEECH_PREFERENCES_STORAGE_KEY);
      window.localStorage.removeItem(SPEECH_PREFERENCES_META_STORAGE_KEY);
    } catch {
      // Ignore blocked storage.
    }
  }
  const hadNonDefault =
    prevPrefs === null ||
    prevMeta === null ||
    prevPrefs.voiceId !== null ||
    prevPrefs.speed !== DEFAULT_SPEED ||
    prevMeta.gender !== "female" ||
    prevMeta.childId !== null;
  if (hadNonDefault) {
    listeners.forEach((listener) => listener());
  }
}

/** Test helper: forget the in-memory copy so storage is read again. */
export function resetSpeechPreferencesCache(): void {
  cached = null;
  cachedMeta = null;
}
