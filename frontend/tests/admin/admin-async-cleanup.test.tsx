import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
import {
  ADMIN_BOOK_ID,
  ADMIN_PAGE_ID,
  adminR1Fixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type {
  AdminBookListItemUI,
  AdminPageRevisionDetailDTO,
} from "@/types/admin";

describe("Admin async cleanup", () => {
  it("settles a pending list request after unmount without rendering its result", async () => {
    const services = createAdminServiceFixture();
    let settle: (items: readonly AdminBookListItemUI[]) => void = () =>
      undefined;
    services.books.list.mockImplementation(
      () =>
        new Promise<readonly AdminBookListItemUI[]>((resolve) => {
          settle = resolve;
        }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const view = render(withAdminFixture(<AdminBooksScreen />, services));
      await waitFor(() => expect(services.books.list).toHaveBeenCalledOnce());
      view.unmount();
      await act(async () => {
        settle([]);
      });
      expect(view.container).toBeEmptyDOMElement();
      expect(services.books.list).toHaveBeenCalledOnce();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("ignores a delayed historical revision response after unmount without starting mutations", async () => {
    const services = createAdminServiceFixture();
    const view = render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );
    await screen.findByRole("heading", { name: /Kiểm tra OCR · R2/ });
    let settle: (revision: AdminPageRevisionDetailDTO) => void = () =>
      undefined;
    services.ocr.getRevision.mockImplementationOnce(
      () =>
        new Promise<AdminPageRevisionDetailDTO>((resolve) => {
          settle = resolve;
        }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      fireEvent.click(screen.getByRole("button", { name: /R1/ }));
      expect(services.ocr.getRevision).toHaveBeenCalledTimes(2);
      view.unmount();
      await act(async () => {
        settle(adminR1Fixture);
      });
      expect(view.container).toBeEmptyDOMElement();
      expect(services.ocr.getRevision).toHaveBeenCalledTimes(2);
      expect(services.revisions.list).toHaveBeenCalledOnce();
      expect(services.revisions.reprocess).not.toHaveBeenCalled();
      expect(services.revisions.verify).not.toHaveBeenCalled();
      expect(services.ocr.saveDraft).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
