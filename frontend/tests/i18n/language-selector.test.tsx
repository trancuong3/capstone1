import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/components/i18n/i18n-provider";
import { LanguageSelector } from "@/components/i18n/language-selector";
import { LOCALE_COOKIE_NAME } from "@/lib/i18n/locales";

function mockMatchMedia(matchesMobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("639px") ? matchesMobile : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
  document.documentElement.lang = "vi";
  document.documentElement.dir = "ltr";
  mockMatchMedia(false);
});

describe("LanguageSelector", () => {
  it("renders variants with globe icon, native name, and no country flags", () => {
    const { container } = render(
      <I18nProvider>
        <LanguageSelector variant="header" />
        <LanguageSelector variant="compact" />
        <LanguageSelector variant="menu" />
        <LanguageSelector variant="settings" />
      </I18nProvider>,
    );

    const buttons = screen.getAllByRole("button", {
      name: /Chọn ngôn ngữ giao diện/i,
    });
    expect(buttons).toHaveLength(4);
    expect(buttons[0]).toHaveTextContent("Tiếng Việt");
    expect(container.textContent).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);
  });

  it("opens desktop popover, filters by nativeName/englishName/code, and supports full keyboard navigation", async () => {
    const user = userEvent.setup();

    render(
      <I18nProvider>
        <LanguageSelector variant="header" />
      </I18nProvider>,
    );

    const trigger = screen.getByRole("button", {
      name: /Chọn ngôn ngữ giao diện/i,
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.click(trigger);

    const popover = screen.getByRole("dialog", { name: "Chọn ngôn ngữ" });
    expect(popover).toBeInTheDocument();
    expect(within(popover).getByText("Ngôn ngữ phổ biến")).toBeInTheDocument();
    expect(within(popover).getByText("Tất cả ngôn ngữ")).toBeInTheDocument();

    const searchInput = within(popover).getByRole("searchbox", {
      name: "Tìm ngôn ngữ",
    });
    await waitFor(() => expect(searchInput).toHaveFocus());

    // Keyboard navigation from search input -> options -> Escape
    await user.keyboard("{ArrowDown}");
    const options = within(popover).getAllByRole("option");
    expect(options[0]).toHaveFocus();

    await user.keyboard("{End}");
    expect(options[options.length - 1]).toHaveFocus();

    await user.keyboard("{Home}");
    expect(options[0]).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Chọn ngôn ngữ" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    // Reopen and search by englishName / nativeName / code
    await user.click(trigger);
    const reopened = screen.getByRole("dialog", { name: "Chọn ngôn ngữ" });
    const search = within(reopened).getByRole("searchbox", {
      name: "Tìm ngôn ngữ",
    });

    await user.type(search, "Japanese");
    expect(
      within(reopened).getByRole("option", { name: /日本語/ }),
    ).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zh-Hant");
    expect(
      within(reopened).getByRole("option", { name: /繁體中文/ }),
    ).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "Nepali");
    expect(
      within(reopened).queryByRole("option", { name: /नेपाली/ }),
    ).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "Arabic");
    await user.click(within(reopened).getByRole("option", { name: /العربية/ }));

    await waitFor(
      () => {
        expect(document.documentElement.lang).toBe("ar");
        expect(document.documentElement.dir).toBe("rtl");
        expect(trigger).toHaveTextContent("العربية");
        expect(screen.getByRole("status")).toHaveTextContent("العربية");
      },
      { timeout: 5000 },
    );
  });

  it("renders mobile bottom sheet under 640px and dismisses on Android Back popstate", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();

    const { container } = render(
      <I18nProvider>
        <LanguageSelector variant="compact" />
      </I18nProvider>,
    );

    const trigger = screen.getByRole("button", {
      name: /Chọn ngôn ngữ giao diện/i,
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.click(trigger);

    const sheet = container.querySelector('[data-language-sheet="true"]');
    expect(sheet).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "Chọn ngôn ngữ" });
    expect(dialog.className).toContain("pb-[env(safe-area-inset-bottom)]");

    act(() => {
      fireEvent(window, new PopStateEvent("popstate"));
    });

    expect(
      container.querySelector('[data-language-sheet="true"]'),
    ).not.toBeInTheDocument();
  });
});
