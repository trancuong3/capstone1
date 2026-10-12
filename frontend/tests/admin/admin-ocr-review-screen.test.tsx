import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
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

  it("keeps both current and historical revisions read-only", async () => {
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
    expect(screen.getByLabelText("Nội dung đã hiệu chỉnh")).toHaveValue(
      adminR2Fixture.draft_text,
    );
    expect(screen.getByLabelText("Nội dung đã hiệu chỉnh")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Chạy lại OCR" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ngừng trang" })).toBeDisabled();
    expect(screen.getByText("Hiện hành")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /R1/ }));
    expect(
      await screen.findByRole("heading", { name: /Kiểm tra OCR · R1/ }),
    ).toBeInTheDocument();
    expect(services.ocr.getRevision).toHaveBeenLastCalledWith(
      ADMIN_PAGE_ID,
      ADMIN_R1_ID,
    );
    expect(screen.getByLabelText("Nội dung đã hiệu chỉnh")).toHaveValue(
      adminR1Fixture.draft_text,
    );
    expect(screen.getByLabelText("Nội dung đã hiệu chỉnh")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Chạy lại OCR" })).toBeDisabled();
    expect(
      screen.getByRole("img", { name: /Bounding box từ OCR: 1 vùng/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Chạy lại OCR" }));
    expect(services.revisions.reprocess).not.toHaveBeenCalled();
    expect(services.revisions.verify).not.toHaveBeenCalled();
    expect(services.ocr.saveDraft).not.toHaveBeenCalled();
    expect(services.pages.updateStatus).not.toHaveBeenCalled();
    expect(screen.queryByText(ADMIN_R1_ID)).not.toBeInTheDocument();
  });
});
