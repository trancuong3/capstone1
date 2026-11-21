"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  DEFAULT_AUTOMATION_PREFERENCES,
  getAutomationPreferences,
  setAutomationPreferences,
  subscribeAutomationPreferences,
  type AutomationPreferences,
} from "@/lib/reading/automation-preferences";

/** Assist / auto-advance switches, shared across components on this device. */
export function useAutomationPreferences(): {
  preferences: AutomationPreferences;
  update: (value: Partial<AutomationPreferences>) => void;
} {
  const preferences = useSyncExternalStore(
    subscribeAutomationPreferences,
    getAutomationPreferences,
    () => DEFAULT_AUTOMATION_PREFERENCES,
  );
  const update = useCallback((value: Partial<AutomationPreferences>) => {
    setAutomationPreferences(value);
  }, []);
  return { preferences, update };
}
