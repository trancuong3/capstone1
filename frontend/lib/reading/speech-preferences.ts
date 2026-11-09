/**
 * Child-friendly voice choices, remembered in this browser only.
 * Nothing here is sent anywhere until a sample is requested.
 */

export const SPEED_MIN = 0.7;
export const SPEED_MAX = 1.2;
export const SPEED_STEP = 0.05;
export const DEFAULT_SPEED = 0.9;

export interface SpeechPreferences {
  /** `null` means the server's default voice. */
  readonly voiceId: string | null;
  readonly speed: number;
}

const STORAGE_KEY = "viread.speech-preferences.v1";
const DEFAULT_PREFERENCES: SpeechPreferences = {
  voiceId: null,
  speed: DEFAULT_SPEED,
};

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: SpeechPreferences | null = null;

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

function read(): SpeechPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_PREFERENCES;
  } catch {
    // Private mode or blocked storage: keep working with defaults.
    return DEFAULT_PREFERENCES;
  }
}

export function getSpeechPreferences(): SpeechPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  if (cached === null) cached = read();
  return cached;
}

export function setSpeechPreferences(
  update: Partial<SpeechPreferences>,
): SpeechPreferences {
  const next = sanitize({ ...getSpeechPreferences(), ...update });
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The choice still applies for this page view.
  }
  listeners.forEach((listener) => listener());
  return next;
}

export function subscribeSpeechPreferences(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: forget the in-memory copy so storage is read again. */
export function resetSpeechPreferencesCache(): void {
  cached = null;
}
