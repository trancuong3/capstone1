import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminLayout } from "@/components/admin/admin-layout";
import { AdminLoginScreen } from "@/components/admin/admin-login-screen";
import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { AppShell } from "@/components/layout/app-shell";
import {
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import {
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";

const { navigationMock } = vi.hoisted(() => ({
  navigationMock: {
    pathname: "/dashboard",
    refresh: vi.fn(),
    replace: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({
    refresh: navigationMock.refresh,
    replace: navigationMock.replace,
  }),
}));

beforeEach(() => {
  navigationMock.pathname = "/dashboard";
  navigationMock.refresh.mockClear();
  navigationMock.replace.mockClear();
});

describe("shared header and footer", () => {
  it("renders the ViRead public header without a footer on auth pages", () => {
    render(
      <AuthShell>
        <h1>Trang tài khoản</h1>
      </AuthShell>,
    );
    const main = screen.getByRole("main");
    expect(main.parentElement?.firstElementChild).toBe(
      screen.getByRole("banner"),
    );
    expect(main.parentElement?.lastElementChild).toBe(main);
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole("navigation", { name: "Điều hướng tài khoản" }),
      ).getByRole("link", {
        name: "Đăng ký",
      }),
    ).toHaveAttribute("href", "/register");
    expect(
      screen.getByRole("link", { name: "ViRead - đăng nhập" }),
    ).toHaveAttribute("href", "/login");
  });

  it("does not render a footer while auth content loads", () => {
    render(<AuthLoadingState />);
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });

  it.each([
    ["/dashboard", "Tổng quan"],
    ["/reports", "Tiến bộ"],
    ["/sessions", "Lịch sử"],
    ["/reports/difficult-words", "Từ cần luyện"],
    ["/children", "Hồ sơ bé"],
    ["/profile", "Ba mẹ"],
  ])("keeps Parent navigation active on %s", (pathname, label) => {
    navigationMock.pathname = pathname;
    render(
      withAuthFixture(
        <AppShell>
          <h1>Nội dung phụ huynh</h1>
        </AppShell>,
        createAuthServiceFixture(),
      ),
    );
    expect(screen.getByRole("main")).toHaveTextContent("Nội dung phụ huynh");
    const footer = screen.getByRole("contentinfo");
    expect(footer).toHaveTextContent("ViRead");
    expect(footer).toHaveTextContent("Đại học Duy Tân");
    expect(footer).toHaveTextContent("viread@gmail.com");
    expect(footer).toHaveTextContent("0905373633");
    expect(within(footer).getByRole("link", { name: "viread@gmail.com" }))
      .toHaveAttribute("href", "mailto:viread@gmail.com");
    expect(within(footer).getByRole("link", { name: "0905373633" }))
      .toHaveAttribute("href", "tel:0905373633");
    expect(within(footer).getByRole("link", { name: "Tổng quan" }))
      .toHaveAttribute("href", "/dashboard");
    expect(within(footer).getByRole("link", { name: "Tiến bộ" }))
      .toHaveAttribute("href", "/reports");
    expect(within(footer).getByRole("link", { name: "Lịch sử đọc" }))
      .toHaveAttribute("href", "/sessions");
    expect(within(footer).getByRole("link", { name: "Hồ sơ bé" }))
      .toHaveAttribute("href", "/children");
    expect(within(footer).getByRole("link", { name: "Hồ sơ phụ huynh" }))
      .toHaveAttribute("href", "/profile");
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
    expect(
      within(
        screen.getByRole("navigation", { name: "Điều hướng dành cho ba mẹ" }),
      ).getByRole("link", {
        name: label,
      }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: "Đăng xuất" }),
    ).toBeInTheDocument();
  });

  it("keeps child onboarding minimal while using the Parent footer", () => {
    navigationMock.pathname = "/children/new";
    render(
      withAuthFixture(
        <AppShell>
          <h1>Tạo hồ sơ bé</h1>
        </AppShell>,
        createAuthServiceFixture(),
      ),
    );
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      "© 2026 ViRead. Bảo lưu mọi quyền.",
    );
    expect(
      screen.queryByRole("button", { name: "Đăng xuất" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Tổng quan", hidden: true }),
    ).not.toBeInTheDocument();
  });

  it.each(["/books", "/books/book-1", "/reading/session-1"])(
    "keeps the immersive header hidden and moves the Parent footer after the content on %s",
    (pathname) => {
      navigationMock.pathname = pathname;
      const { container } = render(
        withAuthFixture(
          <AppShell>
            <h1>Không gian đọc</h1>
          </AppShell>,
          createAuthServiceFixture(),
        ),
      );
      expect(container.querySelector("header")).toHaveClass("hidden");
      expect(screen.getByRole("main")).toHaveTextContent("Không gian đọc");
      expect(screen.getByRole("contentinfo")).toBeInTheDocument();
      expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
      expect(container.querySelector("main")?.nextElementSibling).toBe(
        screen.getByRole("contentinfo"),
      );
    },
  );

  it("shows the admin login frame without public account navigation", () => {
    navigationMock.pathname = "/admin/login";
    render(
      withAdminFixture(
        <AdminLoginScreen scenario="default" />,
        createAdminServiceFixture(),
      ),
    );
    expect(screen.getByRole("main")).toHaveTextContent("Đăng nhập quản trị");
    expect(
      screen.getByRole("link", {
        name: "ViRead - đăng nhập quản trị",
      }),
    ).toHaveAttribute("href", "/admin/login");
    expect(
      screen.queryByRole("link", { name: "Đăng ký" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      "Khu vực quản trị ViRead.",
    );
    expect(
      screen.queryByRole("contentinfo"),
    ).not.toHaveTextContent("viread@gmail.com");
  });

  it("keeps protected Admin navigation and its compact footer", () => {
    navigationMock.pathname = "/admin/books";
    render(
      withAdminFixture(
        <AdminLayout>
          <h1>Kho sách</h1>
        </AdminLayout>,
        createAdminServiceFixture(),
      ),
    );
    expect(screen.getByRole("main")).toHaveTextContent("Kho sách");
    expect(
      within(
        screen.getByRole("navigation", { name: "Điều hướng quản trị" }),
      ).getByRole("link", {
        name: "Kho sách",
      }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: "Đăng xuất" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      "Khu vực quản trị ViRead.",
    );
    expect(
      screen.queryByRole("contentinfo"),
    ).not.toHaveTextContent("viread@gmail.com");
  });
});
