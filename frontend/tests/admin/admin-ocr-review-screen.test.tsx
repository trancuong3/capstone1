import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { AdminStoreContext } from "@/components/providers/admin-store-provider";
import {
  createMockAdminStore,
  MOCK_ADMIN_BOOK_ID,
  MOCK_ADMIN_PAGE_ID,
  MOCK_ADMIN_R1_ID,
  MOCK_REVIEW_BOOK_ID,
} from "@/lib/mock/mock-admin-store";
import { createMockRevisionService } from "@/lib/mock/mock-revision-service";

const reviewPageId = "83000000-0000-4000-8000-000000000003";

function renderWithStore(
  store: ReturnType<typeof createMockAdminStore>,
  bookId = MOCK_ADMIN_BOOK_ID,
  pageId = MOCK_ADMIN_PAGE_ID,
) {
  return render(
    <AdminStoreContext.Provider value={store}>
      <AdminServicesProvider scenario="default">
        <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </AdminServicesProvider>
    </AdminStoreContext.Provider>,
  );
}

describe("AdminOcrReviewScreen safety boundaries", () => {
  it("shows the same safe not-found state when a known page belongs to another book", async () => {
    renderWithStore(createMockAdminStore(), MOCK_ADMIN_BOOK_ID, reviewPageId);

    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy trang" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/không thuộc sách/i)).toBeInTheDocument();
    expect(screen.queryByText(MOCK_REVIEW_BOOK_ID)).toBeNull();
  });

  it("does not offer reprocess from an immutable historical revision", async () => {
    const store = createMockAdminStore();
    const revisions = createMockRevisionService(store, "default");
    const r2 = await revisions.reprocess(MOCK_ADMIN_PAGE_ID);
    await revisions.verify(MOCK_ADMIN_PAGE_ID, {
      page_revision_id: r2.page_revision_id,
      corrected_text: r2.draft_text ?? "Nội dung",
      words: r2.words,
    });
    const user = userEvent.setup();

    renderWithStore(store);
    expect(
      await screen.findByRole("button", { name: "Chạy lại OCR" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /R1/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Chạy lại OCR" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getAllByText(/revision VERIFIED hiện hành mới nhất/i),
    ).not.toHaveLength(0);
    expect(screen.getByRole("heading", { name: /R1/ })).toBeInTheDocument();
    expect(screen.queryByText(MOCK_ADMIN_R1_ID)).toBeNull();
  });
});
