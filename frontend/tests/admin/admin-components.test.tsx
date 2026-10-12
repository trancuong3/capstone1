import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminBookForm } from "@/components/admin/admin-book-form";
import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { AdminLayout } from "@/components/admin/admin-layout";
import { AdminLoginScreen } from "@/components/admin/admin-login-screen";
import { AdminAuthError } from "@/lib/api/admin-auth-service";
import {
  adminBookListItemFixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";

const { navigationMock } = vi.hoisted(() => ({
  navigationMock: {
    pathname: "/admin/books",
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({
    push: navigationMock.push,
    refresh: navigationMock.refresh,
    replace: navigationMock.replace,
  }),
}));

describe("admin components", () => {
  beforeEach(() => {
    navigationMock.pathname = "/admin/books";
    navigationMock.push.mockClear();
    navigationMock.refresh.mockClear();
    navigationMock.replace.mockClear();
  });

  it("uses a safe message when the admin auth service rejects credentials", async () => {
    const services = createAdminServiceFixture();
    services.auth.signIn.mockRejectedValue(
      new AdminAuthError("invalid-credentials"),
    );
    const user = userEvent.setup();
    render(withAdminFixture(<AdminLoginScreen scenario="default" />, services));
    await user.type(screen.getByLabelText("Mật khẩu"), "matkhau123");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Thông tin đăng nhập chưa đúng",
    );
    expect(services.auth.signIn).toHaveBeenCalledOnce();
    expect(navigationMock.replace).not.toHaveBeenCalled();
    expect(navigationMock.push).not.toHaveBeenCalled();
  });

  it("awaits admin sign-out, blocks repeats, and replaces the protected route", async () => {
    const services = createAdminServiceFixture();
    let completeSignOut: () => void = () => undefined;
    services.auth.signOut.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeSignOut = resolve;
        }),
    );
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminLayout>
          <p>Nội dung quản trị</p>
        </AdminLayout>,
        services,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Đăng xuất" }));
    expect(services.auth.signOut).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Đang đăng xuất…" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Đang đăng xuất…" }));
    expect(services.auth.signOut).toHaveBeenCalledOnce();
    expect(navigationMock.replace).not.toHaveBeenCalled();
    await act(async () => {
      completeSignOut();
    });
    await waitFor(() =>
      expect(navigationMock.replace).toHaveBeenCalledWith("/admin/login"),
    );
    expect(navigationMock.refresh).toHaveBeenCalledOnce();
  });

  it("keeps the protected route visible when admin sign-out fails", async () => {
    const services = createAdminServiceFixture();
    services.auth.signOut.mockRejectedValueOnce(
      new Error("provider unavailable"),
    );
    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminLayout>
          <p>Nội dung quản trị</p>
        </AdminLayout>,
        services,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Đăng xuất" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Chưa thể đăng xuất lúc này");
    expect(alert).not.toHaveTextContent("provider unavailable");
    expect(navigationMock.replace).not.toHaveBeenCalled();
    expect(navigationMock.refresh).not.toHaveBeenCalled();
  });

  it("rejects an inverted grade range in the book form", async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    render(<AdminBookForm onSubmit={submit} />);
    await user.type(screen.getByLabelText("Tên sách"), "Sách mới");
    await user.selectOptions(screen.getByLabelText("Khối tối thiểu"), "5");
    await user.selectOptions(screen.getByLabelText("Khối tối đa"), "2");
    await user.click(screen.getByRole("button", { name: "Lưu sách" }));
    expect(
      await screen.findByText(/Khối tối đa phải lớn hơn/),
    ).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("renders lifecycle and OCR metrics from typed service responses and forwards filters", async () => {
    const services = createAdminServiceFixture();
    const retired = {
      ...adminBookListItemFixture,
      book: {
        ...adminBookListItemFixture.book,
        lifecycle_status: "RETIRED" as const,
      },
      parent_catalog_eligible: false,
    };
    const user = userEvent.setup();
    render(withAdminFixture(<AdminBooksScreen />, services));
    await screen.findByRole("heading", {
      name: adminBookListItemFixture.book.title,
    });
    expect(screen.getByText("Đang hoạt động")).toBeInTheDocument();
    const card = screen.getByRole("link", { name: /Sách kiểm thử/ });
    expect(
      within(card).getByText("Trang").nextElementSibling,
    ).toHaveTextContent("3");
    for (const label of ["Xử lý", "Cần duyệt", "Đã duyệt"]) {
      expect(
        within(card).getByText(label).nextElementSibling,
      ).toHaveTextContent("1");
    }
    services.books.list.mockResolvedValueOnce([retired]);
    await user.selectOptions(screen.getByLabelText("Vòng đời"), "RETIRED");
    expect(await screen.findByText("Đã ngừng")).toBeInTheDocument();
    expect(services.books.list).toHaveBeenLastCalledWith({
      search: "",
      lifecycle_status: "RETIRED",
      verification_status: undefined,
    });
    expect(services.books.create).not.toHaveBeenCalled();
    expect(services.books.update).not.toHaveBeenCalled();
  });
});
