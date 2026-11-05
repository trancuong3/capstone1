import { describe, expect, it } from "vitest";

import {
  isRetryWordRecognized,
  normalizeRetryText,
} from "@/lib/reading/retry-recognition";

describe("retry speech recognition", () => {
  it("normalizes casing, punctuation, and composed Vietnamese text", () => {
    expect(normalizeRetryText("MÈO, nhỏ!")).toBe("mèo nhỏ");
  });

  it("accepts the target as a standalone word", () => {
    expect(isRetryWordRecognized("mèo", ["Mèo"])).toBe(true);
  });

  it("accepts the target as a complete word in the suggested phrase", () => {
    expect(isRetryWordRecognized("mèo", ["Bé mèo nhỏ đang ngủ."])).toBe(true);
  });

  it("checks every supplied recognition alternative instead of only the first", () => {
    expect(
      isRetryWordRecognized("mèo", ["Bé méo nhỏ", "Bé mèo nhỏ"]),
    ).toBe(true);
  });

  it("does not accept a substring as a complete word", () => {
    expect(isRetryWordRecognized("con", ["conmèo"])).toBe(false);
  });

  it("preserves Vietnamese tone marks when comparing words", () => {
    expect(isRetryWordRecognized("mèo", ["meo"])).toBe(false);
    expect(isRetryWordRecognized("mèo", ["méo"])).toBe(false);
  });

  it("rejects empty targets and empty transcripts", () => {
    expect(isRetryWordRecognized(" ", ["Bé mèo"])).toBe(false);
    expect(isRetryWordRecognized("mèo", [" ", ""])).toBe(false);
  });
});
