"use client";

import { useCallback, useSyncExternalStore } from "react";

export interface EntertainmentPreferences {
  /** Reduce non-essential motion, projectiles, and transitions across Hub, games, and Karaoke. */
  readonly reducedMotion: boolean;
  /** Gentle/calm sound enabled (`true` = gentle audio on, `false` = muted). */
  readonly calmSound: boolean;
  /** Child Autopilot flow enabled (`true` = auto-advance, auto-speak, hands-free voice loop). */
  readonly autoPlayFlow: boolean;
}

export const ENTERTAINMENT_PREFERENCES_STORAGE_KEY =
  "viread:entertainment-preferences.v1";
export const LEGACY_REDUCED_MOTION_STORAGE_KEY =
  "viread:entertainment-v4-reduced-motion";
export const LEGACY_SOUND_MUTED_STORAGE_KEY =
  "viread:entertainment-v4-sound-muted";
export const ENTERTAINMENT_PREFERENCES_EVENT =
  "viread:entertainment-preferences-change";

const SERVER_SNAPSHOT: EntertainmentPreferences = {
  reducedMotion: false,
  calmSound: true,
  autoPlayFlow: true,
};

type Listener = () => void;
const listeners = new Set<Listener>();
let cachedSnapshot: EntertainmentPreferences = SERVER_SNAPSHOT;
let externalSubscriptionsCount = 0;
let teardownExternalListeners: (() => void) | null = null;

export function prefersOsReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function parseBooleanString(value: string | null): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function readPreferencesFromBrowser(): EntertainmentPreferences {
  const osReducedMotion = prefersOsReducedMotion();
  if (typeof window === "undefined") {
    return SERVER_SNAPSHOT;
  }

  let reducedMotion: boolean | null = null;
  let calmSound: boolean | null = null;
  let autoPlayFlow: boolean | null = null;

  try {
    const raw = window.localStorage.getItem(
      ENTERTAINMENT_PREFERENCES_STORAGE_KEY,
    );
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.reducedMotion === "boolean") {
          reducedMotion = parsed.reducedMotion;
        }
        if (typeof parsed.calmSound === "boolean") {
          calmSound = parsed.calmSound;
        }
        if (typeof parsed.autoPlayFlow === "boolean") {
          autoPlayFlow = parsed.autoPlayFlow;
        }
      }
    }

    if (reducedMotion === null) {
      reducedMotion = parseBooleanString(
        window.localStorage.getItem(LEGACY_REDUCED_MOTION_STORAGE_KEY),
      );
    }
    if (calmSound === null) {
      const legacyMuted = parseBooleanString(
        window.localStorage.getItem(LEGACY_SOUND_MUTED_STORAGE_KEY),
      );
      if (legacyMuted !== null) {
        calmSound = !legacyMuted;
      }
    }
  } catch {
    // Private mode or restricted storage: fall back cleanly to OS/default values.
  }

  return {
    reducedMotion: reducedMotion ?? osReducedMotion,
    calmSound: calmSound ?? true,
    autoPlayFlow: autoPlayFlow ?? true,
  };
}

function syncCachedSnapshot(
  next: EntertainmentPreferences,
): EntertainmentPreferences {
  if (
    cachedSnapshot.reducedMotion === next.reducedMotion &&
    cachedSnapshot.calmSound === next.calmSound &&
    cachedSnapshot.autoPlayFlow === next.autoPlayFlow
  ) {
    return cachedSnapshot;
  }
  cachedSnapshot = next;
  return cachedSnapshot;
}

export function getEntertainmentPreferences(): EntertainmentPreferences {
  if (typeof window === "undefined") {
    return SERVER_SNAPSHOT;
  }
  return syncCachedSnapshot(readPreferencesFromBrowser());
}

function notifyAllSubscribers(next: EntertainmentPreferences): void {
  listeners.forEach((listener) => listener());
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent<EntertainmentPreferences>(
          ENTERTAINMENT_PREFERENCES_EVENT,
          { detail: next },
        ),
      );
    } catch {
      // Ignore environments where CustomEvent dispatch is unavailable.
    }
  }
}

export function setEntertainmentPreferences(
  patch: Partial<EntertainmentPreferences>,
): EntertainmentPreferences {
  const current = getEntertainmentPreferences();
  const next: EntertainmentPreferences = {
    reducedMotion:
      typeof patch.reducedMotion === "boolean"
        ? patch.reducedMotion
        : current.reducedMotion,
    calmSound:
      typeof patch.calmSound === "boolean"
        ? patch.calmSound
        : current.calmSound,
    autoPlayFlow:
      typeof patch.autoPlayFlow === "boolean"
        ? patch.autoPlayFlow
        : current.autoPlayFlow,
  };

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        ENTERTAINMENT_PREFERENCES_STORAGE_KEY,
        JSON.stringify(next),
      );
      window.localStorage.setItem(
        LEGACY_REDUCED_MOTION_STORAGE_KEY,
        String(next.reducedMotion),
      );
      window.localStorage.setItem(
        LEGACY_SOUND_MUTED_STORAGE_KEY,
        String(!next.calmSound),
      );
    } catch {
      // Restricted storage still updates active in-memory/custom-event listeners.
    }
  }

  const stabilized = syncCachedSnapshot(next);
  notifyAllSubscribers(stabilized);
  return stabilized;
}

