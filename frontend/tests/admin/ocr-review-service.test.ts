import { describe, expect, it } from "vitest";
import { adminRevisionDetailSchema } from "@/lib/api/ocr-review-service";

describe("Admin OCR revision evidence parsing", () => {
  it("keeps both engine candidates when one legacy token index is invalid", () => {
    const parsed = adminRevisionDetailSchema.parse({
      page_id: "33333333-3333-4333-8333-333333333333",
      page_revision_id: "44444444-4444-4444-8444-444444444441",
      revision_no: 1,
      verification_status: "NEEDS_REVIEW",
      lifecycle_status: "ACTIVE",
      draft_text: "công chúa",
      words: [
        {
          word_index: 0,
          line_index: 0,
          text: "công",
          normalized_text: "công",
          bbox: [0.1, 0.2, 0.15, 0.08],
          ocr_confidence: null,
          ocr_score_source: null,
          ocr_review_status: "engine_disagreement",
          review_color_group: "yellow",
          ocr_evidence: {
            contract: "hybrid_ocr_evidence_v4",
            engine_outputs: {
              paddleocr: "công",
              vietocr: "công",
              tesseract: null,
            },
            engine_statuses: {
              paddleocr: "success",
              vietocr: "success",
              tesseract: "not_run",
            },
            paddle_token_index: -1,
            vietocr_token_index: 0,
            source_text: "công",
            alignment: "exact_match",
            engine_agreement_score: 1,
            calibrated_word_accuracy: null,
            verification_source: null,
            reference_text: null,
            review_reason: "Legacy PaddleOCR token index is invalid.",
          },
        },
      ],
      ocr_metadata: {},
      created_at: "2026-11-09T00:00:00Z",
      verified_at: null,
      verified_by: null,
    });

    const evidence = parsed.words[0]?.ocr_evidence;
    expect(evidence).toBeDefined();
    expect(evidence?.engine_outputs).toEqual({
      paddleocr: "công",
      vietocr: "công",
      tesseract: null,
    });
    expect(evidence?.paddle_token_index).toBeNull();
    expect(evidence?.vietocr_token_index).toBe(0);
  });
});
