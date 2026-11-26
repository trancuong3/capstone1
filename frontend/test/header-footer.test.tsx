import { fireEvent, render, screen, within } from "@testing-library/react";
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
const { getProfileMock, profileServiceMock } = vi.hoisted(() => {
  const getProfileMock = vi.fn();
  return { getProfileMock, profileServiceMock: { get: getProfileMock } };
});

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({
    refresh: navigationMock.refresh,
    replace: navigationMock.replace,
  }),
}));
vi.mock("@/hooks/use-profile-service", () => ({
  useProfileService: () => profileServiceMock,
}));

beforeEach(() => {
  navigationMock.pathname = "/dashboard";
  navigationMock.refresh.mockClear();
  navigationMock.replace.mockClear();
  getProfileMock.mockResolvedValue(null);
});

describe("shared header and footer", () => {
  it("renders the public navigation and footer around auth content", () => {
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
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
    expect(
      screen.queryByRole("navigation", { name: "Điều hướng tài khoản" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "ViRead - đăng nhập" }),
    ).toHaveAttribute("href", "/login");
  });

  it("retains one public footer while auth content loads", () => {
    render(<AuthLoadingState />);
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
  });

  it.each([
    ["/dashboard", "Tổng quan"],
    ["/reports", "Tiến bộ"],
    ["/sessions", "Lịch sử"],
    ["/entertainment/sentence-shooter", "Giải trí"],
    ["/entertainment/picture-description", "Giải trí"],
    ["/reports/difficult-words", "Từ cần luyện"],
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
    expect(footer).toHaveTextContent("vireadforyou@gmail.com");
    expect(footer).toHaveTextContent("0905373633");
    expect(
      within(footer).getByRole("link", { name: "vireadforyou@gmail.com" }),
    ).toHaveAttribute("href", "mailto:vireadforyou@gmail.com");
    expect(
      within(footer).getByRole("link", { name: "0905373633" }),
    ).toHaveAttribute("href", "tel:0905373633");
    expect(
      within(footer).getByRole("link", { name: "Tổng quan" }),
    ).toHaveAttribute("href", "/dashboard");
    expect(
      within(footer).getByRole("link", { name: "Tiến bộ" }),
    ).toHaveAttribute("href", "/reports");
    expect(
      within(footer).getByRole("link", { name: "Lịch sử đọc" }),
    ).toHaveAttribute("href", "/sessions");
    expect(
      within(footer).getByRole("link", { name: "Hồ sơ bé" }),
    ).toHaveAttribute("href", "/children");
    expect(
      within(footer).getByRole("link", { name: "Hồ sơ phụ huynh" }),
    ).toHaveAttribute("href", "/profile");
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
    expect(
      within(
        screen.getByRole("navigation", { name: "Điều hướng dành cho ba mẹ" }),
      ).getByRole("link", {
        name: label,
      }),
    ).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Hồ sơ ba mẹ" }),
    ).toHaveAttribute("href", "/profile");
    expect(screen.getByRole("menuitem", { name: "Hồ sơ bé" })).toHaveAttribute(
      "href",
      "/children",
    );
    expect(screen.getByRole("menuitem", { name: "Cài đặt" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(
      screen.getByRole("menuitem", { name: "Trợ giúp & hỗ trợ" }),
    ).toHaveAttribute("href", "/help-support");
    expect(
      screen.getByRole("menuitem", { name: "Đăng xuất" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["/children", "Hồ sơ bé"],
    ["/profile", "Hồ sơ ba mẹ"],
  ])("highlights %s in the avatar menu", (pathname, label) => {
    navigationMock.pathname = pathname;
    render(
      withAuthFixture(
        <AppShell>
          <h1>Nội dung phụ huynh</h1>
        </AppShell>,
        createAuthServiceFixture(),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute(
      "aria-current",
      "page",
    );
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
      within(
        screen.getByRole("navigation", { name: "Điều hướng dành cho ba mẹ" }),
      ).queryByRole("link", { name: "Tổng quan" }),
    ).not.toBeInTheDocument();
  });

  it("keeps one immersive landmark without duplicate parent navigation on /reading/session-1", () => {
    navigationMock.pathname = "/reading/session-1";
    const { container } = render(
      withAuthFixture(
        <AppShell>
          <h1>Không gian đọc</h1>
        </AppShell>,
        createAuthServiceFixture(),
      ),
    );
    expect(container.querySelector("header")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Điều hướng dành cho ba mẹ" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("main")).toHaveTextContent("Không gian đọc");
  });

  it.each(["/books", "/books/book-1"])(
    "keeps compact mobile shell without desktop header or footer on %s",
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
      const header = container.querySelector("header");
      expect(header).not.toBeNull();
      expect(header?.className).toContain("xl:hidden");
      expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
      expect(screen.getAllByRole("main")).toHaveLength(1);
      expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
      expect(screen.getByRole("main")).toHaveTextContent("Không gian đọc");
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
    expect(screen.getByRole("contentinfo")).not.toHaveTextContent(
      "vireadforyou@gmail.com",
    );
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
    expect(screen.getByRole("contentinfo")).not.toHaveTextContent(
      "vireadforyou@gmail.com",
    );
  });
});
