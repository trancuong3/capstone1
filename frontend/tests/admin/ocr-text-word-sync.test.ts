import { describe, expect, it } from "vitest";
import type { AdminRevisionWordDTO } from "@/types/admin";
import {
  normalizeVietnameseWord,
  syncPageTextToWords,
  tokenizePageText,
} from "@/lib/ocr/sync-page-text-words";

function words(): AdminRevisionWordDTO[] {
  return [
    {
      word_index: 0,
      line_index: 0,
      text: "Tôi",
      normalized_text: "tôi",
      bbox: [0.1, 0.2, 0.15, 0.04],
      ocr_confidence: 0.71,
    },
    {
      word_index: 1,
      line_index: 0,
      text: "đi",
      normalized_text: "đi",
      bbox: [0.28, 0.2, 0.1, 0.04],
      ocr_confidence: 0.82,
    },
    {
      word_index: 2,
      line_index: 0,
      text: "học.",
      normalized_text: "học",
      bbox: [0.4, 0.2, 0.2, 0.04],
      ocr_confidence: 0.91,
    },
  ];
}

describe("Vietnamese OCR page text and word synchronization", () => {
  it("updates the page words for a one-to-one text correction and preserves every box", () => {
    const existing = words();
    const result = syncPageTextToWords("Ta đi học.", existing);

    expect(result.status).toBe("synchronized");
    if (result.status !== "synchronized") throw new Error("Expected sync");
    expect(result.words.map((word) => word.text)).toEqual(["Ta", "đi", "học."]);
    expect(result.words.map((word) => word.normalized_text)).toEqual([
      "ta",
      "đi",
      "học",
    ]);
    expect(result.words.map((word) => word.bbox)).toEqual(
      existing.map((word) => word.bbox),
    );
    expect(result.words.map((word) => word.ocr_confidence)).toEqual(
      existing.map((word) => word.ocr_confidence),
    );
    expect(result.words.map((word) => word.word_index)).toEqual([0, 1, 2]);
    expect(existing[0].text).toBe("Tôi");
  });

  it("normalizes decomposed Vietnamese Unicode without changing display text", () => {
    expect(normalizeVietnameseWord("  TÔI, ")).toBe("tôi");
    expect(tokenizePageText("Ta\nđi   học.")).toEqual(["Ta", "đi", "học."]);
  });

  it("does not invent or reassign boxes when the token count changes", () => {
    const existing = words();
    const result = syncPageTextToWords("Ta rất đi học.", existing);

    expect(result.status).toBe("token-count-mismatch");
    if (result.status !== "token-count-mismatch") {
      throw new Error("Expected token count mismatch");
    }
    expect(result.expectedWordCount).toBe(3);
    expect(result.actualTokenCount).toBe(4);
    expect(result.words).toBe(existing);
    expect(result.words.map((word) => word.bbox)).toEqual(
      existing.map((word) => word.bbox),
    );
  });
});
