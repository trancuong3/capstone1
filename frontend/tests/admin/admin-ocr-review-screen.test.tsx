import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AdminOcrReviewScreen,
  getOcrScoreLabel,
  getWordReviewColor,
  getWordReviewColorGroup,
  getWordReviewLabel,
  getWordReviewStatus,
} from "@/components/admin/admin-ocr-review-screen";
import { adminRevisionDetailSchema } from "@/lib/api/ocr-review-service";
import type { AdminPageRevisionDetailDTO } from "@/types/admin";
import {
  ADMIN_BOOK_ID,
  ADMIN_PAGE_ID,
  ADMIN_R1_ID,
  ADMIN_R2_ID,
  adminR1Fixture,
  adminR2Fixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";

function consensusEvidence(text: string) {
  return {
    contract: "hybrid_ocr_evidence_v4" as const,
    engine_outputs: { paddleocr: text, vietocr: text, tesseract: null },
    engine_statuses: {
      paddleocr: "success" as const,
      vietocr: "success" as const,
      tesseract: "not_run" as const,
    },
    paddle_token_index: 0,
    vietocr_token_index: 0,
    source_text: text,
    alignment: "match",
    engine_agreement_score: 0.83,
    calibrated_word_accuracy: null,
    verification_source: null,
    reference_text: null,
    reference_alignment: null,
    selected_engine: "vietocr" as const,
    selection_reason: "vietocr_nonempty_nonrepetitive_provisional",
    bbox_quality: "valid",
    crop_quality: "usable",
    crop_evidence: { status: "not_needed" },
    review_reason: "Both OCR engines returned the same mapped token.",
  };
}

function verifiedReferenceEvidence(
  source: string,
  reference: string,
  alignment: "match" | "substitute",
) {
  return {
    ...consensusEvidence(source),
    verification_source: "verified_revision" as const,
    reference_text: reference,
    reference_alignment: alignment,
  };
}

describe("AdminOcrReviewScreen safety boundaries", () => {
  function makeEditableDetail(): AdminPageRevisionDetailDTO {
    const tokens = ["Nội", "dung", "revision", "hiện", "hành"];
    return {
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW",
      draft_text: tokens.join(" "),
      words: tokens.map((text, index) => ({
        word_index: index,
        line_index: index < 3 ? 0 : 1,
        text,
        normalized_text: text.toLocaleLowerCase("vi"),
        bbox: [0.1 + index * 0.15, 0.1, 0.1, 0.04] as const,
        ocr_confidence: 0.7 + index * 0.05,
      })),
    };
  }

  it("never infers a verified word from a score, missing status, or matching text", () => {
    const word = {
      ...adminR1Fixture.words[0],
      ocr_confidence: 0.99,
      ocr_score_source: null,
      ocr_review_status: undefined,
    };
    expect(getWordReviewStatus(word, "NEEDS_REVIEW")).toBe("needs_review");
    expect(getWordReviewStatus(word, "VERIFIED")).toBe("verified");
    expect(
      getWordReviewStatus(
        { ...word, ocr_review_status: "matched" },
        "NEEDS_REVIEW",
      ),
    ).toBe("engine_agreement");
    expect(
      getWordReviewStatus(
        { ...word, ocr_review_status: "suspect" },
        "NEEDS_REVIEW",
      ),
    ).toBe("needs_review");
    expect(getOcrScoreLabel(word)).toBe("Không có điểm OCR riêng cho từ này");
    expect(
      getOcrScoreLabel({
        ...word,
        ocr_confidence: Number.NaN,
        ocr_score_source: "tesseract_raw_word_score_v1",
      }),
    ).toBe("Không có điểm OCR riêng cho từ này");
    expect(
      getOcrScoreLabel({
        ...word,
        ocr_confidence: 0.8,
        ocr_score_source: "tesseract_raw_word_score_v1",
      }),
    ).toContain("Điểm thô Tesseract: 80/100 · raw recognition score");
    expect(
      getOcrScoreLabel({
        ...word,
        ocr_confidence: 0.91,
        ocr_score_source: "dual_engine_consensus_v1",
      }),
    ).toContain("Điểm cũ chưa hiệu chuẩn · không hiển thị như xác suất");
    expect(
      getOcrScoreLabel({
        ...word,
        ocr_confidence: 0.83,
        ocr_score_source: "paddle_line_score_v1",
      }),
    ).toContain("Điểm cũ chưa hiệu chuẩn · không hiển thị như xác suất");
  });

  it("maps legacy neutral from the API to missing color and renders yellow", () => {
    const parsed = adminRevisionDetailSchema.parse({
      ...adminR1Fixture,
      verification_status: "NEEDS_REVIEW",
      words: [
        {
          ...adminR1Fixture.words[0],
          ocr_confidence: "not-a-score",
          ocr_review_status: "green",
          ocr_score_source: "untrusted-model",
          review_color_group: "neutral",
        },
      ],
    });
    expect(parsed.words[0]?.ocr_confidence).toBeNull();
    expect(parsed.words[0]?.ocr_review_status).toBe("needs_review");
    expect(parsed.words[0]?.ocr_score_source).toBeNull();
    expect(parsed.words[0]?.review_color_group).toBeUndefined();
    expect(
      getWordReviewColorGroup(
        parsed.words[0]?.ocr_review_status ?? "needs_review",
        parsed.words[0],
      ),
    ).toBe("yellow");
    expect(getWordReviewColor("engine_disagreement")).toContain(
      "border-amber-600",
    );
  });

  it("uses verified references and strict dual-engine consensus for green/red; unresolved evidence stays yellow", () => {
    for (const text of ["sư", "đồ", "cửa"]) {
      const word = {
        ...adminR1Fixture.words[0]!,
        text,
        normalized_text: text,
        ocr_review_status: "reference_match" as const,
        ocr_evidence: verifiedReferenceEvidence(text, text, "match"),
      };
      expect(getWordReviewColorGroup("reference_match", word)).toBe("green");
      expect(getWordReviewColor("reference_match", word)).toContain(
        "border-green-600",
      );
    }
    const consensus = {
      ...adminR1Fixture.words[0]!,
      text: "Chuyện",
      normalized_text: "chuyện",
      ocr_review_status: "engine_agreement" as const,
      ocr_evidence: consensusEvidence("Chuyện"),
    };
    expect(getWordReviewColorGroup("engine_agreement", consensus)).toBe(
      "green",
    );
    expect(getWordReviewLabel("engine_agreement", consensus)).toContain(
      "Hai OCR đồng thuận · chưa đối chiếu reference",
    );
    expect(getWordReviewColorGroup("engine_agreement")).toBe("yellow");

    const disagreement = {
      ...consensus,
      ocr_review_status: "engine_disagreement" as const,
      ocr_evidence: {
        ...consensusEvidence("Chuyện"),
        engine_outputs: { paddleocr: "Chuyén", vietocr: "Chuyện" },
        alignment: "substitute",
      },
    };
    expect(getWordReviewColorGroup("engine_disagreement", disagreement)).toBe(
      "yellow",
    );
    expect(getWordReviewColor("engine_disagreement", disagreement)).toContain(
      "border-amber-600",
    );

    const mismatch = {
      ...adminR1Fixture.words[0]!,
      text: "hui",
      normalized_text: "hui",
      ocr_review_status: "confirmed_mismatch" as const,
      ocr_evidence: verifiedReferenceEvidence("hui", "lui", "substitute"),
    };
    expect(getWordReviewColorGroup("confirmed_mismatch", mismatch)).toBe("red");
    expect(getWordReviewColor("confirmed_mismatch", mismatch)).toContain(
      "border-red-600",
    );
    expect(getWordReviewColorGroup("needs_review", mismatch)).toBe("red");
    expect(getWordReviewColor("needs_review", mismatch)).toContain("border-red-600");
    expect(getWordReviewLabel("needs_review", mismatch)).toBe("Sai so với reference đã xác minh");
    expect(getWordReviewColorGroup("confirmed_mismatch")).toBe("yellow");
    expect(
      getWordReviewColorGroup("engine_agreement", {
        ...consensus,
        ocr_evidence: {
          ...consensusEvidence("Chuyện"),
          verification_source: "verified_revision",
          reference_text: null,
          reference_alignment: "unmatched",
        },
      }),
    ).toBe("yellow");
    expect(getWordReviewColorGroup("verified")).toBe("green");
  });

  it("never treats raw OCR, line or agreement scores as calibrated probabilities", () => {
    const rawScoreWord = (score: number) => ({
      ...adminR1Fixture.words[0]!,
      text: "hui",
      ocr_confidence: score,
      ocr_review_status: "needs_review" as const,
      ocr_score_source: "tesseract_raw_word_score_v1" as const,
    });
    for (const score of [0, 0.2, 0.49, 0.5, 0.8, 0.81, 0.99, 1]) {
      expect(getWordReviewColorGroup("needs_review", rawScoreWord(score))).toBe(
        "yellow",
      );
      expect(
        getWordReviewColorGroup("needs_review", rawScoreWord(score), 0.99),
      ).toBe("yellow");
    }
    expect(
      getWordReviewColorGroup("engine_agreement", rawScoreWord(0.99)),
    ).toBe("yellow");
    expect(
      getWordReviewColorGroup("confirmed_mismatch", rawScoreWord(0.99)),
    ).toBe("yellow");
    expect(getWordReviewColorGroup("verified", rawScoreWord(0.1))).toBe(
      "green",
    );
    expect(
      getWordReviewColorGroup("reference_match", {
        ...rawScoreWord(0.1),
        ocr_evidence: verifiedReferenceEvidence("hui", "hui", "match"),
      }),
    ).toBe("green");
  });

  it("requires word-level evidence before classifying a legacy disagreement or failed second engine as yellow", () => {
    const baseWord = {
      ...adminR1Fixture.words[0]!,
      text: "mèo",
      normalized_text: "mèo",
      review_color_group: undefined,
      ocr_review_status: "engine_disagreement" as const,
    };
    expect(getWordReviewStatus({ ...baseWord, ocr_evidence: null })).toBe(
      "needs_review",
    );
    expect(
      getWordReviewColorGroup("engine_disagreement", {
        ...baseWord,
        ocr_evidence: null,
      }),
    ).toBe("yellow");

    const oneEngineOnly = {
      ...baseWord,
      ocr_evidence: {
        contract: "hybrid_ocr_evidence_v4" as const,
        engine_outputs: { paddleocr: "mèo", vietocr: null, tesseract: null },
        engine_statuses: {
          paddleocr: "success" as const,
          vietocr: "error" as const,
          tesseract: "not_run" as const,
        },
        source_text: "mèo",
        alignment: "unmatched",
        engine_agreement_score: null,
        calibrated_word_accuracy: null,
        verification_source: null,
        reference_text: null,
        selected_engine: "paddleocr" as const,
        selection_reason: "paddle_provisional",
        bbox_quality: "valid",
        crop_quality: "usable",
        review_reason:
          "VietOCR inference failed; PaddleOCR candidate remains available.",
      },
    };
    expect(getWordReviewStatus(oneEngineOnly)).toBe("needs_review");
    expect(getWordReviewColorGroup("needs_review", oneEngineOnly)).toBe(
      "yellow",
    );

    const disputed = {
      ...oneEngineOnly,
      ocr_evidence: {
        ...oneEngineOnly.ocr_evidence,
        engine_outputs: { paddleocr: "vé", vietocr: "về", tesseract: null },
        engine_statuses: {
          paddleocr: "success" as const,
          vietocr: "success" as const,
          tesseract: "not_run" as const,
        },
        alignment: "substitute",
      },
    };
    expect(getWordReviewStatus(disputed)).toBe("engine_disagreement");
    expect(
      getWordReviewStatus({
        ...disputed,
        ocr_review_status: "suspect",
      }),
    ).toBe("engine_disagreement");
    expect(getWordReviewColorGroup("engine_disagreement", disputed)).toBe(
      "yellow",
    );
  });

  it("shows selected word engine, alignment, line score scope, and calibration availability", async () => {
    const services = createAdminServiceFixture();
    services.ocr.getRevision.mockResolvedValue({
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW",
      draft_text: "on",
      ocr_metadata: {
        line_evidence: [{ line_index: 0, paddle_line_confidence: 0.81 }],
      },
      words: [
        {
          ...adminR1Fixture.words[0]!,
          word_index: 0,
          line_index: 0,
          text: "on",
          normalized_text: "on",
          ocr_confidence: null,
          ocr_score_source: null,
          ocr_review_status: "engine_agreement",
          ocr_evidence: {
            contract: "dual_engine_agreement_v2",
            engine_outputs: { paddleocr: "on", vietocr: "on" },
            alignment: "match",
            engine_agreement_score: 1,
            calibrated_word_accuracy: null,
            verification_source: null,
            reference_text: null,
            source_text: "on",
            review_reason: "Both engines returned the same token.",
          },
        },
      ],
    });
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    await user.click(
      await screen.findByRole("button", { name: "Từ #0 · Dòng 0" }),
    );
    const evidence = screen.getByRole("region", {
      name: "Bằng chứng OCR từ 1",
    });
    expect(within(evidence).getByText(/PaddleOCR: on ·/)).toBeInTheDocument();
    expect(within(evidence).getByText(/VietOCR: on ·/)).toBeInTheDocument();
    expect(within(evidence).getByText("Alignment: match")).toBeInTheDocument();
    expect(
      within(evidence).getByText(
        "PaddleOCR dòng: 81/100 · điểm thô · không phải xác suất đúng",
      ),
    ).toBeInTheDocument();
    expect(
      within(evidence).getByText(
        /Not calibrated · chưa có calibration evidence/,
      ),
    ).toBeInTheDocument();

    const pageText = screen.getByLabelText("Nội dung trang");
    await user.clear(pageText);
    await user.type(pageText, "Ta");

    expect(within(evidence).getByText(/PaddleOCR: on ·/)).toBeInTheDocument();
    expect(within(evidence).getByText(/VietOCR: on ·/)).toBeInTheDocument();
    expect(
      within(evidence).getByText("OCR source token: on"),
    ).toBeInTheDocument();
    expect(
      within(evidence).getByText(
        /Evidence engine thuộc token OCR ban đầu “on”/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Từ 1: Ta\./ })).toHaveClass(
      "border-amber-600",
    );
  });

  it("shows real line-level engine outputs when a safe word-level mapping is unavailable", async () => {
    const services = createAdminServiceFixture();
    services.ocr.getRevision.mockResolvedValue({
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW",
      draft_text: "công",
      ocr_metadata: {
        engine_statuses: {
          paddleocr: "success",
          vietocr: "success",
          tesseract: "not_run",
        },
        line_evidence: [
          {
            line_index: 0,
            paddle_output: "công chúa",
            vietocr_output: "công chú",
            engine_statuses: {
              paddleocr: "success",
              vietocr: "success",
              tesseract: "not_run",
            },
          },
        ],
      },
      words: [
        {
          ...adminR1Fixture.words[0]!,
          word_index: 0,
          line_index: 0,
          text: "công",
          normalized_text: "công",
          ocr_review_status: "needs_review",
          review_color_group: "yellow",
          ocr_evidence: null,
        },
      ],
    });
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    await user.click(
      await screen.findByRole("button", { name: "Từ #0 · Dòng 0" }),
    );
    const evidence = screen.getByRole("region", {
      name: "Bằng chứng OCR từ 1",
    });
    expect(
      within(evidence).getByText(
        "PaddleOCR: Đã chạy · không có token căn chỉnh an toàn cho từ này",
      ),
    ).toBeInTheDocument();
    expect(
      within(evidence).getByText(
        "VietOCR: Đã chạy · không có token căn chỉnh an toàn cho từ này",
      ),
    ).toBeInTheDocument();
    expect(
      within(evidence).getByText(
        "PaddleOCR dòng gốc (không phải token căn chỉnh): công chúa",
      ),
    ).toBeInTheDocument();
    expect(
      within(evidence).getByText(
        "VietOCR dòng gốc (không phải token căn chỉnh): công chú",
      ),
    ).toBeInTheDocument();
  });

  it("keeps Paddle line scores and all engine disagreements amber until verified", async () => {
    const services = createAdminServiceFixture();
    const makeDisputedWord = (
      wordIndex: number,
      lineIndex: number,
      text: string,
      paddleToken: string,
      vietocrToken: string,
    ) => ({
      ...adminR2Fixture.words[0]!,
      word_index: wordIndex,
      line_index: lineIndex,
      text,
      normalized_text: text.toLocaleLowerCase("vi"),
      bbox: [0.05 + wordIndex * 0.2, 0.1, 0.1, 0.04] as [
        number,
        number,
        number,
        number,
      ],
      ocr_confidence: null,
      ocr_score_source: null,
      ocr_review_status: "engine_disagreement" as const,
      ocr_evidence: {
        contract: "dual_engine_agreement_v2" as const,
        engine_outputs: { paddleocr: paddleToken, vietocr: vietocrToken },
        alignment: "substitute",
        engine_agreement_score: 0.4,
        calibrated_word_accuracy: null,
        verification_source: null,
        reference_text: null,
        review_reason: "Hai engine OCR trả về token khác nhau.",
      },
    });
    services.ocr.getRevision.mockResolvedValue({
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW",
      draft_text: "đừng chàng mới",
      ocr_metadata: {
        line_evidence: [
          {
            line_index: 0,
            paddle_line_confidence: 0.93,
            paddle_line_score_contract: "paddle_line_score_v1",
            vietocr_output_used: false,
          },
          {
            line_index: 1,
            paddle_line_confidence: 0.94,
            paddle_line_score_contract: "paddle_line_score_v1",
            vietocr_output_used: false,
          },
          {
            line_index: 2,
            paddle_line_confidence: 0.99,
            paddle_line_score_contract: "paddle_line_score_v1",
            vietocr_output_used: true,
          },
        ],
      },
      words: [
        makeDisputedWord(0, 0, "đừng", "đừng", "dung"),
        makeDisputedWord(1, 1, "chàng", "chàng", "trăng"),
        makeDisputedWord(2, 2, "mới", "mười", "mới"),
      ],
    });

    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    const accentDifference = await screen.findByRole("button", {
      name: /Từ 1: đừng\. Hai OCR chỉ khác dấu tiếng Việt · cần đối chiếu ảnh/,
    });
    const highPaddleScore = screen.getByRole("button", {
      name: /Từ 2: chàng\. Hai OCR bất đồng · chưa thể xác định candidate đúng/,
    });
    const vietOcrSelected = screen.getByRole("button", {
      name: /Từ 3: mới\. Hai OCR bất đồng · chưa thể xác định candidate đúng/,
    });

    expect(accentDifference).toHaveClass("border-amber-600");
    expect(highPaddleScore).toHaveClass("border-amber-600");
    expect(vietOcrSelected).toHaveClass("border-amber-600");
    expect(screen.getByRole("button", { name: "Cần xem (3)" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Từ #1 · Dòng 1" }),
    ).toBeInTheDocument();
  });

  it("returns safe not-found for a page outside the requested book without fetching its content", async () => {
    const services = createAdminServiceFixture();
    const foreignPageId = "83000000-0000-4000-8000-000000000003";
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={foreignPageId} />,
        services,
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy trang" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/không thuộc sách/i)).toBeInTheDocument();
    expect(screen.queryByText(foreignPageId)).not.toBeInTheDocument();
    expect(services.pages.list).toHaveBeenCalledWith(ADMIN_BOOK_ID);
    expect(services.pages.getImage).not.toHaveBeenCalled();
    expect(services.revisions.list).not.toHaveBeenCalled();
    expect(services.ocr.getRevision).not.toHaveBeenCalled();
  });

  it("keeps verified text read-only while preserving the option to reprocess", async () => {
    const services = createAdminServiceFixture();
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );
    expect(
      await screen.findByRole("heading", { name: /Kiểm tra OCR · R2/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nội dung trang")).toHaveValue(
      adminR2Fixture.draft_text,
    );
    expect(screen.getByLabelText("Nội dung trang")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Chạy lại OCR/ })).toBeEnabled();
    expect(screen.getAllByText(/hiện hành/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /R1/ }));
    expect(
      await screen.findByRole("heading", { name: /Kiểm tra OCR · R1/ }),
    ).toBeInTheDocument();
    expect(services.ocr.getRevision).toHaveBeenLastCalledWith(
      ADMIN_PAGE_ID,
      ADMIN_R1_ID,
    );
    expect(screen.getByLabelText("Nội dung trang")).toHaveValue(
      adminR1Fixture.draft_text,
    );
    expect(screen.getByLabelText("Nội dung trang")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Chạy lại OCR/ })).toBeEnabled();
    expect(
      screen.getByRole("group", { name: /Bounding box từ OCR: 1 từ/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Chạy lại OCR/ }));
    expect(services.revisions.reprocess).toHaveBeenCalledWith(
      ADMIN_PAGE_ID,
      expect.any(Function),
    );
    expect(services.revisions.verify).not.toHaveBeenCalled();
    expect(services.ocr.saveDraft).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Không thể chạy lại OCR/),
    ).toBeInTheDocument();
    expect(screen.queryByText(ADMIN_R1_ID)).not.toBeInTheDocument();
  });

  it("reuploads an image for only the selected page and presents its unverified OCR", async () => {
    const services = createAdminServiceFixture();
    const user = userEvent.setup();
    const replacementDetail: AdminPageRevisionDetailDTO = {
      ...adminR2Fixture,
      page_revision_id: "55555555-5555-4555-8555-555555555555",
      revision_no: 3,
      verification_status: "NEEDS_REVIEW",
      draft_text: "Nội.",
    };
    services.pages.replaceImageAndReprocess.mockResolvedValue(
      replacementDetail,
    );

    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );
    expect(
      await screen.findByRole("heading", { name: /Kiểm tra OCR · R2/ }),
    ).toBeInTheDocument();

    const file = new File(["replacement image"], "replacement.png", {
      type: "image/png",
    });
    await user.upload(
      screen.getByLabelText(/Tải ảnh mới cho riêng trang này/),
      file,
    );
    await user.click(
      screen.getByRole("button", { name: /Tải ảnh mới và chạy OCR/ }),
    );

    expect(services.pages.replaceImageAndReprocess).toHaveBeenCalledWith(
      ADMIN_PAGE_ID,
      file,
    );
    expect(
      await screen.findByText(/Bản mới đang chờ duyệt/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Kiểm tra OCR · R3/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nội dung trang")).toHaveValue("Nội.");
    expect(services.pages.getImage).toHaveBeenCalledWith(ADMIN_PAGE_ID);
    expect(services.revisions.verify).not.toHaveBeenCalled();
  });

  it("renders verified-reference mismatch red, dual-engine consensus green, and unresolved words yellow", async () => {
    const services = createAdminServiceFixture();
    const reviewDetail: AdminPageRevisionDetailDTO = {
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW",
      words: [
        {
          ...adminR1Fixture.words[0]!,
          word_index: 0,
          text: "Cao",
          normalized_text: "cao",
          bbox: [0.05, 0.1, 0.1, 0.04],
          ocr_confidence: 0.95,
          ocr_review_status: "confirmed_mismatch",
          ocr_evidence: verifiedReferenceEvidence("Cao", "Thấp", "substitute"),
        },
        {
          ...adminR1Fixture.words[0]!,
          word_index: 1,
          text: "Vừa",
          normalized_text: "vừa",
          bbox: [0.2, 0.1, 0.1, 0.04],
          ocr_confidence: 0.8,
          ocr_review_status: "needs_review",
        },
        {
          ...adminR1Fixture.words[0]!,
          word_index: 2,
          text: "Thấp",
          normalized_text: "thấp",
          bbox: [0.35, 0.1, 0.1, 0.04],
          ocr_confidence: 0.5,
          ocr_review_status: "verified",
        },
        {
          ...adminR1Fixture.words[0]!,
          word_index: 3,
          text: "Chưa rõ",
          normalized_text: "chưa rõ",
          bbox: [0.5, 0.1, 0.1, 0.04],
          ocr_confidence: null,
          ocr_review_status: undefined,
        },
        {
          ...adminR1Fixture.words[0]!,
          word_index: 4,
          text: "Khớp",
          normalized_text: "khớp",
          bbox: [0.65, 0.1, 0.1, 0.04],
          ocr_confidence: 0.97,
          ocr_review_status: "matched",
          ocr_score_source: "dual_engine_consensus_v1",
          ocr_evidence: consensusEvidence("Khớp"),
        },
      ],
    };
    services.ocr.getRevision.mockResolvedValue(reviewDetail);
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );
    const mismatch = await screen.findByRole("button", {
      name: /Từ 1: Cao\. Sai so với reference đã xác minh/,
    });
    const needsReview = screen.getByRole("button", {
      name: /Từ 2: Vừa\. Chưa đủ bằng chứng OCR · cần Admin đối chiếu ảnh/,
    });
    const verified = screen.getByRole("button", {
      name: /Từ 3: Thấp\. Admin đã xác minh từ/,
    });
    const unknown = screen.getByRole("button", {
      name: /Từ 4: Chưa rõ\. Chưa đủ bằng chứng OCR · cần Admin đối chiếu ảnh/,
    });
    const engineAgreement = screen.getByRole("button", {
      name: /Từ 5: Khớp\. Hai OCR đồng thuận · chưa đối chiếu reference/,
    });
    expect(mismatch).toHaveClass("border-red-600");
    expect(needsReview).toHaveClass("border-amber-600");
    expect(verified).toHaveClass("border-green-600");
    expect(unknown).toHaveClass("border-amber-600");
    expect(engineAgreement).toHaveClass("border-green-600");
    const stats = screen.getByRole("group", {
      name: "Thống kê trạng thái từ OCR",
    });
    expect(stats).toHaveTextContent(/2\s*Xanh · evidence tốt/);
    expect(stats).toHaveTextContent(/1\s*Đỏ · reference xác nhận sai/);
    expect(stats).toHaveTextContent(/2\s*Vàng · cần kiểm tra/);
    expect(stats).not.toHaveTextContent(/Trung tính|Neutral/i);
    expect(screen.getByRole("button", { name: "Cần xem (3)" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Từ #1 · Dòng 0" }));
    expect(needsReview).toHaveAttribute("aria-pressed", "true");
    expect(mismatch).toHaveAttribute("aria-pressed", "false");
    await user.click(unknown);
    expect(unknown).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Từ #3 · Dòng 0" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("renders mixed OCR evidence at word granularity without color spreading across a line", async () => {
    const services = createAdminServiceFixture();
    type ReviewStatus = NonNullable<
      AdminPageRevisionDetailDTO["words"][number]["ocr_review_status"]
    >;
    type ColorGroup = "green" | "yellow" | "red";
    const makeWord = (
      wordIndex: number,
      status: ReviewStatus,
      colorGroup: ColorGroup,
      evidence: AdminPageRevisionDetailDTO["words"][number]["ocr_evidence"],
    ) => {
      const text = `từ${wordIndex + 1}`;
      return {
        ...adminR1Fixture.words[0]!,
        word_index: wordIndex,
        line_index: 0,
        text,
        normalized_text: text,
        bbox: [0.02 + wordIndex * 0.043, 0.1, 0.035, 0.04] as [
          number,
          number,
          number,
          number,
        ],
        ocr_confidence: null,
        ocr_score_source: null,
        ocr_review_status: status,
        review_color_group: colorGroup,
        ocr_evidence: evidence,
      };
    };
    const evidence = (
      text: string,
      overrides: Partial<
        NonNullable<AdminPageRevisionDetailDTO["words"][number]["ocr_evidence"]>
      > = {},
    ): NonNullable<
      AdminPageRevisionDetailDTO["words"][number]["ocr_evidence"]
    > => ({
      ...consensusEvidence(text),
      ...overrides,
    });

    const words = [
      ...Array.from({ length: 8 }, (_, index) =>
        makeWord(
          index,
          "engine_agreement",
          "green",
          evidence(`từ${index + 1}`),
        ),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        makeWord(
          index + 8,
          "verified",
          "green",
          evidence(`từ${index + 9}`, {
            verification_source: "admin",
          }),
        ),
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        makeWord(
          index + 11,
          "confirmed_mismatch",
          "red",
          evidence(`từ${index + 12}`, {
            reference_text: "ground-truth",
            verification_source: "verified_revision",
            reference_alignment: "substitute",
          }),
        ),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        makeWord(
          index + 13,
          "engine_disagreement",
          "yellow",
          evidence(`từ${index + 14}`, {
            engine_outputs: {
              paddleocr: `từ${index + 14}`,
              vietocr: `từ${index + 14} sai`,
              tesseract: null,
            },
            alignment: "substitute",
            engine_agreement_score: 0,
          }),
        ),
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        makeWord(
          index + 16,
          "needs_review",
          "yellow",
          evidence(`từ${index + 17}`, {
            engine_outputs: {
              paddleocr: `từ${index + 17}`,
              vietocr: null,
              tesseract: null,
            },
            engine_statuses: {
              paddleocr: "success",
              vietocr: "not_initialized",
              tesseract: "not_run",
            },
            selected_engine: "paddleocr",
            alignment: "unmatched",
          }),
        ),
      ),
      makeWord(
        18,
        "needs_review",
        "yellow",
        evidence("từ19", {
          crop_quality: "low",
          review_reason: "Crop quality thấp, cần Admin xem lại.",
        }),
      ),
      makeWord(19, "needs_review", "yellow", null),
    ];
    services.ocr.getRevision.mockResolvedValue({
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW",
      draft_text: words.map((word) => word.text).join(" "),
      words,
    });
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );
    const wordButtons = await screen.findAllByRole("button", {
      name: /^Từ \d+:/,
    });
    expect(wordButtons).toHaveLength(20);
    expect(
      screen.getByRole("button", { name: /Từ 1: từ1\. Hai OCR đồng thuận/ }),
    ).toHaveClass("border-green-600");
    expect(
      screen.getByRole("button", { name: /Từ 9: từ9\. Admin đã xác minh từ/ }),
    ).toHaveClass("border-green-600");
    expect(
      screen.getByRole("button", {
        name: /Từ 12: từ12\. Sai so với reference/,
      }),
    ).toHaveClass("border-red-600");
    expect(
      screen.getByRole("button", { name: /Từ 14: từ14\. Hai OCR bất đồng/ }),
    ).toHaveClass("border-amber-600");
    expect(screen.getByRole("button", { name: /^Từ 17: từ17\./ })).toHaveClass(
      "border-amber-600",
    );
    expect(
      screen.getByRole("button", { name: /Từ 19: từ19\. Crop quality thấp/ }),
    ).toHaveClass("border-amber-600");
    expect(
      screen.getByRole("button", {
        name: /Từ 20: từ20\. Chưa đủ bằng chứng OCR/,
      }),
    ).toHaveClass("border-amber-600");

    const stats = screen.getByRole("group", {
      name: "Thống kê trạng thái từ OCR",
    });
    expect(stats).toHaveTextContent(/11\s*Xanh/);
    expect(stats).toHaveTextContent(/2\s*Đỏ/);
    expect(stats).toHaveTextContent(/7\s*Vàng/);
    expect(stats).not.toHaveTextContent(/Trung tính|Neutral/i);
    await user.click(screen.getByRole("button", { name: "Rủi ro cao (7)" }));
    expect(
      screen.getAllByRole("button", { name: /^Từ #\d+ · Dòng \d+$/ }),
    ).toHaveLength(7);
    expect(screen.getByText("Đang hiện 7/20 từ")).toBeInTheDocument();
  });

  it("marks exact dual-engine agreement green before Admin verification", async () => {
    const services = createAdminServiceFixture();
    services.ocr.getRevision.mockResolvedValue({
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW",
      words: [
        {
          ...adminR1Fixture.words[0]!,
          text: "Nội",
          ocr_confidence: 0.97,
          ocr_review_status: "matched",
          ocr_score_source: "dual_engine_consensus_v1",
          ocr_evidence: consensusEvidence("Nội"),
        },
      ],
    });
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );
    const matchedWord = await screen.findByRole("button", {
      name: /Từ 1: Nội\. Hai OCR đồng thuận · chưa đối chiếu reference/,
    });
    expect(matchedWord).toHaveClass("border-green-600");
    expect(screen.getByRole("button", { name: "Cần xem (0)" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("keeps raw Tesseract-only tokens yellow without calibration or verified reference", async () => {
    const services = createAdminServiceFixture();
    services.ocr.getRevision.mockResolvedValue({
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW",
      words: [
        {
          ...adminR2Fixture.words[0]!,
          word_index: 0,
          text: "Cao",
          normalized_text: "cao",
          bbox: [0.1, 0.1, 0.1, 0.04],
          ocr_confidence: 0.95,
          ocr_score_source: "tesseract_raw_word_score_v1",
          ocr_review_status: "needs_review",
        },
        {
          ...adminR2Fixture.words[0]!,
          word_index: 1,
          text: "Vừa",
          normalized_text: "vừa",
          bbox: [0.25, 0.1, 0.1, 0.04],
          ocr_confidence: 0.62,
          ocr_score_source: "tesseract_raw_word_score_v1",
          ocr_review_status: "needs_review",
        },
        {
          ...adminR2Fixture.words[0]!,
          word_index: 2,
          text: "Thấp",
          normalized_text: "thấp",
          bbox: [0.4, 0.1, 0.1, 0.04],
          ocr_confidence: 0.27,
          ocr_score_source: "tesseract_raw_word_score_v1",
          ocr_review_status: "needs_review",
        },
      ],
    });
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    const overlay = await screen.findByRole("group", {
      name: /Bounding box từ OCR: 3 từ/,
    });
    const high = await screen.findByRole("button", {
      name: /Từ 1: Cao\. Chưa đủ bằng chứng OCR · cần Admin đối chiếu ảnh.*Điểm thô Tesseract: 95\/100 · raw recognition score/,
    });
    const medium = screen.getByRole("button", {
      name: /Từ 2: Vừa\. Chưa đủ bằng chứng OCR · cần Admin đối chiếu ảnh.*Điểm thô Tesseract: 62\/100 · raw recognition score/,
    });
    const low = screen.getByRole("button", {
      name: /Từ 3: Thấp\. Chưa đủ bằng chứng OCR · cần Admin đối chiếu ảnh.*Điểm thô Tesseract: 27\/100 · raw recognition score/,
    });
    expect(overlay).toContainElement(high);
    expect(high).toHaveClass("border-amber-600");
    expect(medium).toHaveClass("border-amber-600");
    expect(low).toHaveClass("border-amber-600");
    expect(screen.getByRole("button", { name: "Cần xem (3)" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.queryByText(/Màu đỏ theo ngưỡng điểm thấp/),
    ).not.toBeInTheDocument();
  });

  it("synchronizes one-to-one text edits with words without changing bbox and blocks unsafe token-count changes", async () => {
    const services = createAdminServiceFixture();
    const editableDetail = {
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW" as const,
      draft_text: "Tôi đi học.",
      words: [
        {
          ...adminR1Fixture.words[0],
          word_index: 0,
          text: "Tôi",
          normalized_text: "tôi",
          bbox: [0.1, 0.2, 0.15, 0.04] as [number, number, number, number],
          ocr_confidence: 0.71,
        },
        {
          ...adminR1Fixture.words[0],
          word_index: 1,
          text: "đi",
          normalized_text: "đi",
          bbox: [0.28, 0.2, 0.1, 0.04] as [number, number, number, number],
          ocr_confidence: 0.82,
        },
        {
          ...adminR1Fixture.words[0],
          word_index: 2,
          text: "học.",
          normalized_text: "học",
          bbox: [0.4, 0.2, 0.2, 0.04] as [number, number, number, number],
          ocr_confidence: 0.91,
        },
      ],
    };
    services.ocr.getRevision.mockResolvedValue(editableDetail);
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    const pageText = await screen.findByLabelText("Nội dung trang");
    expect(pageText).toHaveValue("Tôi đi học.");
    await user.click(screen.getByRole("button", { name: "Tất cả (3)" }));
    await user.click(
      screen.getAllByText("Tọa độ vùng ảnh · chỉnh sửa nâng cao")[0]!,
    );
    const boxes = [
      screen.getByLabelText("Từ 0 bbox x"),
      screen.getByLabelText("Từ 0 bbox y"),
      screen.getByLabelText("Từ 0 bbox w"),
      screen.getByLabelText("Từ 0 bbox h"),
    ];
    const originalBoxValues = boxes.map(
      (box) => (box as HTMLInputElement).value,
    );

    await user.clear(pageText);
    await user.type(pageText, "Ta đi học.");

    const wordInputs = screen.getAllByLabelText(/^Chỉnh từ OCR - Từ \d+$/);
    expect(
      wordInputs.map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Ta", "đi", "học."]);
    expect(screen.getByLabelText("Chỉnh từ OCR - Từ 1")).toHaveValue("Ta");
    expect(screen.getByLabelText("Chỉnh từ OCR - Từ 2")).toHaveValue("đi");
    expect(screen.getByLabelText("Chỉnh từ OCR - Từ 3")).toHaveValue("học.");
    expect(pageText).toHaveValue("Ta đi học.");
    expect(boxes.map((box) => (box as HTMLInputElement).value)).toEqual(
      originalBoxValues,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.clear(pageText);
    await user.type(pageText, "Ta rất đi học.");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /để không gán nhầm tọa độ/i,
    );
    expect(screen.getByRole("button", { name: /Lưu bản nháp/ })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Xác minh trang/ }),
    ).toBeDisabled();

    await user.clear(pageText);
    await user.type(pageText, "Ta đi học.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen
        .getAllByLabelText(/^Chỉnh từ OCR - Từ \d+$/)
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Ta", "đi", "học."]);
  });

  it("scrolls the word list to the first uncertain OCR word", async () => {
    const services = createAdminServiceFixture();
    services.ocr.getRevision.mockResolvedValue({
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW",
      words: adminR2Fixture.words.map((word) => ({
        ...word,
        ocr_confidence: null,
        ocr_review_status: "needs_review",
      })),
    });
    const user = userEvent.setup();
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    const scrollSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollSpy,
    });

    try {
      render(
        withAdminFixture(
          <AdminOcrReviewScreen
            bookId={ADMIN_BOOK_ID}
            pageId={ADMIN_PAGE_ID}
          />,
          services,
        ),
      );
      await screen.findByRole("heading", { name: /Kiểm tra OCR · R2/ });
      await user.click(
        screen.getByRole("button", { name: /Đi tới từ cần kiểm tra/ }),
      );

      expect(scrollSpy).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
      });
      expect(
        screen.getByRole("button", { name: "Từ #0 · Dòng 0" }),
      ).toHaveAttribute("aria-pressed", "true");
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalDescriptor,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("previews local AI changes and applies them only after confirmation", async () => {
    const services = createAdminServiceFixture();
    const source = makeEditableDetail();
    services.ocr.getRevision.mockResolvedValue(source);
    services.ocr.aiCorrectText.mockResolvedValue("Nội dung mới đã sửa");
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    await screen.findByDisplayValue(source.draft_text ?? "");
    await user.click(
      screen.getAllByText("Tọa độ vùng ảnh · chỉnh sửa nâng cao")[0]!,
    );
    const boxLabels = [
      "Từ 0 bbox x",
      "Từ 0 bbox y",
      "Từ 0 bbox w",
      "Từ 0 bbox h",
    ];
    const originalBoxes = boxLabels.map(
      (label) => (screen.getByLabelText(label) as HTMLInputElement).value,
    );
    await user.click(screen.getByRole("button", { name: /AI sửa chính tả/ }));

    const textarea = screen.getByLabelText("Nội dung trang");
    expect(
      await screen.findByRole("heading", { name: "Rà soát đề xuất AI" }),
    ).toBeInTheDocument();
    expect(textarea).toHaveValue(source.draft_text);
    const review = screen.getByRole("region", { name: "Rà soát đề xuất AI" });
    const selectionStatus = within(review).getByText(/Đã chọn 0 \/ 3 đề xuất/);
    expect(selectionStatus).toBeInTheDocument();
    const proposalCheckboxes = within(review).getAllByRole("checkbox");
    expect(proposalCheckboxes).toHaveLength(3);
    expect(
      proposalCheckboxes.every(
        (checkbox) => !(checkbox as HTMLInputElement).checked,
      ),
    ).toBe(true);
    expect(within(review).getByText("mới", { selector: "strong" })).toHaveClass(
      "bg-amber-100",
    );
    expect(
      within(review).getAllByText(/Từ AI: chưa đối chiếu ảnh/),
    ).toHaveLength(3);
    expect(
      within(review).getAllByText(/không có điểm OCR cấp từ/),
    ).toHaveLength(3);

    await user.click(proposalCheckboxes[1]!);
    expect(
      within(review).getByText(/Đã chọn 1 \/ 3 đề xuất/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Áp dụng thay đổi đã chọn/ }),
    ).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Chọn tất cả" }));
    expect(
      within(review).getByText(/Đã chọn 3 \/ 3 đề xuất/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bỏ chọn tất cả" }));
    expect(
      within(review).getByText(/Đã chọn 0 \/ 3 đề xuất/),
    ).toBeInTheDocument();
    await user.click(proposalCheckboxes[1]!);
    expect(
      within(review).getByText(/Đã chọn 1 \/ 3 đề xuất/),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Áp dụng thay đổi đã chọn/ }),
    );
    expect(textarea).toHaveValue("Nội dung revision đã hành");
    const wordInputs = screen.getAllByLabelText(/^Chỉnh từ OCR - Từ \d+$/);
    expect(
      wordInputs.map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Nội", "dung", "revision", "đã", "hành"]);
    expect(
      screen.getByRole("button", {
        name: /Từ 4: đã\. Chưa đủ bằng chứng OCR · cần Admin đối chiếu ảnh/,
      }),
    ).toBeInTheDocument();
    expect(
      boxLabels.map(
        (label) => (screen.getByLabelText(label) as HTMLInputElement).value,
      ),
    ).toEqual(originalBoxes);
    expect(
      screen.getByText(/Đã áp dụng .* thay đổi AI vào bản nháp/),
    ).toBeInTheDocument();
  });

  it("activates the verified words and version only after Admin verification", async () => {
    const services = createAdminServiceFixture();
    const pending = makeEditableDetail();
    const verified: AdminPageRevisionDetailDTO = {
      ...pending,
      verification_status: "VERIFIED",
      words: pending.words.map((word) => ({
        ...word,
        ocr_confidence: null,
        ocr_score_source: null,
        ocr_review_status: "verified",
      })),
    };
    services.ocr.getRevision.mockResolvedValue(pending);
    services.revisions.verify.mockResolvedValue(verified);
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    await screen.findByRole("heading", { name: /Kiểm tra OCR · R2/ });
    expect(
      screen.getByRole("button", {
        name: /Từ 1: Nội\. Chưa đủ bằng chứng OCR · cần Admin đối chiếu ảnh/,
      }),
    ).toHaveClass("border-amber-600");
    expect(screen.getByLabelText("Nội dung trang")).toHaveValue(
      pending.draft_text,
    );

    await user.click(screen.getByRole("button", { name: /Xác minh trang/ }));

    expect(await screen.findByText(/Đã xác minh revision/)).toBeInTheDocument();
    expect(screen.getByLabelText("Nội dung trang")).toBeDisabled();
    expect(screen.getByLabelText("Nội dung trang")).toHaveValue(
      verified.draft_text,
    );
    expect(
      screen.getByRole("button", {
        name: /Từ 1: Nội\. Admin đã xác minh từ/,
      }),
    ).toHaveClass("border-green-600");
    expect(services.revisions.verify).toHaveBeenCalledWith(ADMIN_PAGE_ID, {
      page_revision_id: pending.page_revision_id,
      corrected_text: pending.draft_text,
      words: expect.any(Array),
    });
    expect(services.revisions.list).toHaveBeenCalledWith(ADMIN_PAGE_ID);
    expect(services.pages.getImage).toHaveBeenCalledWith(ADMIN_PAGE_ID);
  });

  it("rejects an AI suggestion without changing the draft or source image", async () => {
    const services = createAdminServiceFixture();
    const source = makeEditableDetail();
    services.ocr.getRevision.mockResolvedValue(source);
    services.ocr.aiCorrectText.mockResolvedValue("Nội dung AI đề xuất");
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    const textarea = await screen.findByLabelText("Nội dung trang");
    await user.click(
      screen.getAllByText("Tọa độ vùng ảnh · chỉnh sửa nâng cao")[0]!,
    );
    await user.click(screen.getByRole("button", { name: /AI sửa chính tả/ }));
    await screen.findByRole("heading", { name: "Rà soát đề xuất AI" });
    expect(textarea).toHaveValue(source.draft_text);

    await user.click(screen.getByRole("button", { name: "Bỏ đề xuất" }));

    expect(textarea).toHaveValue(source.draft_text);
    expect(services.ocr.saveDraft).not.toHaveBeenCalled();
    expect(services.revisions.verify).not.toHaveBeenCalled();
    expect(services.pages.replaceImageAndReprocess).not.toHaveBeenCalled();
  });

  it("keeps the original text and words when local AI returns a token-count mismatch", async () => {
    const services = createAdminServiceFixture();
    const source = makeEditableDetail();
    services.ocr.getRevision.mockResolvedValue(source);
    services.ocr.aiCorrectText.mockResolvedValue("Nội dung mới đã sửa quá");
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    const textarea = await screen.findByLabelText("Nội dung trang");
    await user.click(screen.getByRole("button", { name: /AI sửa chính tả/ }));

    expect(
      await screen.findByText(
        /Không thể áp dụng kết quả AI vì số từ không khớp/,
      ),
    ).toBeInTheDocument();
    expect(textarea).toHaveValue(source.draft_text);
    expect(
      screen
        .getAllByLabelText(/^Chỉnh từ OCR - Từ \d+$/)
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(source.words.map((word) => word.text));
    expect(
      screen.queryByText(/AI OCR cục bộ đã sửa lỗi chính tả/),
    ).not.toBeInTheDocument();
  });

  it("locks draft edits while local AI correction is in progress", async () => {
    const services = createAdminServiceFixture();
    const source = makeEditableDetail();
    services.ocr.getRevision.mockResolvedValue(source);
    let resolveCorrection: ((value: string) => void) | undefined;
    services.ocr.aiCorrectText.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveCorrection = resolve;
        }),
    );
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    const textarea = await screen.findByLabelText("Nội dung trang");
    await user.click(screen.getByRole("button", { name: /AI sửa chính tả/ }));
    await waitFor(() => expect(services.ocr.aiCorrectText).toHaveBeenCalled());
    expect(textarea).toBeDisabled();
    expect(
      screen.getAllByLabelText(/^Chỉnh từ OCR - Từ \d+$/)[0],
    ).toBeDisabled();
    resolveCorrection?.("Nội dung AI đã sửa");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Rà soát đề xuất AI" }),
      ).toBeInTheDocument(),
    );
    expect(textarea).toHaveValue(source.draft_text);
    await user.click(screen.getByRole("button", { name: "Chọn tất cả" }));
    await user.click(
      screen.getByRole("button", { name: /Áp dụng thay đổi đã chọn/ }),
    );
    await waitFor(() => expect(textarea).toHaveValue("Nội dung AI đã sửa"));
  });

  it("cancels a running local AI job while preserving the current draft", async () => {
    const services = createAdminServiceFixture();
    const source = makeEditableDetail();
    services.ocr.getRevision.mockResolvedValue(source);
    services.ocr.aiCorrectText.mockImplementation(
      (_pageId, _draftText, _words, onProgress, signal) => {
        onProgress?.({
          status: "RUNNING",
          completed_chunks: 1,
          total_chunks: 3,
        });
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("AI_OCR_CANCELLED")),
            { once: true },
          );
        });
      },
    );
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    const textarea = await screen.findByLabelText("Nội dung trang");
    await user.click(screen.getByRole("button", { name: /AI sửa chính tả/ }));
    expect(
      await screen.findByText(/đang xử lý đoạn 1\/3/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Hủy xử lý/ }));

    expect(await screen.findByText(/Đã hủy tác vụ AI OCR/)).toBeInTheDocument();
    expect(textarea).toHaveValue(source.draft_text);
    expect(services.ocr.saveDraft).not.toHaveBeenCalled();
  });

  it("creates a draft only from the selected current verified revision", async () => {
    const services = createAdminServiceFixture();
    const createdDraft: AdminPageRevisionDetailDTO = {
      ...makeEditableDetail(),
      page_revision_id: "84000000-0000-4000-8000-000000000003",
      revision_no: 3,
      verification_status: "NEEDS_REVIEW",
      ocr_metadata: { source_revision_id: ADMIN_R2_ID },
    };
    services.revisions.createDraft.mockResolvedValue(createdDraft);
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    await screen.findByRole("heading", { name: /Kiểm tra OCR · R2/ });
    await user.click(
      screen.getByRole("button", { name: /Tạo bản nháp để sửa nội dung/ }),
    );
    expect(
      await screen.findByRole("heading", { name: /Kiểm tra OCR · R3/ }),
    ).toBeInTheDocument();
    expect(services.revisions.createDraft).toHaveBeenCalledWith(
      ADMIN_PAGE_ID,
      ADMIN_R2_ID,
    );
  });

  it("reopens a matching pending draft instead of creating a duplicate", async () => {
    const services = createAdminServiceFixture();
    const pendingRevisionId = "84000000-0000-4000-8000-000000000003";
    const pendingDraft: AdminPageRevisionDetailDTO = {
      ...makeEditableDetail(),
      page_revision_id: pendingRevisionId,
      revision_no: 3,
      verification_status: "NEEDS_REVIEW",
      ocr_metadata: { source_revision_id: ADMIN_R2_ID },
    };
    services.revisions.list.mockResolvedValue([
      {
        page_revision_id: pendingRevisionId,
        revision_no: 3,
        verification_status: "NEEDS_REVIEW",
        created_at: pendingDraft.created_at,
        is_current_verified: false,
      },
      {
        page_revision_id: ADMIN_R2_ID,
        revision_no: 2,
        verification_status: "VERIFIED",
        created_at: adminR2Fixture.created_at,
        is_current_verified: true,
      },
      {
        page_revision_id: ADMIN_R1_ID,
        revision_no: 1,
        verification_status: "VERIFIED",
        created_at: adminR1Fixture.created_at,
        is_current_verified: false,
      },
    ]);
    services.ocr.getRevision.mockImplementation(async (_pageId, revisionId) => {
      if (revisionId === pendingRevisionId) return pendingDraft;
      if (revisionId === ADMIN_R1_ID) return adminR1Fixture;
      if (revisionId === ADMIN_R2_ID) return adminR2Fixture;
      throw new Error("Unexpected revision requested");
    });

    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    await screen.findByRole("heading", { name: /Kiểm tra OCR · R3/ });
    await user.click(screen.getByRole("button", { name: /R2/ }));
    await screen.findByRole("heading", { name: /Kiểm tra OCR · R2/ });
    await user.click(
      screen.getByRole("button", { name: /Tạo bản nháp để sửa nội dung/ }),
    );

    expect(
      await screen.findByRole("heading", { name: /Kiểm tra OCR · R3/ }),
    ).toBeInTheDocument();
    expect(services.revisions.createDraft).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Bản nháp từ revision này đã tồn tại. Đã mở lại để bạn tiếp tục chỉnh sửa.",
      ),
    ).toBeInTheDocument();
  });

  it("disables draft creation when a historical verified revision is selected", async () => {
    const services = createAdminServiceFixture();
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    await screen.findByRole("heading", { name: /Kiểm tra OCR · R2/ });
    await user.click(screen.getByRole("button", { name: /R1/ }));
    await screen.findByRole("heading", { name: /Kiểm tra OCR · R1/ });

    const createButton = screen.getByRole("button", {
      name: /Tạo bản nháp để sửa nội dung/,
    });
    expect(createButton).toBeDisabled();
    expect(services.revisions.createDraft).not.toHaveBeenCalled();
  });
});
