import { describe, expect, it } from "vitest";
import {
  hasUsableTranscript,
  hasUsableBrowserConfidence,
  hasHighConfidenceKeytermResult,
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

describe("hasHighConfidenceKeytermResult", () => {
  it("accepts a single word with high logprob", () => {
    expect(
      hasHighConfidenceKeytermResult({
        ...transcript,
        words: [{ text: "mình", start: 0, end: 0.5, logprob: -0.2 }],
      }),
    ).toBe(true);
  });

  it("accepts when all words have logprob >= -0.5", () => {
    expect(
      hasHighConfidenceKeytermResult({
        ...transcript,
        words: [
          { text: "bé", start: 0, end: 0.3, logprob: -0.3 },
          { text: "mình", start: 0.3, end: 0.6, logprob: -0.5 },
        ],
      }),
    ).toBe(true);
  });

  it("rejects when any word has logprob below -0.5", () => {
    expect(
      hasHighConfidenceKeytermResult({
        ...transcript,
        words: [
          { text: "mình", start: 0, end: 0.5, logprob: -0.3 },
          { text: "ơi", start: 0.5, end: 0.8, logprob: -0.8 },
        ],
      }),
    ).toBe(false);
  });

  it("rejects when no words have logprob data", () => {
    expect(
      hasHighConfidenceKeytermResult({
        ...transcript,
        words: [{ text: "mình", start: 0, end: 0.5 }],
      }),
    ).toBe(false);
  });

  it("rejects when words array is empty", () => {
    expect(hasHighConfidenceKeytermResult({ ...transcript, words: [] })).toBe(
      false,
    );
  });

  it("rejects when words is null", () => {
    expect(hasHighConfidenceKeytermResult({ ...transcript, words: null })).toBe(
      false,
    );
  });

  it("ignores non-word types when checking confidence", () => {
    expect(
      hasHighConfidenceKeytermResult({
        ...transcript,
        words: [
          { text: "mình", start: 0, end: 0.5, logprob: -0.1 },
          {
            text: "laughter",
            start: 0.5,
            end: 1,
            type: "audio_event",
            logprob: -3,
          },
        ],
      }),
    ).toBe(true);
  });

  it("treats words without logprob as passing when at least one scored word exists", () => {
    expect(
      hasHighConfidenceKeytermResult({
        ...transcript,
        words: [
          { text: "mình", start: 0, end: 0.5, logprob: -0.2 },
          { text: "nè", start: 0.5, end: 0.8 },
        ],
      }),
    ).toBe(true);
  });
});
