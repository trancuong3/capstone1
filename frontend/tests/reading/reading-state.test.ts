import { describe, expect, it } from "vitest";

import {
  isEvidenceSuspended,
  parseReadingUiState,
  parseReconnectDemoMode,
} from "@/lib/utils/reading-state";

describe("reading state parser", () => {
  it("accepts only typed demo states and falls back safely", () => {
    expect(parseReadingUiState("reading")).toBe("reading");
    expect(parseReadingUiState(["paused", "reading"])).toBe("paused");
    expect(parseReadingUiState("unknown-state")).toBe("ready");
    expect(parseReadingUiState(undefined)).toBe("ready");
  });

  it("parses the reconnect failure demo separately from canonical state", () => {
    expect(parseReconnectDemoMode("timeout")).toBe("timeout");
    expect(parseReconnectDemoMode("anything-else")).toBe("recover");
  });

  it.each([
    "paused",
    "reconnecting",
    "stt-error",
    "camera-denied",
    "microphone-denied",
    "page-confidence-low",
    "page-turn",
  ] as const)("suspends evidence in %s", (state) => {
    expect(isEvidenceSuspended(state)).toBe(true);
  });
});
