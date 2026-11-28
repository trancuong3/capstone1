import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/components/i18n/i18n-provider";
import { AccountAvatarMenu } from "@/components/layout/account-avatar-menu";
import { LOCALE_COOKIE_NAME } from "@/lib/i18n/locales";

beforeEach(() => {
  document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
  document.documentElement.lang = "vi";
  document.documentElement.dir = "ltr";
});

describe("AccountAvatarMenu", () => {
  it("uses the first display-name initial and exposes account links", async () => {
    const user = userEvent.setup();
    render(
      <AccountAvatarMenu
        displayName="Nguyễn Minh Anh"
        email="parent@example.com"
        isSigningOut={false}
        onSignOut={vi.fn()}
        role="Phụ huynh"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));

    expect(
      screen.getByRole("button", { name: "Mở menu tài khoản" }),
    ).toHaveTextContent("N");
    expect(screen.getByText("Nguyễn Minh Anh")).toBeInTheDocument();
    expect(screen.getByText("parent@example.com")).toBeInTheDocument();
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
  });

  it("falls back to the email initial and closes with Escape while restoring focus", async () => {
    const user = userEvent.setup();
    render(
      <AccountAvatarMenu
        displayName={null}
        email="parent@example.com"
        isSigningOut={false}
        onSignOut={vi.fn()}
        role={null}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Mở menu tài khoản" });
    await user.click(trigger);
    expect(trigger).toHaveTextContent("P");
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("supports arrow, Home and End item navigation", async () => {
    const user = userEvent.setup();
    render(
      <AccountAvatarMenu
        displayName="Parent"
        email="parent@example.com"
        isSigningOut={false}
        onSignOut={vi.fn()}
        role="Phụ huynh"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    const parentProfile = screen.getByRole("menuitem", { name: "Hồ sơ ba mẹ" });
    const childProfile = screen.getByRole("menuitem", { name: "Hồ sơ bé" });
    const logout = screen.getByRole("menuitem", { name: "Đăng xuất" });

    expect(parentProfile).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(childProfile).toHaveFocus();
    await user.keyboard("{Home}");
    expect(parentProfile).toHaveFocus();
    await user.keyboard("{End}");
    expect(logout).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(
      screen.getByRole("menuitem", { name: "Trợ giúp & hỗ trợ" }),
    ).toHaveFocus();
  });

  it("closes when clicking outside and invokes the existing sign-out callback", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(
      <div>
        <AccountAvatarMenu
          displayName="Parent"
          email="parent@example.com"
          isSigningOut={false}
          onSignOut={onSignOut}
          role="Phụ huynh"
        />
        <button type="button">Outside</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    await user.click(screen.getByRole("menuitem", { name: "Đăng xuất" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("opens the inline language sub-view inside the menu, filters and switches locale, and handles layered Escape", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <I18nProvider>
        <div>
          <AccountAvatarMenu
            displayName="Minh Anh"
            email="parent@example.com"
            isSigningOut={false}
            onSignOut={vi.fn()}
            role="Phụ huynh"
          />
          <button type="button">Outside</button>
        </div>
      </I18nProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Mở menu tài khoản" });
    await user.click(trigger);

    const menu = screen.getByRole("menu");
    const langTrigger = within(menu).getByRole("button", {
      name: /Chọn ngôn ngữ giao diện/i,
    });
    expect(langTrigger.closest('[data-variant="menu"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);

    // Drill into inline language sub-view (shell switches role="menu" -> role="dialog")
    await user.click(langTrigger);
    const languageDialog = screen.getByRole("dialog", {
      name: "Chọn ngôn ngữ",
    });
    expect(
      languageDialog.querySelector('[data-language-inline="true"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-language-popover="true"]'),
    ).toBeNull();
    expect(container.querySelector('[data-language-sheet="true"]')).toBeNull();

    const searchInput = within(languageDialog).getByRole("searchbox", {
      name: "Tìm ngôn ngữ",
    });
    expect(searchInput).toHaveFocus();

    // Escape from language sub-view returns to Main View without closing the menu
    await user.keyboard("{Escape}");
    const restoredMenu = screen.getByRole("menu");
    expect(
      restoredMenu.querySelector('[data-language-inline="true"]'),
    ).toBeNull();
    expect(
      within(restoredMenu).getByRole("button", {
        name: /Chọn ngôn ngữ giao diện/i,
      }),
    ).toHaveFocus();

    // Second Escape closes the menu and restores focus to avatar trigger
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    // Reopen, switch locale via search, and verify return to Main View + live announcement
    await user.click(trigger);
    const reopenedMenu = screen.getByRole("menu");
    await user.click(
      within(reopenedMenu).getByRole("button", {
        name: /Chọn ngôn ngữ giao diện/i,
      }),
    );

    const reopenedDialog = screen.getByRole("dialog", {
      name: "Chọn ngôn ngữ",
    });
    const search = within(reopenedDialog).getByRole("searchbox", {
      name: "Tìm ngôn ngữ",
    });
    await user.type(search, "English");
    await user.click(
      within(reopenedDialog).getByRole("option", { name: /English/ }),
    );

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en");
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("English");
    });

    // Outside click while inside language sub-view resets to Main View on reopen
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", {
        name: /Select interface language/i,
      }),
    );
    expect(
      screen
        .getByRole("dialog", { name: "Select language" })
        .querySelector('[data-language-inline="true"]'),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open account menu" }));
    const freshMenu = screen.getByRole("menu");
    expect(freshMenu.querySelector('[data-language-inline="true"]')).toBeNull();
  });
});
