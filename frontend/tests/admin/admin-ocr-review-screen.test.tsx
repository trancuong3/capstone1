import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AdminOcrReviewScreen,
  getConfidenceLevel,
} from "@/components/admin/admin-ocr-review-screen";
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

  it("classifies confidence values at the documented boundaries", () => {
    expect(getConfidenceLevel(0.95)).toBe("Cao");
    expect(getConfidenceLevel(0.81)).toBe("Cao");
    expect(getConfidenceLevel(0.8)).toBe("Trung bình");
    expect(getConfidenceLevel(0.6)).toBe("Trung bình");
    expect(getConfidenceLevel(0.5)).toBe("Thấp");
    expect(getConfidenceLevel(null)).toBe("Chưa xác định");
    expect(getConfidenceLevel(undefined)).toBe("Chưa xác định");
    expect(getConfidenceLevel(Number.NaN)).toBe("Chưa xác định");
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

  it("classifies confidence levels and synchronizes word-list and image selection", async () => {
    const services = createAdminServiceFixture();
    const reviewDetail = {
      ...adminR2Fixture,
      words: [
        {
          ...adminR1Fixture.words[0],
          word_index: 0,
          text: "Cao",
          normalized_text: "cao",
          bbox: [0.05, 0.1, 0.1, 0.04] as [number, number, number, number],
          ocr_confidence: 0.95,
        },
        {
          ...adminR1Fixture.words[0],
          word_index: 1,
          text: "Vừa",
          normalized_text: "vừa",
          bbox: [0.2, 0.1, 0.1, 0.04] as [number, number, number, number],
          ocr_confidence: 0.8,
        },
        {
          ...adminR1Fixture.words[0],
          word_index: 2,
          text: "Thấp",
          normalized_text: "thấp",
          bbox: [0.35, 0.1, 0.1, 0.04] as [number, number, number, number],
          ocr_confidence: 0.5,
        },
        {
          ...adminR1Fixture.words[0],
          word_index: 3,
          text: "Chưa rõ",
          normalized_text: "chưa rõ",
          bbox: [0.5, 0.1, 0.1, 0.04] as [number, number, number, number],
          ocr_confidence: null,
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

    const high = await screen.findByRole("button", {
      name: /Từ 1: Cao.*Mức Cao/,
    });
    const medium = screen.getByRole("button", {
      name: /Từ 2: Vừa.*Mức Trung bình/,
    });
    const low = screen.getByRole("button", {
      name: /Từ 3: Thấp.*Mức Thấp/,
    });
    const unknown = screen.getByRole("button", {
      name: /Từ 4: Chưa rõ.*Mức Chưa xác định/,
    });

    expect(high).toHaveClass("border-green-600");
    expect(medium).toHaveClass("border-yellow-500");
    expect(low).toHaveClass("border-red-600");
    expect(unknown).toHaveClass("border-orange-600");
    expect(
      screen.getByRole("group", { name: "Thống kê đối chiếu OCR" }),
    ).toBeInTheDocument();
    const stats = screen.getByRole("group", {
      name: "Thống kê confidence OCR",
    });
    expect(stats).toHaveTextContent(/1\s*Cao/);
    expect(stats).toHaveTextContent(/1\s*Trung bình/);
    expect(stats).toHaveTextContent(/1\s*Thấp/);
    expect(stats).toHaveTextContent(/1\s*Chưa xác định/);
    expect(
      screen.getByRole("button", { name: /Đi tới từ cần kiểm tra/ }),
    ).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Từ #1 · Dòng 0" }));
    expect(medium).toHaveAttribute("aria-pressed", "true");
    expect(high).toHaveAttribute("aria-pressed", "false");

    await user.click(unknown);
    expect(unknown).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Từ #3 · Dòng 0" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("shows confidence-coded boxes and selects a word", async () => {
    const services = createAdminServiceFixture();
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    const overlay = await screen.findByRole("group", {
      name: /Bounding box từ OCR: 1 từ/,
    });
    const wordBox = await screen.findByRole("button", {
      name: /Từ 1: Nội\. Confidence OCR: 0\.95\. Mức Cao/,
    });
    expect(overlay).toContainElement(wordBox);
    expect(wordBox.getAttribute("title")).toContain("Cao");

    await user.click(wordBox);
    expect(wordBox).toHaveClass("ring-2");
    expect(
      screen.getByRole("group", { name: "Thống kê confidence OCR" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Confidence OCR:/)).toBeInTheDocument();
    expect(screen.getByText(/0\.95/)).toBeInTheDocument();
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

    const wordInputs = screen.getAllByLabelText("Văn bản từ");
    expect(
      wordInputs.map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Ta", "đi", "học."]);
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
        .getAllByLabelText("Văn bản từ")
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Ta", "đi", "học."]);
  });

  it("scrolls the word list to the first uncertain OCR word", async () => {
    const services = createAdminServiceFixture();
    services.ocr.getRevision.mockResolvedValue({
      ...adminR2Fixture,
      words: adminR2Fixture.words.map((word) => ({
        ...word,
        ocr_confidence: null,
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
    const wordInputs = screen.getAllByLabelText("Văn bản từ");
    expect(
      wordInputs.map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Nội", "dung", "revision", "đã", "hành"]);
    expect(
      screen.getByRole("button", {
        name: /Từ 1: Nội\. Confidence OCR: 0\.7/,
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
        .getAllByLabelText("Văn bản từ")
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
    expect(screen.getAllByLabelText("Văn bản từ")[0]).toBeDisabled();
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
