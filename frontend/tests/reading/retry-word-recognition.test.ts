import { describe, expect, it } from "vitest";

import {
  classifyRetryTranscript,
  normalizeVietnameseRetryToken,
} from "@/lib/reading/retry-word-recognition";

describe("Vietnamese retry recognition", () => {
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
});
