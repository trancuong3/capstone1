import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
import {
  AdminServicesContext,
  type AdminServices,
} from "@/components/providers/admin-services-provider";
import type { AdminBookService } from "@/lib/api/admin-book-service";
import type { RevisionService } from "@/lib/api/revision-service";
import { createMockAdminAuthService } from "@/lib/mock/mock-admin-auth-service";
import { createMockAdminBookService } from "@/lib/mock/mock-admin-book-service";
import { createMockAdminPageService } from "@/lib/mock/mock-admin-page-service";
import {
  createMockAdminStore,
  MOCK_ADMIN_BOOK_ID,
  MOCK_ADMIN_PAGE_ID,
  MOCK_ADMIN_R1_ID,
} from "@/lib/mock/mock-admin-store";
import { createMockAuditService } from "@/lib/mock/mock-audit-service";
import { createMockHealthService } from "@/lib/mock/mock-health-service";
import { createMockOcrReviewService } from "@/lib/mock/mock-ocr-review-service";
import { createMockRevisionService } from "@/lib/mock/mock-revision-service";
import type { AdminBookListItemUI } from "@/types/admin";

describe("Admin async cleanup", () => {
  it("settles a pending list request after unmount without updating UI", async () => {
    const store = createMockAdminStore();
    let settle: (items: readonly AdminBookListItemUI[]) => void = () =>
      undefined;
    const list = vi.fn(
      () =>
        new Promise<readonly AdminBookListItemUI[]>((resolve) => {
          settle = resolve;
        }),
    );
    const books: AdminBookService = {
      ...createMockAdminBookService(store, "default"),
      list,
    };
    const services: AdminServices = {
      auth: createMockAdminAuthService("default"),
      books,
      pages: createMockAdminPageService(store, "default"),
      ocr: createMockOcrReviewService(store, "default"),
      revisions: createMockRevisionService(store, "default"),
      audit: createMockAuditService(store, "default"),
      health: createMockHealthService("default"),
    };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const view = render(
      <AdminServicesContext.Provider value={services}>
        <AdminBooksScreen />
      </AdminServicesContext.Provider>,
    );

    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      settle([]);
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not continue a delayed OCR reprocess after unmount", async () => {
    const store = createMockAdminStore();
    const review = store.revisions.get(MOCK_ADMIN_R1_ID);
    if (!review) throw new Error("Missing mock revision fixture");

    const baseRevisions = createMockRevisionService(store, "default");
    const list = vi.fn(baseRevisions.list.bind(baseRevisions));
    const reprocess = vi.fn<RevisionService["reprocess"]>(
      () =>
        new Promise((resolve) => {
          globalThis.setTimeout(() => resolve(review), 100);
        }),
    );
    const services: AdminServices = {
      auth: createMockAdminAuthService("default"),
      books: createMockAdminBookService(store, "default"),
      pages: createMockAdminPageService(store, "default"),
      ocr: createMockOcrReviewService(store, "default"),
      revisions: { ...baseRevisions, list, reprocess },
      audit: createMockAuditService(store, "default"),
      health: createMockHealthService("default"),
    };
    const view = render(
      <AdminServicesContext.Provider value={services}>
        <AdminOcrReviewScreen
          bookId={MOCK_ADMIN_BOOK_ID}
          pageId={MOCK_ADMIN_PAGE_ID}
        />
      </AdminServicesContext.Provider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Chạy lại OCR" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Tạo revision OCR mới?",
    });
    vi.useFakeTimers();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Chạy lại OCR" }),
    );
    expect(reprocess).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    view.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(list).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
