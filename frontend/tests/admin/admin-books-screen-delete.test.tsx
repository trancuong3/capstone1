import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { ServiceError } from "@/lib/api/service-error";
import {
  adminBookListItemFixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";

describe("Admin book deletion confirmation", () => {
  it("opens the required confirmation dialog and cancel leaves the book unchanged", async () => {
    const services = createAdminServiceFixture();
    const user = userEvent.setup();
    render(withAdminFixture(<AdminBooksScreen />, services));

    await user.click(await screen.findByRole("button", { name: "Xóa sách" }));
    const dialog = screen.getByRole("dialog", {
      name: "Xác nhận xóa sách",
    });
    expect(dialog).toHaveTextContent(
      "Bạn có chắc chắn muốn xóa sách này khỏi kho sách không?",
    );
    expect(dialog).toHaveTextContent(
      "Hệ thống vẫn giữ lại bản ghi sách và các dữ liệu lịch sử đọc, kết quả học tập, kết quả trò chơi cùng bằng chứng kiểm duyệt cần thiết.",
    );

    await user.click(within(dialog).getByRole("button", { name: "Hủy" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(services.books.delete).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        name: adminBookListItemFixture.book.title,
      }),
    ).toBeInTheDocument();
  });

  it("waits for backend confirmation, prevents repeated requests, then updates the list", async () => {
    const services = createAdminServiceFixture();
    let finishDelete:
      ((result: { book_id: string; is_deleted: true }) => void) | null = null;
    services.books.delete.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDelete = resolve;
        }),
    );
    const user = userEvent.setup();
    render(withAdminFixture(<AdminBooksScreen />, services));

    await user.click(await screen.findByRole("button", { name: "Xóa sách" }));
    const dialog = screen.getByRole("dialog", {
      name: "Xác nhận xóa sách",
    });
    const confirm = within(dialog).getByRole("button", { name: "Xóa sách" });
    await user.click(confirm);

    expect(services.books.delete).toHaveBeenCalledOnce();
    expect(
      within(dialog).getByRole("button", { name: "Đang xóa…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("heading", {
        name: adminBookListItemFixture.book.title,
      }),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Đang xóa…" }));
    expect(services.books.delete).toHaveBeenCalledOnce();

    await act(async () => {
      finishDelete?.({
        book_id: adminBookListItemFixture.book.id,
        is_deleted: true,
      });
    });

    expect(await screen.findByRole("status")).toHaveTextContent("Đã xóa sách");
    expect(
      screen.queryByRole("heading", {
        name: adminBookListItemFixture.book.title,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a safe authorization error and keeps the book when deletion fails", async () => {
    const services = createAdminServiceFixture();
    services.books.delete.mockRejectedValue(
      new ServiceError({
        code: "FORBIDDEN",
        message: "Access denied",
        status: 403,
        request_id: "request-id",
        retryable: false,
      }),
    );
    const user = userEvent.setup();
    render(withAdminFixture(<AdminBooksScreen />, services));

    await user.click(await screen.findByRole("button", { name: "Xóa sách" }));
    const dialog = screen.getByRole("dialog", {
      name: "Xác nhận xóa sách",
    });
    await user.click(within(dialog).getByRole("button", { name: "Xóa sách" }));

    expect(
      await within(dialog).findByText(
        "Tài khoản hiện tại không có quyền Admin để xóa sách.",
      ),
    ).toBeInTheDocument();
    expect(services.books.delete).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", {
        name: adminBookListItemFixture.book.title,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Đã xóa sách")).not.toBeInTheDocument();
  });
});
