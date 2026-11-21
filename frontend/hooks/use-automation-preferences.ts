"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  DEFAULT_AUTOMATION_PREFERENCES,
  DEFAULT_COACHING_STYLE,
  getAutomationPreferences,
  getCoachingStyle,
  setAutomationPreferences,
  setCoachingStyle,
  subscribeAutomationPreferences,
  type AutomationPreferences,
  type CoachingStyle,
} from "@/lib/reading/automation-preferences";

/** Assist / auto-advance switches and coaching style, shared on this device. */
export function useAutomationPreferences(): {
  preferences: AutomationPreferences;
  update: (value: Partial<AutomationPreferences>) => void;
  coachingStyle: CoachingStyle;
  updateCoachingStyle: (style: CoachingStyle) => void;
} {
  const preferences = useSyncExternalStore(
    subscribeAutomationPreferences,
    getAutomationPreferences,
    () => DEFAULT_AUTOMATION_PREFERENCES,
  );
  const coachingStyle = useSyncExternalStore(
    subscribeAutomationPreferences,
    getCoachingStyle,
    () => DEFAULT_COACHING_STYLE,
  );
  const update = useCallback((value: Partial<AutomationPreferences>) => {
    setAutomationPreferences(value);
  }, []);
  const updateCoachingStyle = useCallback((style: CoachingStyle) => {
    setCoachingStyle(style);
  }, []);
  return { preferences, update, coachingStyle, updateCoachingStyle };
}
