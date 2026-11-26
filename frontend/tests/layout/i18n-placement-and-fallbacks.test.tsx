import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NotFoundFallback,
  RouteErrorFallback,
} from "@/components/common/route-fallback";
import {
  I18nProvider,
  VIREAD_AUTH_SYNC_EVENT,
} from "@/components/i18n/i18n-provider";
import { AccountAvatarMenu } from "@/components/layout/account-avatar-menu";
import { AppShell } from "@/components/layout/app-shell";
import { SiteHeader } from "@/components/layout/site-header";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import { LOCALE_COOKIE_NAME } from "@/lib/i18n/locales";
import type { MessagesDictionary } from "@/lib/i18n/types";
import { viMessages } from "@/messages/vi";
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

const englishTestMessages: MessagesDictionary = {
  auth: {
    login: {
      submit: "Sign in",
      logoAria: "ViRead - sign in",
    },
    register: {
      submit: "Sign up",
    },
    adminLogin: {
      badge: "ADMIN",
      areaLabel: "Admin workspace",
      logoAria: "ViRead - admin sign in",
    },
  },
  common: {
    actions: {
      retry: "Try again",
    },
    notFound: {
      title: "Page not found",
      description: "The requested page does not exist.",
      backHome: "Back to dashboard",
      backLogin: "Back to sign in",
    },
    errorPage: {
      title: "Something went wrong",
      description: "An unexpected error occurred.",
      backHome: "Back to dashboard",
    },
  },
};

beforeEach(() => {
  document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
  document.documentElement.lang = "vi";
  document.documentElement.dir = "ltr";
  navigationState.pathname = "/dashboard";
  navigationState.refresh.mockReset();
  navigationState.replace.mockReset();
  profileServiceMock.get.mockResolvedValue(null);
  profileServiceMock.getDashboardSummary.mockResolvedValue({
    profile: {
      id: authSessionFixture.user.id,
      display_name: "Ba mẹ Minh",
      role: "parent",
      created_at: "2026-10-01T00:00:00Z",
      email: "parent@example.com",
      contact_phone: null,
      pending_email: null,
      email_verified: true,
      contact_info_status: "available",
      children: [],
    },
    children: [],
    latest_sessions_by_child: {},
    source: "dashboard-summary",
  });
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe("SiteHeader, AppShell, AccountAvatarMenu and fallbacks i18n", () => {
  it("renders a single compact LanguageSelector on SiteHeader for both auth and admin-login variants", async () => {
    const user = userEvent.setup();
    const loadMessages = vi.fn(async () => englishTestMessages);

    const { rerender } = render(
      <I18nProvider loadMessages={loadMessages}>
        <SiteHeader variant="auth" />
      </I18nProvider>,
    );

    const triggers = screen.getAllByRole("button", {
      name: /Chọn ngôn ngữ giao diện/i,
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].closest('[data-variant="compact"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "Đăng nhập" })).toBeInTheDocument();

    await user.click(triggers[0]);
    await user.click(screen.getByRole("option", { name: /English/ }));
    expect(
      await screen.findByRole("link", { name: "Sign in" }),
    ).toBeInTheDocument();

    rerender(
      <I18nProvider loadMessages={loadMessages}>
        <SiteHeader variant="admin-login" />
      </I18nProvider>,
    );

    expect(
      screen.getAllByRole("button", { name: /language|ngôn ngữ/i }),
    ).toHaveLength(1);
    expect(screen.getByText("ADMIN")).toBeInTheDocument();
  });

  it("exposes LanguageSelector in AppShell desktop header and account menu, and dispatches auth sync on sign-out", async () => {
    const user = userEvent.setup();
    const authService = createAuthServiceFixture();
    const syncSpy = vi.fn();
    window.addEventListener(VIREAD_AUTH_SYNC_EVENT, syncSpy);

    try {
      render(
        withAuthFixture(
          <I18nProvider>
            <AppStoreProvider>
              <AppShell>
                <div>Body</div>
              </AppShell>
            </AppStoreProvider>
          </I18nProvider>,
          authService,
          { session: authSessionFixture },
        ),
      );

      // Desktop header selector is present in the DOM (not inside #parent-account-menu)
      const headerTrigger = screen.getByRole("button", {
        name: /Chọn ngôn ngữ giao diện/i,
      });
      expect(headerTrigger.closest('[data-variant="compact"]')).not.toBeNull();

      await user.click(
        screen.getByRole("button", { name: "Mở menu tài khoản" }),
      );
      const menu = screen.getByRole("menu", { name: "Menu tài khoản" });
      const menuSelectorButton = within(menu).getByRole("button", {
        name: /Chọn ngôn ngữ giao diện/i,
      });
      expect(
        menuSelectorButton.closest('[data-variant="menu"]'),
      ).not.toBeNull();

      await user.click(
        within(menu).getByRole("menuitem", { name: "Đăng xuất" }),
      );
      await waitFor(() => {
        expect(syncSpy).toHaveBeenCalledTimes(1);
      });
      const eventDetail = (syncSpy.mock.calls[0]?.[0] as CustomEvent).detail;
      expect(eventDetail).toEqual({ userId: null, preferredLocale: null });
    } finally {
      window.removeEventListener(VIREAD_AUTH_SYNC_EVENT, syncSpy);
    }
  });

  it("includes LanguageSelector in AccountAvatarMenu without breaking menuitem keyboard order", async () => {
    const user = userEvent.setup();
    render(
      <AccountAvatarMenu
        displayName="Minh Anh"
        email="parent@example.com"
        isSigningOut={false}
        onSignOut={vi.fn()}
        role="Phụ huynh"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getByRole("button", { name: /Chọn ngôn ngữ giao diện/i })
        .closest('[data-variant="menu"]'),
    ).not.toBeNull();

    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Đăng xuất" })).toHaveFocus();
  });

  it("renders localized NotFoundFallback and RouteErrorFallback in vi and switched locales", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <NotFoundFallback />
        <RouteErrorFallback onRetry={onRetry} />
      </I18nProvider>,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Không tìm thấy trang" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Đã có sự cố xảy ra")).toBeInTheDocument();

    rerender(
      <I18nProvider
        initialLocale="en"
        initialMessages={englishTestMessages}
        key="en"
      >
        <NotFoundFallback />
        <RouteErrorFallback onRetry={onRetry} />
      </I18nProvider>,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });
});
