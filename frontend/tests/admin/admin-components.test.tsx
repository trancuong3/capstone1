import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminBookForm } from "@/components/admin/admin-book-form";
import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { AdminLayout } from "@/components/admin/admin-layout";
import { AdminLoginScreen } from "@/components/admin/admin-login-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { AdminStoreProvider } from "@/components/providers/admin-store-provider";

const { navigationMock, signOutMock } = vi.hoisted(() => ({
  navigationMock: {
    pathname: "/admin/books",
    push: vi.fn(),
    replace: vi.fn(),
  },
  signOutMock: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({
    push: navigationMock.push,
    replace: navigationMock.replace,
  }),
}));

vi.mock("@/lib/mock/mock-admin-auth-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mock/mock-admin-auth-service")>();

  return {
    ...actual,
    createMockAdminAuthService: (
      scenario: Parameters<typeof actual.createMockAdminAuthService>[0],
    ) => ({
      ...actual.createMockAdminAuthService(scenario),
      signOut: signOutMock,
    }),
  };
});

function withServices(child: React.ReactNode, scenario = "default") {
  return render(
    <AdminStoreProvider>
      <AdminServicesProvider
        scenario={scenario as "default" | "invalid-credentials"}
      >
        {child}
      </AdminServicesProvider>
    </AdminStoreProvider>,
  );
}

describe("admin components", () => {
  beforeEach(() => {
    navigationMock.pathname = "/admin/books";
    navigationMock.push.mockClear();
    navigationMock.replace.mockClear();
    signOutMock.mockReset();
    signOutMock.mockResolvedValue(undefined);
  });

  it("validates the admin login and uses a safe credential message", async () => {
    const user = userEvent.setup();
    withServices(
      <AdminLoginScreen scenario="invalid-credentials" />,
      "invalid-credentials",
    );
    await user.type(screen.getByLabelText("Mật khẩu"), "matkhau123");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Thông tin đăng nhập chưa đúng",
    );
    expect(navigationMock.push).not.toHaveBeenCalled();
  });

  it("awaits admin sign-out, blocks repeats, and replaces the protected route", async () => {
    const user = userEvent.setup();
    let completeSignOut: (() => void) | undefined;
    signOutMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeSignOut = resolve;
        }),
    );
    withServices(
      <AdminLayout>
        <p>Nội dung quản trị</p>
      </AdminLayout>,
    );

    const button = screen.getByRole("button", { name: "Đăng xuất" });
    await user.click(button);

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Đang đăng xuất…" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Đang đăng xuất…" }));
    expect(signOutMock).toHaveBeenCalledTimes(1);

    completeSignOut?.();
    await waitFor(() =>
      expect(navigationMock.replace).toHaveBeenCalledWith("/admin/login"),
    );
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

  it("renders lifecycle and OCR metrics from the typed service", async () => {
    withServices(<AdminBooksScreen />);
    await waitFor(() =>
      expect(screen.getByText("Chú Mèo Nhỏ")).toBeInTheDocument(),
    );
    expect(screen.getAllByText("Đang hoạt động").length).toBeGreaterThan(0);
    expect(screen.getByText("Đã ngừng")).toBeInTheDocument();
  });
});
