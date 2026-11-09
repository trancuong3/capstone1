import { describe, expect, it } from "vitest";
import type { AdminRevisionWordDTO } from "@/types/admin";
import {
  normalizeVietnameseWord,
  syncPageTextToWords,
  syncWordsToPageText,
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
      ocr_score_source: "tesseract_raw_word_score_v1",
      ocr_review_status: "needs_review",
      ocr_evidence: {
        contract: "tesseract_raw_word_score_v1",
        engine_outputs: { tesseract: "Tôi" },
        alignment: "single_engine",
        engine_agreement_score: null,
        calibrated_word_accuracy: null,
        verification_source: null,
        reference_text: null,
        source_text: "Tôi",
        review_reason: "Only one engine produced raw evidence.",
      },
    },
    {
      word_index: 1,
      line_index: 0,
      text: "đi",
      normalized_text: "đi",
      bbox: [0.28, 0.2, 0.1, 0.04],
      ocr_confidence: 0.82,
      ocr_score_source: "tesseract_raw_word_score_v1",
      ocr_review_status: "needs_review",
    },
    {
      word_index: 2,
      line_index: 0,
      text: "học.",
      normalized_text: "học",
      bbox: [0.4, 0.2, 0.2, 0.04],
      ocr_confidence: 0.91,
      ocr_score_source: "tesseract_raw_word_score_v1",
      ocr_review_status: "needs_review",
    },
  ];
}

describe("Vietnamese OCR page text and word synchronization", () => {
  it("preserves source engine evidence but clears the old score for a corrected token", () => {
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
    expect(result.words.map((word) => word.ocr_confidence)).toEqual([
      null,
      0.82,
      0.91,
    ]);
    expect(result.words.map((word) => word.ocr_score_source)).toEqual([
      null,
      "tesseract_raw_word_score_v1",
      "tesseract_raw_word_score_v1",
    ]);
    expect(result.words.map((word) => word.ocr_review_status)).toEqual([
      "needs_review",
      "needs_review",
      "needs_review",
    ]);
    expect(result.words[0]?.ocr_evidence).toEqual(existing[0]?.ocr_evidence);
    expect(result.words[1]?.ocr_evidence).toBeUndefined();
    expect(result.words[2]?.ocr_evidence).toBeUndefined();
    expect(result.words.map((word) => word.word_index)).toEqual([0, 1, 2]);
    expect(existing[0].text).toBe("Tôi");
  });

  it("normalizes decomposed Vietnamese Unicode without changing display text", () => {
    expect(normalizeVietnameseWord("  TÔI, ")).toBe("tôi");
    expect(tokenizePageText("Ta\nđi   học.")).toEqual(["Ta", "đi", "học."]);
  });

  it("keeps line breaks when a single OCR word is edited directly", () => {
    const existing = words().map((word) => ({ ...word }));
    existing[0] = {
      ...existing[0],
      text: "Ta",
      normalized_text: "ta",
    };

    const result = syncWordsToPageText("Tôi đi\nhọc.", existing);

    expect(result.status).toBe("synchronized");
    if (result.status !== "synchronized") throw new Error("Expected sync");
    expect(result.text).toBe("Ta đi\nhọc.");
  });

  it("rejects a word entry that contains multiple tokens instead of flattening page layout", () => {
    const existing = words().map((word) => ({ ...word }));
    existing[0] = {
      ...existing[0],
      text: "Ta rất",
      normalized_text: "ta rất",
    };

    const result = syncWordsToPageText("Tôi đi\nhọc.", existing);

    expect(result.status).toBe("token-count-mismatch");
    if (result.status !== "token-count-mismatch") {
      throw new Error("Expected token count mismatch");
    }
    expect(result.text).toBe("Tôi đi\nhọc.");
    expect(result.actualTokenCount).toBe(3);
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
