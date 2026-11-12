import { describe, expect, it } from "vitest";
import {
  hasUsableTranscript,
  hasUsableBrowserConfidence,
} from "@/lib/reading/recognition-evidence";
import {
  normalizeVietnameseText,
  tokenizeVietnameseText,
} from "@/lib/reading/vietnamese-text";
import { normalizeRetryText } from "@/lib/reading/retry-recognition";
import { tokenizeRealtimeText } from "@/lib/reading/realtime-alignment";
import type { SpeechTranscript } from "@/lib/api/speech-service";

const transcript: SpeechTranscript = {
  text: "Bé đi học",
  language_code: "vi",
  language_probability: 0.99,
  words: null,
};

describe("recognition evidence", () => {
  it("does not use language probability as pronunciation confidence", () => {
    expect(
      hasUsableTranscript({ ...transcript, language_probability: 0.01 }),
    ).toBe(true);
    expect(
      hasUsableTranscript({
        ...transcript,
        words: [{ text: "học", start: 0, end: 1, logprob: -4 }],
      }),
    ).toBe(false);
  });
  it.each(["", "!!!", " "])("rejects non-evidence %j", (text) => {
    expect(hasUsableTranscript({ ...transcript, text })).toBe(false);
  });
  it("rejects unrelated language and audio events", () => {
    expect(hasUsableTranscript({ ...transcript, language_code: "en" })).toBe(
      false,
    );
    expect(
      hasUsableTranscript({
        ...transcript,
        words: [{ text: "laughter", start: 0, end: 1, type: "audio_event" }],
      }),
    ).toBe(false);
  });
  it.each([0.1, 0.49, Number.NaN, -1, 2])(
    "rejects unreliable browser confidence %s",
    (confidence) => {
      expect(hasUsableBrowserConfidence(confidence)).toBe(false);
    },
  );
  it.each([undefined, 0, 0.7, 1])(
    "supports browser confidence %s",
    (confidence) => {
      expect(hasUsableBrowserConfidence(confidence)).toBe(true);
    },
  );
});

describe("shared Vietnamese normalization", () => {
  it.each([
    ["má", "ma"],
    ["mà", "má"],
    ["đi", "di"],
    ["da", "đa"],
    ["cá", "cà"],
    ["học", "họp"],
    ["sáo", "sao"],
  ])("preserves %s versus %s", (left, right) => {
    expect(normalizeVietnameseText(left)).not.toBe(
      normalizeVietnameseText(right),
    );
  });
  it("preserves order, repeated tokens, case and NFC across all consumers", () => {
    const value = "  (BÉ), bé—ĐI học! ".normalize("NFD");
    expect(tokenizeVietnameseText(value)).toEqual(["bé", "bé", "đi", "học"]);
    expect(tokenizeRealtimeText(value)).toEqual(tokenizeVietnameseText(value));
    expect(normalizeRetryText(value)).toBe("bé bé đi học");
  });
});
