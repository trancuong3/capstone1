import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampSpeed,
  DEFAULT_SPEED,
  getSpeechPreferences,
  resetSpeechPreferencesCache,
  setSpeechPreferences,
  SPEED_MAX,
  SPEED_MIN,
  subscribeSpeechPreferences,
} from "@/lib/reading/speech-preferences";

beforeEach(() => {
  window.localStorage.clear();
  resetSpeechPreferencesCache();
});

describe("speech preferences", () => {
  it("starts with the default voice and a child-friendly speed", () => {
    expect(getSpeechPreferences()).toEqual({
      voiceId: null,
      speed: DEFAULT_SPEED,
    });
    expect(DEFAULT_SPEED).toBeLessThan(1);
  });

  it("clamps and snaps the speed to the supported range", () => {
    expect(clampSpeed(0.1)).toBe(SPEED_MIN);
    expect(clampSpeed(5)).toBe(SPEED_MAX);
    expect(clampSpeed(0.93)).toBe(0.95);
    expect(clampSpeed(Number.NaN)).toBe(DEFAULT_SPEED);
  });

  it("stores the choice, notifies listeners and survives a reload", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSpeechPreferences(listener);

    setSpeechPreferences({ voiceId: "abc_123", speed: 1.1 });
    expect(listener).toHaveBeenCalledOnce();
    expect(getSpeechPreferences()).toEqual({ voiceId: "abc_123", speed: 1.1 });

    resetSpeechPreferencesCache();
    expect(getSpeechPreferences()).toEqual({ voiceId: "abc_123", speed: 1.1 });

    unsubscribe();
    setSpeechPreferences({ speed: 0.8 });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("ignores tampered storage", () => {
    window.localStorage.setItem(
      "viread.speech-preferences.v1",
      JSON.stringify({ voiceId: "../../etc", speed: 99 }),
    );
    expect(getSpeechPreferences()).toEqual({ voiceId: null, speed: SPEED_MAX });

    resetSpeechPreferencesCache();
    window.localStorage.setItem("viread.speech-preferences.v1", "{not json");
    expect(getSpeechPreferences()).toEqual({
      voiceId: null,
      speed: DEFAULT_SPEED,
    });
  });

  it("keeps working when storage is blocked", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(setSpeechPreferences({ speed: 1 }).speed).toBe(1);
    expect(getSpeechPreferences().speed).toBe(1);
    setItem.mockRestore();
  });
});
