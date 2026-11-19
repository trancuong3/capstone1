import { describe, expect, it } from "vitest";

import {
  classifyRetryTranscript,
  hasConfusableNasalEnding,
  normalizeVietnameseRetryToken,
  shortWordContext,
} from "@/lib/reading/retry-word-recognition";
import { shouldAutoStopShortWordCapture } from "@/lib/reading/word-practice-engine";

describe("Vietnamese retry recognition", () => {
  it("accepts a bare digit from ASR without merging different sounds", () => {
    expect(classifyRetryTranscript("một", "1.")).toBe("CORRECT");
    expect(classifyRetryTranscript("một", "2.")).toBe("INCORRECT");
    expect(classifyRetryTranscript("một", "01")).toBe("INCORRECT");
    expect(classifyRetryTranscript("một", "mốt")).toBe("INCORRECT");
  });

  it("offers a short book phrase and never scores the coaching sentence", () => {
    expect(shortWordContext("hôm", "Bé An thức dậy. Hôm nay nắng lên.")).toBe(
      "hôm nay nắng",
    );
    expect(shortWordContext("hôm", "Bé nói hôn.")).toBeNull();
    expect(shortWordContext("cành", "líu lo trên cành cây Bé An")).toBe(
      "cành cây",
    );
    expect(classifyRetryTranscript("hôm", "hôm nay nắng")).toBe("CORRECT");
    expect(classifyRetryTranscript("hôm", "hôn nay nắng")).toBe("INCORRECT");
    expect(
      classifyRetryTranscript("hôm", "Con thử đọc cả cụm hôm nay nắng nhé."),
    ).toBe("UNCERTAIN");
  });
  it.each([
    ["khỏe", "khỏe"],
    ["khỏe", "KHỎE"],
    ["đứa", "ĐỨA"],
    ["cá", "cá"],
    ["mẹ", "mẹ"],
  ])(
    "recognizes %s without losing Vietnamese spelling",
    (expected, transcript) => {
      expect(classifyRetryTranscript(expected, transcript)).toBe("CORRECT");
    },
  );

  it("normalizes decomposed Unicode to NFC and trims edge punctuation", () => {
    expect(normalizeVietnameseRetryToken("  ‘KHO\u0309E!’  ")).toBe("khỏe");
    expect(classifyRetryTranscript("khỏe", "  (KHO\u0309E!) ")).toBe("CORRECT");
  });

  it.each([
    ["cá", "ca"],
    ["mẹ", "me"],
    ["khỏe", "khoe"],
    ["đứa", "dứa"],
    ["cá", "cáo"],
    ["thức", "thực"],
    ["thực", "thức"],
    ["có", "cò"],
    ["có", "cỏ"],
    ["có", "cọ"],
    ["ăn", "anh"],
    ["thấp", "thập"],
  ])("keeps tone and word identity for %s / %s", (expected, transcript) => {
    expect(classifyRetryTranscript(expected, transcript)).toBe("INCORRECT");
  });

  it("accepts the exact word as a token in a short phrase", () => {
    expect(classifyRetryTranscript("khỏe", "Bé đọc khỏe nhé.")).toBe("CORRECT");
    expect(classifyRetryTranscript("mẹ", "Con gọi mẹ")).toBe("CORRECT");
  });

  it("rejects substring matches and leaves long dialogue uncertain", () => {
    expect(classifyRetryTranscript("cá", "cáo")).toBe("INCORRECT");
    expect(classifyRetryTranscript("mẹ", "bánh kem")).toBe("INCORRECT");
    expect(
      classifyRetryTranscript("khỏe", "Hôm nay con muốn kể một câu chuyện dài"),
    ).toBe("UNCERTAIN");
  });

  it("does not treat an empty transcript as an incorrect pronunciation", () => {
    expect(classifyRetryTranscript("khỏe", "   ")).toBe("NOT_RECOGNIZED");
  });

  it("distinguishes hôm, hôn and a clear reading with context", () => {
    expect(hasConfusableNasalEnding("hôm", "Hôn.")).toBe(true);
    expect(hasConfusableNasalEnding("hôm", "hồn")).toBe(false);
    expect(classifyRetryTranscript("hôm", "hôn")).toBe("INCORRECT");
    expect(classifyRetryTranscript("hôm", "Hôm nay")).toBe("CORRECT");
  });

  it("preserves the end of a short recording while speech is still settling", () => {
    expect(
      shouldAutoStopShortWordCapture({
        elapsedMs: 900,
        speechObserved: true,
        silenceElapsedMs: 520,
      }),
    ).toBe(false);
    expect(
      shouldAutoStopShortWordCapture({
        elapsedMs: 1000,
        speechObserved: true,
        silenceElapsedMs: 800,
      }),
    ).toBe(true);
  });
});
