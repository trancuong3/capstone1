import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/components/i18n/i18n-provider";
import { AccountSettingsScreen } from "@/components/settings/account-settings-screen";
import { LOCALE_COOKIE_NAME } from "@/lib/i18n/locales";
import type { MessagesDictionary } from "@/lib/i18n/types";
import { viMessages } from "@/messages/vi";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  authSessionFixture,
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";
import type { ParentProfileDTO } from "@/types/profile";

const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  })),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: supabaseMocks,
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const profileFixture: ParentProfileDTO = {
  id: authSessionFixture.user.id,
  display_name: "Ba mẹ Minh Anh",
  role: "parent",
  created_at: "2026-10-01T00:00:00Z",
  email: "parent@example.com",
  contact_phone: null,
  pending_email: null,
  email_verified: true,
  contact_info_status: "available",
  children: [],
};

beforeEach(() => {
  document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
  document.documentElement.lang = "vi";
  document.documentElement.dir = "ltr";
  installApiFetchFixture();
  apiFetchFixture.mockResolvedValue(Response.json(profileFixture));
  supabaseMocks.getSession.mockResolvedValue({
    data: { session: { access_token: "isolated-test-token" } },
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountSettingsScreen", () => {
  it("renders UI language settings card with learning-content disclaimer and switches locale live", async () => {
    const user = userEvent.setup();
    const authService = createAuthServiceFixture();
    authService.getCurrentUser.mockResolvedValue({
      ...authSessionFixture.user,
      providers: ["email"],
    });

    const loadMessages = vi.fn(
      async (locale: string): Promise<MessagesDictionary> => {
        if (locale === "ar") {
          return {
            settings: {
              account: {
                title: "إعدادات الحساب",
              },
              language: {
                heading: "لغة العرض",
              },
            },
            notifications: {
              updates: {
                localeChanged: "تم تحديث لغة العرض إلى {language}.",
              },
            },
          };
        }
        return viMessages;
      },
    );

    render(
      withAuthFixture(
        <I18nProvider loadMessages={loadMessages}>
          <AccountSettingsScreen />
        </I18nProvider>,
        authService,
        { session: authSessionFixture },
      ),
    );

    expect(
      await screen.findByRole("heading", { name: "Cài đặt tài khoản" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Ngôn ngữ hiển thị" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Sách tiếng Việt, OCR/)).toBeInTheDocument();

    const trigger = screen.getByRole("button", {
      name: /Chọn ngôn ngữ giao diện/i,
    });
    expect(trigger.closest('[data-variant="settings"]')).not.toBeNull();

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Chọn ngôn ngữ" });
    await user.click(within(dialog).getByRole("option", { name: /العربية/ }));

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("ar");
      expect(document.documentElement.dir).toBe("rtl");
    });

    expect(
      screen.getByRole("heading", { name: "إعدادات الحساب" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "لغة العرض" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("تم تحديث لغة العرض إلى العربية."),
    ).toBeInTheDocument();
  });

  it("validates and submits password changes in default Vietnamese", async () => {
    const user = userEvent.setup();
    const authService = createAuthServiceFixture();
    authService.getCurrentUser.mockResolvedValue({
      ...authSessionFixture.user,
      providers: ["email"],
    });

    render(
      withAuthFixture(<AccountSettingsScreen />, authService, {
        session: authSessionFixture,
      }),
    );

    await user.click(
      await screen.findByRole("button", { name: "Đổi mật khẩu" }),
    );
    await user.click(screen.getByRole("button", { name: "Lưu mật khẩu mới" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Ba mẹ vui lòng nhập mật khẩu hiện tại.",
    );

    await user.type(screen.getByLabelText("Mật khẩu hiện tại"), "oldpass123");
    await user.type(screen.getByLabelText("Mật khẩu mới"), "newpass123");
    await user.type(
      screen.getByLabelText("Xác nhận mật khẩu mới"),
      "newpass123",
    );
    await user.click(screen.getByRole("button", { name: "Lưu mật khẩu mới" }));

    await waitFor(() => {
      expect(authService.changePassword).toHaveBeenCalledWith({
        currentPassword: "oldpass123",
        newPassword: "newpass123",
      });
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Mật khẩu đã được cập nhật",
    );
  });

  it("consolidates password action and email verification inside the account info card with no orphan floating button", async () => {
    const authService = createAuthServiceFixture();
    authService.getCurrentUser.mockResolvedValue({
      ...authSessionFixture.user,
      providers: ["email"],
    });

    const { container } = render(
      withAuthFixture(<AccountSettingsScreen />, authService, {
        session: authSessionFixture,
      }),
    );

    const accountHeading = await screen.findByRole("heading", {
      level: 2,
      name: "Thông tin tài khoản",
    });
    const accountCard = accountHeading.closest(".rounded-card");
    expect(accountCard).not.toBeNull();

    // No orphan floating button directly under the root settings section
    const rootSection = container.querySelector("section.settings-sheet");
    expect(rootSection).not.toBeNull();
    const directChildButtons = Array.from(rootSection?.children ?? []).filter(
      (child) => child.tagName === "BUTTON",
    );
    expect(directChildButtons).toHaveLength(0);

    // Change password button and verification link live cleanly inside the account info card
    expect(
      within(accountCard as HTMLElement).getByRole("button", {
        name: "Đổi mật khẩu",
      }),
    ).toBeInTheDocument();
    expect(
      within(accountCard as HTMLElement).getByRole("link", {
        name: /Quản lý hồ sơ/,
      }),
    ).toHaveAttribute("href", "/profile");
    expect(
      within(accountCard as HTMLElement).getByRole("link", {
        name: "Mở hồ sơ phụ huynh",
      }),
    ).toHaveAttribute("href", "/profile");

    // No duplicate standalone Email & Verification h2 card
    expect(
      screen.queryByRole("heading", {
        level: 2,
        name: "Email và xác minh",
      }),
    ).not.toBeInTheDocument();
  });
});
