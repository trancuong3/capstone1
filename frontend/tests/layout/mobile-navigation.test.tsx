import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminLayout } from "@/components/admin/admin-layout";
import { AppShell } from "@/components/layout/app-shell";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import {
  clearUserCache,
  readUserCache,
  writeUserCache,
} from "@/lib/cache/user-query-cache";
import {
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import {
  authSessionFixture,
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";

const navigationState = vi.hoisted(() => ({
  pathname: "/dashboard",
  refresh: vi.fn(),
  replace: vi.fn(),
}));

const profileServiceMock = vi.hoisted(() => ({
  get: vi.fn(),
  getDashboardSummary: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
  useRouter: () => ({
    push: vi.fn(),
    refresh: navigationState.refresh,
    replace: navigationState.replace,
  }),
}));

vi.mock("@/hooks/use-profile-service", () => ({
  useProfileService: () => profileServiceMock,
}));

describe("MobileBottomNav, AppShell and AdminLayout mobile UX", () => {
  beforeEach(() => {
    navigationState.pathname = "/dashboard";
    navigationState.refresh.mockReset();
    navigationState.replace.mockReset();
    profileServiceMock.get.mockReset();
    profileServiceMock.getDashboardSummary.mockReset();
    profileServiceMock.getDashboardSummary.mockResolvedValue({
      profile: {
        id: authSessionFixture.user.id,
        display_name: "Phụ huynh Minh",
        role: "parent",
        created_at: "2026-10-01T00:00:00Z",
        email: "parent@example.com",
        contact_phone: null,
        pending_email: null,
        email_verified: true,
        contact_info_status: "available",
        children: [],
      },
      children: [
        {
          id: "child-1",
          parent_id: authSessionFixture.user.id,
          alias: "Bé An",
          grade: 2,
          settings: {},
          created_at: "2026-10-01T00:00:00Z",
        },
      ],
      latest_sessions_by_child: {},
      source: "dashboard-summary",
    });
    clearUserCache();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    clearUserCache();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("renders 5 primary mobile tabs with >=48dp touch targets and opens the slide-up More sheet", async () => {
    const user = userEvent.setup();
    render(<MobileBottomNav pathname="/dashboard" />);

    const nav = screen.getByRole("navigation", {
      name: "Điều hướng nhanh trên di động",
    });
    const dashboardTab = within(nav).getByRole("link", { name: "Tổng quan" });
    const booksTab = within(nav).getByRole("link", { name: "Sách" });
    const scanTab = within(nav).getByRole("link", { name: "Quét" });
    const reportsTab = within(nav).getByRole("link", { name: "Tiến bộ" });
    const moreButton = within(nav).getByRole("button", { name: "Thêm" });

    expect(dashboardTab).toHaveAttribute("aria-current", "page");
    expect(booksTab).toHaveAttribute("href", "/books");
    expect(scanTab).toHaveAttribute("href", "/book-scanner");
    expect(reportsTab).toHaveAttribute("href", "/reports");
    for (const control of [
      dashboardTab,
      booksTab,
      scanTab,
      reportsTab,
      moreButton,
    ]) {
      expect(control.className).toContain("min-h-12");
    }

    await user.click(moreButton);

    const dialog = screen.getByRole("dialog", { name: "Tính năng khác" });
    expect(dialog.className).toContain("max-h-[85dvh]");
    expect(dialog.className).toContain("max-w-[640px]");
    expect(
      within(dialog).getByRole("navigation", { name: "Tính năng khác" })
        .className,
    ).toContain("overflow-y-auto");
    expect(
      within(dialog).getByRole("link", { name: /Sách của tôi/ }),
    ).toHaveAttribute("href", "/my-books");
    expect(
      within(dialog).getByRole("link", { name: /Quản lý đọc/ }),
    ).toHaveAttribute("href", "/reading-management");
    expect(
      within(dialog).getByRole("link", { name: /Lịch sử/ }),
    ).toHaveAttribute("href", "/sessions");
    expect(
      within(dialog).getByRole("link", { name: /Giải trí/ }),
    ).toHaveAttribute("href", "/entertainment");
    expect(
      within(dialog).getByRole("link", { name: /Từ cần luyện/ }),
    ).toHaveAttribute("href", "/reports/difficult-words");

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Tính năng khác" }),
    ).not.toBeInTheDocument();
  });

  it("collapses AppShell mobile header and bottom nav on viread:immersive-mode and purges user cache on sign-out", async () => {
    const authService = createAuthServiceFixture();
    const user = userEvent.setup();
    writeUserCache(authSessionFixture.user.id, "dashboard-summary", {
      profile: null,
      children: [],
      latest_sessions_by_child: {},
      source: "dashboard-summary",
    });

    render(
      withAuthFixture(
        <AppStoreProvider>
          <AppShell>
            <div>Nội dung chính</div>
          </AppShell>
        </AppStoreProvider>,
        authService,
        { session: authSessionFixture },
      ),
    );

    expect(screen.getByTestId("mobile-bottom-nav")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo").className).toContain("hidden");
    expect(screen.getByRole("contentinfo").className).toContain("lg:block");
    expect(
      screen.getByRole("button", { name: "Mở menu tài khoản" }).className,
    ).toContain("size-12");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("viread:immersive-mode", {
          detail: { active: true },
        }),
      );
    });
    expect(screen.queryByTestId("mobile-bottom-nav")).not.toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("viread:immersive-mode", {
          detail: { active: false },
        }),
      );
    });
    expect(screen.getByTestId("mobile-bottom-nav")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    await user.click(screen.getByRole("menuitem", { name: "Đăng xuất" }));

    await waitFor(() =>
      expect(navigationState.replace).toHaveBeenCalledWith("/login"),
    );
    expect(
      readUserCache(authSessionFixture.user.id, "dashboard-summary"),
    ).toBeNull();
  });

  it("keeps initial AppShell client render identical to SSR when localStorage has cached children (no hydration mismatch)", async () => {
    const authService = createAuthServiceFixture();
    writeUserCache(
      authSessionFixture.user.id,
      "dashboard-summary",
      {
        profile: {
          id: authSessionFixture.user.id,
          display_name: "Phụ huynh Minh",
          role: "parent",
          created_at: "2026-10-01T00:00:00Z",
          email: "parent@example.com",
          contact_phone: null,
          pending_email: null,
          email_verified: true,
          contact_info_status: "available",
          children: [],
        },
        children: [
          {
            id: "child-1",
            parent_id: authSessionFixture.user.id,
            alias: "Bé An",
            grade: 2,
            settings: {},
            created_at: "2026-10-01T00:00:00Z",
          },
        ],
        latest_sessions_by_child: {},
        source: "dashboard-summary",
      },
      { persist: "local" },
    );

    profileServiceMock.getDashboardSummary.mockImplementation(
      () => new Promise(() => {}),
    );

    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const element = withAuthFixture(
      <AppStoreProvider>
        <AppShell>
          <div>Nội dung chính</div>
        </AppShell>
      </AppStoreProvider>,
      authService,
      { initialUserId: authSessionFixture.user.id, session: null },
    );

    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockReturnValue(null);
    const ssrHtml = renderToString(element);
    getItemSpy.mockRestore();

    const container = document.createElement("div");
    container.innerHTML = ssrHtml;
    document.body.appendChild(container);

    const consoleErrors: unknown[][] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => {
        consoleErrors.push(args);
      });

    let root: ReturnType<typeof hydrateRoot> | null = null;
    try {
      await act(async () => {
        root = hydrateRoot(container, element);
      });
      expect(consoleErrors).toEqual([]);
      await waitFor(() =>
        expect(
          within(container).getByRole("button", {
            name: "Bé đang chọn: Bé An, bấm để đổi",
          }),
        ).toBeInTheDocument(),
      );
    } finally {
      errorSpy.mockRestore();
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });

  it("keeps MobileBottomNav and compact mobile topbar visible on /books and /books/[bookId] while hiding desktop footer", () => {
    const authService = createAuthServiceFixture();

    navigationState.pathname = "/books";
    const { rerender } = render(
      withAuthFixture(
        <AppStoreProvider>
          <AppShell>
            <div>Thư viện sách</div>
          </AppShell>
        </AppStoreProvider>,
        authService,
        { session: authSessionFixture },
      ),
    );

    const mobileNav = screen.getByTestId("mobile-bottom-nav");
    expect(mobileNav).toBeInTheDocument();
    expect(
      within(mobileNav).getByRole("link", { name: "Sách" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("banner").className).toContain("xl:hidden");
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();

    navigationState.pathname = "/books/book-42";
    rerender(
      withAuthFixture(
        <AppStoreProvider>
          <AppShell>
            <div>Chi tiết sách</div>
          </AppShell>
        </AppStoreProvider>,
        authService,
        { session: authSessionFixture },
      ),
    );

    const detailMobileNav = screen.getByTestId("mobile-bottom-nav");
    expect(detailMobileNav).toBeInTheDocument();
    expect(
      within(detailMobileNav).getByRole("link", { name: "Sách" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("banner").className).toContain("xl:hidden");
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });

  it("applies 360px child-switcher shrink, safe-area main padding, and tablet footer clearance in AppShell", async () => {
    const authService = createAuthServiceFixture();
    const user = userEvent.setup();

    render(
      withAuthFixture(
        <AppStoreProvider>
          <AppShell>
            <div>Nội dung</div>
          </AppShell>
        </AppStoreProvider>,
        authService,
        { session: authSessionFixture },
      ),
    );

    const banner = screen.getByRole("banner");
    expect(banner.className).toContain("max-xl:z-[45]");
    expect(banner.className).toContain("xl:z-30");

    const switcherBtn = await screen.findByRole("button", {
      name: "Bé đang chọn: Bé An, bấm để đổi",
    });
    expect(switcherBtn.className).toContain("min-w-0");
    expect(switcherBtn.className).toContain("max-w-[min(100%,164px)]");
    expect(switcherBtn.className).not.toContain("max-w-full");

    await user.click(switcherBtn);
    const listbox = screen.getByRole("listbox", {
      name: "Chuyển nhanh hồ sơ bé",
    });
    expect(listbox.className).toContain("max-[640px]:fixed");
    expect(listbox.className).toContain("max-[640px]:inset-x-4");
    expect(listbox.className).toContain("max-[640px]:top-16");
    expect(listbox.className).toContain("max-[640px]:w-auto");
    expect(listbox.className).not.toContain("max-[639px]:");
    expect(listbox.className).toContain("min-[640px]:right-0");
    expect(listbox.className).toContain("min-[640px]:w-60");
    expect(listbox.className).toContain("max-w-[calc(100vw-2rem)]");
    expect(listbox.className).toContain("overflow-y-auto");

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    const accountMenu = screen.getByRole("menu", { name: "Menu tài khoản" });
    expect(accountMenu.className).toContain("max-h-[min(75dvh,32rem)]");
    expect(accountMenu.className).toContain("overflow-y-auto");
    expect(accountMenu.className).toContain("overflow-x-hidden");
    expect(accountMenu.className).toContain("overscroll-contain");

    const main = screen.getByRole("main");
    expect(main.className).toContain(
      "pb-[calc(6rem+env(safe-area-inset-bottom))]",
    );
    expect(main.className).toContain("min-[640px]:px-6");
    expect(main.className).toContain("md:px-8");

    const footer = screen.getByRole("contentinfo");
    expect(footer.className).toContain("hidden");
    expect(footer.className).toContain("lg:block");
    expect(footer.className).toContain(
      "pb-[calc(6rem+env(safe-area-inset-bottom))]",
    );
    expect(footer.className).toContain("xl:pb-0");
  });

  it("renders AdminLayout compact mobile bottom nav and Admin More sheet while hiding footer below lg", async () => {
    navigationState.pathname = "/admin/books";
    const services = createAdminServiceFixture();
    const user = userEvent.setup();

    render(
      withAdminFixture(
        <AdminLayout>
          <div>Admin body</div>
        </AdminLayout>,
        services,
      ),
    );

    const mobileNav = screen.getByRole("navigation", {
      name: "Điều hướng quản trị trên di động",
    });
    expect(
      within(mobileNav).getByRole("link", { name: "Phụ huynh" }),
    ).toHaveAttribute("href", "/admin/parents");
    expect(
      within(mobileNav).getByRole("link", { name: "Kho sách" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(mobileNav).getByRole("link", { name: "Chất lượng" }),
    ).toHaveAttribute("href", "/admin/metadata-quality");
    expect(
      within(mobileNav).getByRole("link", { name: "Bài hát" }),
    ).toHaveAttribute("href", "/admin/karaoke");

    await user.click(within(mobileNav).getByRole("button", { name: "Thêm" }));
    const sheet = screen.getByRole("dialog", { name: "Quản trị khác" });
    expect(
      within(sheet).getByRole("link", { name: /Nhật ký/ }),
    ).toHaveAttribute("href", "/admin/audit-logs");
    expect(within(sheet).getByRole("link", { name: /^OCR/ })).toHaveAttribute(
      "href",
      "/admin/viread-training",
    );
    expect(
      within(sheet).getByRole("link", { name: /Vận hành/ }),
    ).toHaveAttribute("href", "/admin/health");
    expect(screen.getByRole("contentinfo").className).toContain("hidden");
    expect(screen.getByRole("contentinfo").className).toContain("lg:block");
  });
});
