import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/components/i18n/i18n-provider";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { LOCALE_COOKIE_NAME } from "@/lib/i18n/locales";
import {
  getUserLocaleStorageKey,
  readLocaleCookie,
} from "@/lib/i18n/persistence";
import type { MessagesDictionary } from "@/lib/i18n/types";
import { resetLocaleLoaderStateForTests } from "@/messages/loader";
import { viMessages } from "@/messages/vi";

function ConsumerProbe() {
  const { locale, dir, t, setLocale, formatNumber } = useI18n();
  const tCommon = useTranslations("common");
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="dir">{dir}</span>
      <span data-testid="save-label">{t("common.actions.save")}</span>
      <span data-testid="scoped-cancel">{tCommon("actions.cancel")}</span>
      <span data-testid="fallback-check">{t("common.actions.retry")}</span>
      <span data-testid="formatted-num">{formatNumber(1200)}</span>
      <input aria-label="Session note" defaultValue="" />
      <button onClick={() => void setLocale("en")} type="button">
        Switch EN
      </button>
      <button onClick={() => void setLocale("ar")} type="button">
        Switch AR
      </button>
      <button onClick={() => void setLocale("../evil")} type="button">
        Switch Evil
      </button>
    </div>
  );
}

function clearLocaleCookiesAndStorage() {
  document.cookie = `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
  document.documentElement.lang = "vi";
  document.documentElement.dir = "ltr";
}

beforeEach(() => {
  clearLocaleCookiesAndStorage();
  resetLocaleLoaderStateForTests();
});

describe("I18nProvider and useI18n", () => {
  it("works synchronously without I18nProvider using full vi dictionary", () => {
    render(<ConsumerProbe />);
    expect(screen.getByTestId("locale")).toHaveTextContent("vi");
    expect(screen.getByTestId("dir")).toHaveTextContent("ltr");
    expect(screen.getByTestId("save-label")).toHaveTextContent("Lưu");
    expect(screen.getByTestId("scoped-cancel")).toHaveTextContent("Hủy");
  });

  it("lazy-loads locales, caches switches under 50ms, updates lang/dir, and preserves active input without router.refresh", async () => {
    const loadMessages = vi.fn(
      async (locale: string): Promise<MessagesDictionary> => {
        if (locale === "en") {
          return { common: { actions: { save: "Save", cancel: "Cancel" } } };
        }
        if (locale === "ar") {
          return { common: { actions: { save: "حفظ", cancel: "إلغاء" } } };
        }
        return viMessages;
      },
    );

    render(
      <I18nProvider loadMessages={loadMessages}>
        <ConsumerProbe />
      </I18nProvider>,
    );

    const input = screen.getByLabelText("Session note") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Giữ nguyên trạng thái đọc" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch AR" }));
    });

    expect(screen.getByTestId("locale")).toHaveTextContent("ar");
    expect(screen.getByTestId("dir")).toHaveTextContent("rtl");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByTestId("save-label")).toHaveTextContent("حفظ");
    // Missing key in partial bundle falls back cleanly to vi
    expect(screen.getByTestId("fallback-check")).toHaveTextContent("Thử lại");
    // Input state stays untouched (no router.refresh / remount)
    expect(input.value).toBe("Giữ nguyên trạng thái đọc");

    // Rejects invalid locale cleanly
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch Evil" }));
    });
    expect(screen.getByTestId("locale")).toHaveTextContent("ar");

    // Verify fast cached switching via loader cache (< 50ms)
    const { registerLocaleLoader, loadLocaleMessages } =
      await import("@/messages/loader");
    const loaderSpy = vi.fn(async () => ({
      common: { actions: { save: "Save" } },
    }));
    registerLocaleLoader("en", loaderSpy);
    await loadLocaleMessages("en");
    const t0 = performance.now();
    await loadLocaleMessages("en");
    const elapsed = performance.now() - t0;
    expect(loaderSpy).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(50);
  });

  it("isolates preferences per user account and never bleeds Account A into Account B or sign-out", async () => {
    const onPersistUserLocale = vi.fn();

    window.localStorage.setItem(getUserLocaleStorageKey("user-b"), "en");

    const { rerender } = render(
      <I18nProvider onPersistUserLocale={onPersistUserLocale} userId="user-a">
        <ConsumerProbe />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch AR" }));

    await waitFor(() => {
      expect(screen.getByTestId("locale")).toHaveTextContent("ar");
    });
    expect(window.localStorage.getItem(getUserLocaleStorageKey("user-a"))).toBe(
      "ar",
    );
    expect(readLocaleCookie()).toBe("ar");
    expect(onPersistUserLocale).toHaveBeenCalledWith("ar");

    // Switch to Account B -> loads Account B's "en", not Account A's "ar"
    rerender(
      <I18nProvider onPersistUserLocale={onPersistUserLocale} userId="user-b">
        <ConsumerProbe />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("locale")).toHaveTextContent("en");
    });
    expect(document.documentElement.dir).toBe("ltr");

    // Switch to Account C (no saved preference) -> must NOT inherit Account A/B's choice
    rerender(
      <I18nProvider onPersistUserLocale={onPersistUserLocale} userId="user-c">
        <ConsumerProbe />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("locale")).toHaveTextContent("vi");
    });

    // Sign out -> resets away from user-specific locale cleanly
    rerender(
      <I18nProvider onPersistUserLocale={onPersistUserLocale} userId={null}>
        <ConsumerProbe />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("locale")).toHaveTextContent("vi");
    });
  });
});
