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
  it("places the public header and footer around auth content", () => {
    render(
      <AuthShell>
        <h1>Trang tài khoản</h1>
      </AuthShell>,
    );
    const main = screen.getByRole("main");
    expect(main.parentElement?.firstElementChild).toBe(
      screen.getByRole("banner"),
    );
    expect(main.parentElement?.lastElementChild).toBe(
      screen.getByRole("contentinfo"),
    );
    expect(
      within(
        screen.getByRole("navigation", { name: "Điều hướng tài khoản" }),
      ).getByRole("link", {
        name: "Đăng ký",
      }),
    ).toHaveAttribute("href", "/register");
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      "Đồng hành cùng bé trên hành trình đọc sách.",
    );
  });

  it("keeps the same landmarks while auth content loads", () => {
    render(<AuthLoadingState />);
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
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
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      "Đồng hành cùng bé trên hành trình đọc sách.",
    );
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

  it("keeps child onboarding minimal with a public footer", () => {
    navigationMock.pathname = "/children/new";
    render(
      withAuthFixture(
        <AppShell>
          <h1>Tạo hồ sơ bé</h1>
        </AppShell>,
        createAuthServiceFixture(),
      ),
    );
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Đăng xuất" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Tổng quan" }),
    ).not.toBeInTheDocument();
  });

  it.each(["/books", "/books/book-1", "/reading/session-1"])(
    "leaves the immersive layout unchanged on %s",
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
      expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
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
        name: "ReadAlong Vision - đăng nhập quản trị",
      }),
    ).toHaveAttribute("href", "/admin/login");
    expect(
      screen.queryByRole("link", { name: "Đăng ký" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      "Khu vực quản trị ReadAlong Vision.",
    );
  });

  it("keeps protected Admin navigation and its footer", () => {
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
      "Khu vực quản trị ReadAlong Vision.",
    );
  });
});
