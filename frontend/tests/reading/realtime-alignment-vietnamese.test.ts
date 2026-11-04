import { describe, expect, it } from "vitest";
import {
  normalizeRealtimeWord,
  normalizeRealtimeForAmbiguity,
  RealtimeAlignmentEngine,
} from "@/lib/reading/realtime-alignment";
import type { ReadingPageWordDTO } from "@/types/reading";

function words(...tokens: string[]): ReadingPageWordDTO[] {
  return tokens.map((text, index) => ({
    word_id: `word-${index + 1}`,
    word_index: index,
    text,
    bbox: [0.1 + index * 0.1, 0.2, 0.08, 0.04] as [
      number,
      number,
      number,
      number,
    ],
    line_index: 0,
  }));
}

describe("RealtimeAlignmentEngine Vietnamese token identity", () => {
  it("preserves tone marks and the d/đ distinction in exact normalization", () => {
    const toneVariants = ["ma", "má", "mà", "mả", "mã", "mạ"];
    expect(new Set(toneVariants.map(normalizeRealtimeWord)).size).toBe(
      toneVariants.length,
    );
    expect(normalizeRealtimeWord("cá")).not.toBe(normalizeRealtimeWord("ca"));
    expect(normalizeRealtimeWord("d")).not.toBe(normalizeRealtimeWord("đ"));
    expect(
      normalizeRealtimeForAmbiguity("d"),
    ).toBe(normalizeRealtimeForAmbiguity("đ"));
  });

  it("does not mark a diacritic-only transcript variant as an exact match", () => {
    const engine = new RealtimeAlignmentEngine(words("má"));
    const snapshot = engine.addFinalTranscript("ma");
    expect(snapshot.statusByWordId.get("word-1")?.status).toBeUndefined();

    const finalSnapshot = engine.finish();
    expect(finalSnapshot.statusByWordId.get("word-1")?.status).toBe(
      "AMBIGUOUS",
    );
    expect(finalSnapshot.previewMatchedWordIds.size).toBe(0);
  });

  it("keeps an ambiguous token neutral while continuing to align the next exact word", () => {
    const engine = new RealtimeAlignmentEngine(words("má", "đi"));
    const snapshot = engine.addFinalTranscript("ma đi");

    expect(snapshot.statusByWordId.get("word-1")?.status).toBe("AMBIGUOUS");
    expect(snapshot.statusByWordId.get("word-2")?.status).toBe("MATCH");
    expect(snapshot.currentWordId).toBeNull();
  });

  it("marks an interim diacritic-only variant as ambiguous, not preview-matched", () => {
    const engine = new RealtimeAlignmentEngine(words("mà", "cá"));
    const snapshot = engine.previewAlignment("ma");

    expect(snapshot.currentWordId).toBe("word-1");
    expect(snapshot.statusByWordId.get("word-1")?.status).toBe("AMBIGUOUS");
    expect(snapshot.previewMatchedWordIds.has("word-1")).toBe(false);
  });

  it("keeps subsequent preview words aligned after a diacritic ambiguity", () => {
    const engine = new RealtimeAlignmentEngine(words("má", "đi"));
    const snapshot = engine.previewAlignment("ma đi");

    expect(snapshot.statusByWordId.get("word-1")?.status).toBe("AMBIGUOUS");
    expect(snapshot.statusByWordId.get("word-2")?.status).toBe("MATCH");
    expect(snapshot.currentWordId).toBeNull();
    expect(snapshot.previewMatchedWordIds.has("word-1")).toBe(false);
    expect(snapshot.previewMatchedWordIds.has("word-2")).toBe(true);
  });

  it("still records exact Vietnamese words as matched", () => {
    const engine = new RealtimeAlignmentEngine(words("chú", "mèo"));
    const snapshot = engine.addFinalTranscript("chú mèo");

    expect(snapshot.statusByWordId.get("word-1")?.status).toBe("MATCH");
    expect(snapshot.statusByWordId.get("word-2")?.status).toBe("MATCH");
  });

  it("keeps d and đ distinct for exact matching but treats a one-letter STT difference as ambiguous", () => {
    const engine = new RealtimeAlignmentEngine(words("đi"));
    const snapshot = engine.addFinalTranscript("di");
    const finalSnapshot = engine.finish();

    expect(normalizeRealtimeWord("đi")).not.toBe(normalizeRealtimeWord("di"));
    expect(snapshot.statusByWordId.get("word-1")?.status).toBeUndefined();
    expect(finalSnapshot.statusByWordId.get("word-1")?.status).toBe(
      "AMBIGUOUS",
    );
  });
});
