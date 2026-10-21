import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
import type { AdminPageRevisionDetailDTO } from "@/types/admin";
import {
  ADMIN_BOOK_ID,
  ADMIN_PAGE_ID,
  ADMIN_R1_ID,
  adminR1Fixture,
  adminR2Fixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";

describe("AdminOcrReviewScreen safety boundaries", () => {
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
    services.pages.replaceImageAndReprocess.mockResolvedValue(replacementDetail);

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
});
