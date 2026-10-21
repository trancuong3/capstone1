import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminNewBookScreen } from "@/components/admin/admin-new-book-screen";
import {
  adminBookFixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type { AdminBookDTO } from "@/types/admin";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

describe("AdminNewBookScreen", () => {
  beforeEach(() => {
    routerMock.push.mockReset();
    routerMock.refresh.mockReset();
  });

  it("renders separate required name and title fields", () => {
    const services = createAdminServiceFixture();
    render(withAdminFixture(<AdminNewBookScreen />, services));

    const name = screen.getByRole("textbox", { name: "Tên sách *" });
    expect(name).toBeRequired();
    expect(name).toHaveAttribute("maxLength", "250");
    const title = screen.getByRole("textbox", { name: "Tiêu đề sách *" });
    expect(title).toBeRequired();
    expect(title).toHaveAttribute("maxLength", "250");
  });

  it("rejects an empty name", async () => {
    const services = createAdminServiceFixture();
    const user = userEvent.setup();
    render(withAdminFixture(<AdminNewBookScreen />, services));

    const name = screen.getByRole("textbox", { name: "Tên sách *" });
    await user.type(screen.getByRole("textbox", { name: "Tiêu đề sách *" }), "Tiêu đề hợp lệ");
    await user.click(screen.getByRole("button", { name: "Tạo sách" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Vui lòng nhập tên sách.",
    );
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(services.books.create).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only name", async () => {
    const services = createAdminServiceFixture();
    const user = userEvent.setup();
    render(withAdminFixture(<AdminNewBookScreen />, services));

    const name = screen.getByRole("textbox", { name: "Tên sách *" });
    await user.type(name, "   ");
    await user.type(
      screen.getByRole("textbox", { name: "Tiêu đề sách *" }),
      "Tiêu đề hợp lệ",
    );
    await user.click(screen.getByRole("button", { name: "Tạo sách" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Vui lòng nhập tên sách.",
    );
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(services.books.create).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("rejects an empty title", async () => {
    const services = createAdminServiceFixture();
    const user = userEvent.setup();
    render(withAdminFixture(<AdminNewBookScreen />, services));

    await user.type(
      screen.getByRole("textbox", { name: "Tên sách *" }),
      "Tên riêng",
    );
    const title = screen.getByRole("textbox", { name: "Tiêu đề sách *" });
    await user.click(screen.getByRole("button", { name: "Tạo sách" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Vui lòng nhập tiêu đề sách.",
    );
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(title).toHaveValue("");
    expect(services.books.create).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only title", async () => {
    const services = createAdminServiceFixture();
    const user = userEvent.setup();
    render(withAdminFixture(<AdminNewBookScreen />, services));

    await user.type(
      screen.getByRole("textbox", { name: "Tên sách *" }),
      "Tên riêng",
    );
    const title = screen.getByRole("textbox", { name: "Tiêu đề sách *" });
    await user.type(title, "   ");
    await user.click(screen.getByRole("button", { name: "Tạo sách" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Vui lòng nhập tiêu đề sách.",
    );
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(title).toHaveValue("   ");
    expect(services.books.create).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("trims the title and redirects after create succeeds", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.books.create).mockResolvedValue({
      ...adminBookFixture,
      id: "81000000-0000-4000-8000-000000000099",
      title: "Sách mới",
    });
    const user = userEvent.setup();
    render(withAdminFixture(<AdminNewBookScreen />, services));

    await user.type(
      screen.getByRole("textbox", { name: "Tên sách *" }),
      "  Tên hiển thị  ",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Tiêu đề sách *" }),
      "  Sách mới  ",
    );
    await user.type(screen.getByRole("textbox", { name: /Tác giả/ }), "  ");
    await user.click(screen.getByRole("button", { name: "Tạo sách" }));

    await waitFor(() => {
      expect(services.books.create).toHaveBeenCalledWith({
        name: "Tên hiển thị",
        title: "Sách mới",
        author: null,
        min_grade: 1,
        max_grade: 5,
      });
    });
    expect(routerMock.push).toHaveBeenCalledWith(
      "/admin/books/81000000-0000-4000-8000-000000000099",
    );
  });

  it("preserves values and shows a safe error on API failure", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.books.create).mockRejectedValue(
      new Error("server details must not be exposed"),
    );
    const user = userEvent.setup();
    render(withAdminFixture(<AdminNewBookScreen />, services));

    const name = screen.getByRole("textbox", { name: "Tên sách *" });
    await user.type(name, "Tên chưa được tạo");
    const title = screen.getByRole("textbox", { name: "Tiêu đề sách *" });
    await user.type(title, "Sách chưa được tạo");
    await user.click(screen.getByRole("button", { name: "Tạo sách" }));

    expect(
      await screen.findByText(
        "Không thể tạo sách. Hãy kiểm tra quyền Admin, kết nối Backend và thử lại.",
      ),
    ).toBeInTheDocument();
    expect(name).toHaveValue("Tên chưa được tạo");
    expect(title).toHaveValue("Sách chưa được tạo");
    const author = screen.getByRole("textbox", { name: /Tác giả/ });
    expect(author).toHaveValue("");
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("blocks duplicate submissions while a request is pending", async () => {
    const services = createAdminServiceFixture();
    let resolveCreate: ((book: AdminBookDTO) => void) | undefined;
    vi.mocked(services.books.create).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const user = userEvent.setup();
    render(withAdminFixture(<AdminNewBookScreen />, services));

    await user.type(
      screen.getByRole("textbox", { name: "Tên sách *" }),
      "Tên một lần",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Tiêu đề sách *" }),
      "Sách một lần",
    );
    const submitButton = screen.getByRole("button", { name: "Tạo sách" });
    await user.click(submitButton);
    await waitFor(() => {
      expect(services.books.create).toHaveBeenCalledOnce();
    });
    await user.click(submitButton);
    expect(services.books.create).toHaveBeenCalledOnce();

    resolveCreate?.(adminBookFixture);
    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith(
        `/admin/books/${adminBookFixture.id}`,
      );
    });
  });
});
