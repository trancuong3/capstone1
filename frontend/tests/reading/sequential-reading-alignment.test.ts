import { describe, expect, it } from "vitest";

import {
  normalizeReadingToken,
  SequentialReadingTracker,
  type SequentialReadingToken,
} from "@/lib/utils/sequential-reading-alignment";

const words: SequentialReadingToken[] = [
  { word_id: "a-0", text: "Hôm" },
  { word_id: "a-1", text: "nay" },
  { word_id: "a-2", text: "khỏe" },
  { word_id: "a-3", text: "không?" },
  { word_id: "b-0", text: "Tôi" },
  { word_id: "b-1", text: "khỏe" },
  { word_id: "c-0", text: "đi" },
  { word_id: "c-1", text: "chơi" },
  { word_id: "c-2", text: "không?" },
];

describe("SequentialReadingTracker", () => {
  it("commits repeated khỏe/không only at their ordered token positions", () => {
    const tracker = new SequentialReadingTracker("page-1", "revision-1", words);

    const firstLine = tracker.commitFinal("utterance-1", "Hôm nay khỏe không!");

    expect(firstLine.correctWordIds).toEqual(
      new Set(["a-0", "a-1", "a-2", "a-3"]),
    );
    expect(firstLine.currentWordId).toBe("b-0");
    expect(firstLine.needsReviewWordIds.size).toBe(0);
    expect(firstLine.correctWordIds.has("b-1")).toBe(false);
    expect(firstLine.correctWordIds.has("c-2")).toBe(false);

    const secondLine = tracker.commitFinal("utterance-2", "Tôi khỏe");

    expect(secondLine.correctWordIds).toEqual(
      new Set(["a-0", "a-1", "a-2", "a-3", "b-0", "b-1"]),
    );
    expect(secondLine.currentWordId).toBe("c-0");
    expect(secondLine.correctWordIds.has("c-2")).toBe(false);
  });

  it("does not jump to a later duplicate when the current line was skipped", () => {
    const tracker = new SequentialReadingTracker("page-1", "revision-1", words);

    const result = tracker.commitFinal("utterance-1", "Tôi khỏe");

    expect(result.cursorIndex).toBe(0);
    expect(result.currentWordId).toBe("a-0");
    expect(result.mismatchWordId).toBe("a-0");
    expect(result.needsReviewWordIds).toEqual(new Set(["a-0"]));
    expect(result.correctWordIds.size).toBe(0);
  });

  it("aligns multiple recognized words in original top-to-bottom order", () => {
    const tracker = new SequentialReadingTracker("page-1", "revision-1", words);

    const result = tracker.commitFinal(
      "utterance-1",
      "Hôm nay khỏe không tôi khỏe đi chơi không",
    );

    expect(result.complete).toBe(true);
    expect(result.cursorIndex).toBe(words.length);
    expect(result.correctWordIds.size).toBe(words.length);
  });

  it("does not advance twice for a duplicate final recognition event", () => {
    const tracker = new SequentialReadingTracker("page-1", "revision-1", words);

    const first = tracker.commitFinal("same-event", "Hôm nay");
    const duplicate = tracker.commitFinal("same-event", "khỏe không");

    expect(first.cursorIndex).toBe(2);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.cursorIndex).toBe(2);
    expect(duplicate.currentWordId).toBe("a-2");
  });

  it("keeps interim recognition as temporary preview without committing progress", () => {
    const tracker = new SequentialReadingTracker("page-1", "revision-1", words);

    const preview = tracker.previewInterim("Hôm nay khỏe");
    const committed = tracker.commitFinal("final-1", "Hôm nay khỏe");

    expect(preview.previewWordIds).toEqual(["a-0", "a-1", "a-2"]);
    expect(committed.cursorIndex).toBe(3);
    expect(committed.correctWordIds).toEqual(new Set(["a-0", "a-1", "a-2"]));
  });

  it("preserves Vietnamese diacritics and the d/đ distinction", () => {
    expect(normalizeReadingToken(" KHỎE, ")).toBe("khỏe");
    expect(normalizeReadingToken("ĐƯỜNG!")).toBe("đường");
    expect(normalizeReadingToken("dường")).toBe("dường");
    expect(normalizeReadingToken("đường")).not.toBe(
      normalizeReadingToken("dường"),
    );
    expect(normalizeReadingToken("a\u0306\u0301")).toBe("ắ");
  });

  it("uses a fresh page and revision identity after navigating to another page", () => {
    const firstPage = new SequentialReadingTracker(
      "page-1",
      "revision-1",
      words,
    );
    firstPage.commitFinal("page-1-event", "Hôm nay");

    const nextPage = new SequentialReadingTracker("page-2", "revision-2", [
      { word_id: "p2-0", text: "Hôm" },
      { word_id: "p2-1", text: "nay" },
    ]);

    const result = nextPage.commitFinal("page-2-event", "Hôm");

    expect(result.pageId).toBe("page-2");
    expect(result.pageRevisionId).toBe("revision-2");
    expect(result.currentWordId).toBe("p2-1");
    expect(result.correctWordIds).toEqual(new Set(["p2-0"]));
    expect(result.correctWordIds.has("a-0")).toBe(false);
  });

  it("marks an occurrence REVIEWED only after its exact correction succeeds", () => {
    const tracker = new SequentialReadingTracker("page-1", "revision-1", words);

    const incorrect = tracker.commitFinal("wrong", "Hmm");
    expect(incorrect.needsReviewWordIds).toEqual(new Set(["a-0"]));
    expect(incorrect.reviewedWordIds.size).toBe(0);

    const corrected = tracker.commitFinal("retry", "Hôm");
    expect(corrected.correctWordIds).toEqual(new Set(["a-0"]));
    expect(corrected.needsReviewWordIds.size).toBe(0);
    expect(corrected.reviewedWordIds).toEqual(new Set(["a-0"]));
  });

  it("does not include structural speaker labels in the speech-token list", () => {
    // The current ReadingPageWordDTO contains only verified word tokens; the
    // speaker labels are not separate DTO metadata and are not added here.
    const dialogueTokens: SequentialReadingToken[] = [
      { word_id: "line-a-0", text: "Hôm" },
      { word_id: "line-a-1", text: "nay" },
      { word_id: "line-b-0", text: "Tôi" },
    ];
    const tracker = new SequentialReadingTracker(
      "dialogue-page",
      "dialogue-revision",
      dialogueTokens,
    );

    const result = tracker.commitFinal("dialogue-1", "Hôm nay");

    expect(result.correctWordIds).toEqual(
      new Set(["line-a-0", "line-a-1"]),
    );
    expect(result.currentWordId).toBe("line-b-0");
  });
});