function attachExternalListeners(): void {
  if (typeof window === "undefined" || teardownExternalListeners) return;

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === ENTERTAINMENT_PREFERENCES_STORAGE_KEY ||
      event.key === LEGACY_REDUCED_MOTION_STORAGE_KEY ||
      event.key === LEGACY_SOUND_MUTED_STORAGE_KEY
    ) {
      syncCachedSnapshot(readPreferencesFromBrowser());
      listeners.forEach((listener) => listener());
    }
  };

  const handleCustomEvent = (event: Event) => {
    const custom = event as CustomEvent<Partial<EntertainmentPreferences>>;
    if (custom.detail && typeof custom.detail === "object") {
      const current = getEntertainmentPreferences();
      const next: EntertainmentPreferences = {
        reducedMotion:
          typeof custom.detail.reducedMotion === "boolean"
            ? custom.detail.reducedMotion
            : current.reducedMotion,
        calmSound:
          typeof custom.detail.calmSound === "boolean"
            ? custom.detail.calmSound
            : current.calmSound,
        autoPlayFlow:
          typeof custom.detail.autoPlayFlow === "boolean"
            ? custom.detail.autoPlayFlow
            : current.autoPlayFlow,
      };
      if (
        cachedSnapshot.reducedMotion !== next.reducedMotion ||
        cachedSnapshot.calmSound !== next.calmSound ||
        cachedSnapshot.autoPlayFlow !== next.autoPlayFlow
      ) {
        cachedSnapshot = next;
        listeners.forEach((listener) => listener());
      }
      return;
    }
    syncCachedSnapshot(readPreferencesFromBrowser());
    listeners.forEach((listener) => listener());
  };

  let mediaQuery: MediaQueryList | null = null;
  const handleMediaChange = () => {
    syncCachedSnapshot(readPreferencesFromBrowser());
    listeners.forEach((listener) => listener());
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(ENTERTAINMENT_PREFERENCES_EVENT, handleCustomEvent);

  if (typeof window.matchMedia === "function") {
    try {
      mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", handleMediaChange);
      }
    } catch {
      mediaQuery = null;
    }
  }

  teardownExternalListeners = () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(
      ENTERTAINMENT_PREFERENCES_EVENT,
      handleCustomEvent,
    );
    if (mediaQuery && typeof mediaQuery.removeEventListener === "function") {
      mediaQuery.removeEventListener("change", handleMediaChange);
    }
    teardownExternalListeners = null;
  };
}

export function subscribeEntertainmentPreferences(
  listener: Listener,
): () => void {
  listeners.add(listener);
  externalSubscriptionsCount += 1;
  if (externalSubscriptionsCount === 1) {
    attachExternalListeners();
  }

  return () => {
    listeners.delete(listener);
    externalSubscriptionsCount = Math.max(0, externalSubscriptionsCount - 1);
    if (externalSubscriptionsCount === 0) {
      teardownExternalListeners?.();
    }
  };
}

export interface UseEntertainmentPreferencesResult {
  readonly preferences: EntertainmentPreferences;
  readonly reducedMotion: boolean;
  readonly calmSound: boolean;
  readonly autoPlayFlow: boolean;
  readonly update: (patch: Partial<EntertainmentPreferences>) => void;
  readonly setReducedMotion: (value: boolean) => void;
  readonly setCalmSound: (value: boolean) => void;
  readonly setAutoPlayFlow: (value: boolean) => void;
  readonly toggleReducedMotion: () => void;
  readonly toggleCalmSound: () => void;
  readonly toggleAutoPlayFlow: () => void;
}

/**
 * Shared sensory and autopilot preferences (`reducedMotion`, `calmSound`,
 * and `autoPlayFlow`) for the Entertainment Hub, games, and Karaoke stage.
 * Persists across reloads via `localStorage` and synchronizes across mounted
 * views and browser tabs.
 */
export function useEntertainmentPreferences(): UseEntertainmentPreferencesResult {
  const preferences = useSyncExternalStore(
    subscribeEntertainmentPreferences,
    getEntertainmentPreferences,
    () => SERVER_SNAPSHOT,
  );

  const update = useCallback((patch: Partial<EntertainmentPreferences>) => {
    setEntertainmentPreferences(patch);
  }, []);

  const setReducedMotion = useCallback((value: boolean) => {
    setEntertainmentPreferences({ reducedMotion: value });
  }, []);

  const setCalmSound = useCallback((value: boolean) => {
    setEntertainmentPreferences({ calmSound: value });
  }, []);

  const setAutoPlayFlow = useCallback((value: boolean) => {
    setEntertainmentPreferences({ autoPlayFlow: value });
  }, []);

  const toggleReducedMotion = useCallback(() => {
    const current = getEntertainmentPreferences();
    setEntertainmentPreferences({ reducedMotion: !current.reducedMotion });
  }, []);

  const toggleCalmSound = useCallback(() => {
    const current = getEntertainmentPreferences();
    setEntertainmentPreferences({ calmSound: !current.calmSound });
  }, []);

  const toggleAutoPlayFlow = useCallback(() => {
    const current = getEntertainmentPreferences();
    setEntertainmentPreferences({ autoPlayFlow: !current.autoPlayFlow });
  }, []);

  return {
    preferences,
    reducedMotion: preferences.reducedMotion,
    calmSound: preferences.calmSound,
    autoPlayFlow: preferences.autoPlayFlow,
    update,
    setReducedMotion,
    setCalmSound,
    setAutoPlayFlow,
    toggleReducedMotion,
    toggleCalmSound,
    toggleAutoPlayFlow,
  };
}
