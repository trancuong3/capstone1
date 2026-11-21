import { describe, expect, it } from "vitest";
import {
  extractSentenceForWord,
  SentenceReinforcementTracker,
} from "@/lib/reading/sentence-reinforcement";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import type { ReadingPageWordDTO } from "@/types/reading";

function makeWords(text: string): ReadingPageWordDTO[] {
  return text.split(/\s+/u).map((word, index) => ({
    word_id: `w-${index}`,
    word_index: index,
    text: word,
    bbox: [
      0.05 + (index % 6) * 0.14,
      0.1 + Math.floor(index / 6) * 0.06,
      0.12,
      0.04,
    ] as const,
    line_index: Math.floor(index / 6),
  }));
}

describe("sentence-level fluency reinforcement (G20)", () => {
  it("extracts exact full sentence for word at start, middle, or end ('Tôi ăn cơm.')", () => {
    const words = makeWords("Tôi ăn cơm. Mèo nhỏ ngủ say!");
    for (const id of ["w-0", "w-1", "w-2"]) {
      const span = extractSentenceForWord(words, id, { pageRevisionId: "r1" });
      expect(span).not.toBeNull();
      expect(span?.text).toBe("Tôi ăn cơm.");
      expect(span?.startIndex).toBe(0);
      expect(span?.endIndex).toBe(2);
      expect(span?.isClause).toBe(false);
    }

    const second = extractSentenceForWord(words, "w-4", {
      pageRevisionId: "r1",
    });
    expect(second?.text).toBe("Mèo nhỏ ngủ say!");
    expect(second?.startIndex).toBe(3);
    expect(second?.endIndex).toBe(6);
  });

  it("narrows sentences longer than 12 words to the local clause containing the word", () => {
    const words = makeWords(
      "Buổi sáng mùa thu nắng nhẹ, bé Lan đi học sớm cùng mẹ, rồi chào cô giáo ở cổng trường.",
    );
    const lanIndex = words.findIndex((w) => w.text === "Lan");
    const span = extractSentenceForWord(words, words[lanIndex].word_id);
    expect(span).not.toBeNull();
    expect(span?.isClause).toBe(true);
    expect(span?.text).toBe("bé Lan đi học sớm cùng mẹ,");
    expect(span!.words.length).toBeLessThanOrEqual(12);
  });

  it("returns null for 1-word isolated lines/titles", () => {
    const words = makeWords("Mèo! Tôi ăn cơm.");
    expect(extractSentenceForWord(words, "w-0")).toBeNull();
  });

  it("triggers reinforcement after practicing 'Tôi' whether fixed OR helped, and completes once read back", () => {
    const words = makeWords("Tôi ăn cơm. Mẹ nấu canh.");

    // Case 1: Child fixed 'Tôi' -> still invited to read back "Tôi ăn cơm."
    const trackerFixed = new SentenceReinforcementTracker();
    const active1 = trackerFixed.beginForWord(words, "w-0", "fixed", {
      pageRevisionId: "rev-1",
    });
    expect(active1?.span.text).toBe("Tôi ăn cơm.");
    expect(active1?.outcome).toBe("fixed");
    expect(trackerFixed.consumeSpeech("Tôi ăn cơm")).toBe("completed");
    expect(trackerFixed.getActive()).toBeNull();

    // Case 2: Child got helped/gave up on 'Tôi' -> still invited to read back "Tôi ăn cơm."
    const trackerHelped = new SentenceReinforcementTracker();
    const active2 = trackerHelped.beginForWord(words, "w-0", "helped", {
      pageRevisionId: "rev-1",
    });
    expect(active2?.span.text).toBe("Tôi ăn cơm.");
    expect(active2?.outcome).toBe("helped");
    // Accepts multi-chunk + Grade-1 phonics spelling-out during reinforcement!
    expect(trackerHelped.consumeSpeech("ô i ôi tờ ôi tôi")).toBe("in-progress");
    expect(trackerHelped.consumeSpeech("ăn cơm")).toBe("completed");
    expect(trackerHelped.getActive()).toBeNull();
  });

  it("enforces max 1 reinforcement per sentence (never loops forever)", () => {
    const words = makeWords("Tôi ăn cơm. Mẹ nấu canh.");
    const tracker = new SentenceReinforcementTracker();

    const first = tracker.beginForWord(words, "w-0", "fixed", {
      pageRevisionId: "rev-1",
    });
    expect(first).not.toBeNull();
    tracker.finishCurrent();

    // Second error in the same sentence ("cơm") does NOT trigger another full-sentence loop
    const second = tracker.beginForWord(words, "w-2", "helped", {
      pageRevisionId: "rev-1",
    });
    expect(second).toBeNull();

    // Next sentence ("Mẹ nấu canh.") is still eligible
    const nextSentence = tracker.beginForWord(words, "w-3", "helped", {
      pageRevisionId: "rev-1",
    });
    expect(nextSentence?.span.text).toBe("Mẹ nấu canh.");
  });

  it("never mutates first-pass alignment results when running sentence reinforcement separately", () => {
    const words = makeWords("Tôi ăn cơm.");
    const engine = new RealtimeAlignmentEngine(words);

    // First pass: child misreads "Tôi" as "tồi", then reads "ăn cơm"
    engine.addFinalTranscript("tồi ăn cơm");
    const settled = engine.finish();
    expect(settled.statusByWordId.get("w-0")?.status).toBe("SUBSTITUTE");
    expect(settled.statusByWordId.get("w-1")?.status).toBe("MATCH");
    expect(settled.statusByWordId.get("w-2")?.status).toBe("MATCH");

    // Reinforcement runs through SentenceReinforcementTracker, never overwriting settled engine state
    const tracker = new SentenceReinforcementTracker();
    tracker.beginForWord(words, "w-0", "fixed");
    expect(tracker.consumeSpeech("Tôi ăn cơm")).toBe("completed");
    expect(engine.getSnapshot().statusByWordId.get("w-0")?.status).toBe(
      "SUBSTITUTE",
    );
  });
});
