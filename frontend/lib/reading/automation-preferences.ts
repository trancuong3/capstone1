/**
 * Parent-controlled switches for the automatic reading flow, remembered on this
 * device only. Two are local (assist, auto-advance). The email reminder is a
 * server-side per-parent setting (see reading-presence-service) and is never
 * stored here.
 *
 * Defaults keep the pre-existing behaviour: help and page turn are automatic,
 * and each can be turned off independently.
 */

export interface AutomationPreferences {
  /** Tự nhắc nhẹ và tự đọc mẫu khi bé mắc kẹt. */
  readonly assist: boolean;
  /** Tự chuyển trang khi đủ điều kiện. */
  readonly autoAdvance: boolean;
}

const STORAGE_KEY = "viread.automation-preferences.v1";
export const DEFAULT_AUTOMATION_PREFERENCES: AutomationPreferences = {
  assist: true,
  autoAdvance: true,
};

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: AutomationPreferences | null = null;

function sanitize(value: unknown): AutomationPreferences {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_AUTOMATION_PREFERENCES;
  }
  const record = value as Record<string, unknown>;
  return {
    assist:
      typeof record.assist === "boolean"
        ? record.assist
        : DEFAULT_AUTOMATION_PREFERENCES.assist,
    autoAdvance:
      typeof record.autoAdvance === "boolean"
        ? record.autoAdvance
        : DEFAULT_AUTOMATION_PREFERENCES.autoAdvance,
  };
}

function read(): AutomationPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_AUTOMATION_PREFERENCES;
  } catch {
    return DEFAULT_AUTOMATION_PREFERENCES;
  }
}

export function getAutomationPreferences(): AutomationPreferences {
  if (typeof window === "undefined") return DEFAULT_AUTOMATION_PREFERENCES;
  if (cached === null) cached = read();
  return cached;
}

export function setAutomationPreferences(
  update: Partial<AutomationPreferences>,
): AutomationPreferences {
  const next = sanitize({ ...getAutomationPreferences(), ...update });
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The choice still applies for this page view.
  }
  listeners.forEach((listener) => listener());
  return next;
}

export function subscribeAutomationPreferences(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: forget the in-memory copy so storage is read again. */
export function resetAutomationPreferencesCache(): void {
  cached = null;
}
