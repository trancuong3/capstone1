import { describe, expect, it } from "vitest";

import {
  buildContrastiveKeyterms,
  classifyRetryTranscript,
  hasConfusableNasalEnding,
  hasConfusableShortCoda,
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
        silenceElapsedMs: 800,
      }),
    ).toBe(false);
    expect(
      shouldAutoStopShortWordCapture({
        elapsedMs: 1000,
        speechObserved: true,
        silenceElapsedMs: 950,
      }),
    ).toBe(true);
  });

  it("builds contrastive 6-tone and close-coda keyterms capped cleanly", () => {
    const co = buildContrastiveKeyterms("có", "Bé có một bông hoa.");
    expect(co.length).toBeLessThanOrEqual(14);
    expect(co).toEqual(
      expect.arrayContaining([
        "có",
        "co",
        "cò",
        "cỏ",
        "cõ",
        "cọ",
        "có một bông",
      ]),
    );

    const mot = buildContrastiveKeyterms("một");
    expect(mot.length).toBeLessThanOrEqual(14);
    expect(mot).toEqual(expect.arrayContaining(["một", "mốt", "mộc", "mộp"]));

    const dua = buildContrastiveKeyterms("đứa");
    expect(dua).toContain("dứa");
  });

  it("detects confusable nasal and stopped codas without forgiving wrong tones", () => {
    expect(hasConfusableShortCoda("hôm", "hôn")).toBe(true);
    expect(hasConfusableShortCoda("một", "mộc")).toBe(true);
    expect(hasConfusableShortCoda("một", "mốt")).toBe(false);
    expect(hasConfusableShortCoda("hôm", "hồn")).toBe(false);
  });

  it("handles hyphenated words, 10->mười, digits in phrases, phonics-in-progress, and padded/repeated phrases", () => {
    expect(classifyRetryTranscript("ô-tô", "ô tô")).toBe("CORRECT");
    expect(classifyRetryTranscript("ba-lô", "ba lô")).toBe("CORRECT");
    expect(classifyRetryTranscript("ô-tô", "ô tồ")).toBe("INCORRECT");

    expect(classifyRetryTranscript("mười", "10")).toBe("CORRECT");
    expect(classifyRetryTranscript("mười", "10 điểm")).toBe("CORRECT");
    expect(classifyRetryTranscript("bé có một", "bé có 1 bông hoa")).toBe(
      "CORRECT",
    );

    // Phonics spelling in progress returns UNCERTAIN instead of INCORRECT
    expect(classifyRetryTranscript("cá", "cờ a ca")).toBe("UNCERTAIN");
    expect(classifyRetryTranscript("cá", "cờ a ca sắc cá")).toBe("CORRECT");
    expect(classifyRetryTranscript("cá", "cờ a ca huyền cà")).toBe("INCORRECT");

    // Padded/repeated target phrase >4 tokens matches contiguously when tone is exact
    expect(classifyRetryTranscript("ba-lô", "con đọc ba lô ba lô ạ")).toBe(
      "CORRECT",
    );
    expect(classifyRetryTranscript("ba-lô", "ba lồ")).toBe("INCORRECT");

    // Wrong tones MUST continue to fail
    expect(classifyRetryTranscript("có", "cò")).toBe("INCORRECT");
    expect(classifyRetryTranscript("một", "mốt")).toBe("INCORRECT");
    expect(classifyRetryTranscript("đứa", "dứa")).toBe("INCORRECT");
  });
});
