import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  LOCALE_REGISTRY,
  SUPPORTED_LOCALE_CODES,
  getLocaleDirection,
  getLocaleMetadata,
  getPopularLocales,
  getPublishedLocales,
  isLocalePublished,
  normalizeLocale,
  resolveLocalePriority,
} from "@/lib/i18n/locales";

describe("i18n locales registry and normalization", () => {
  it("defines the 30 required locales with Vietnamese as complete and published default", () => {
    expect(DEFAULT_LOCALE).toBe("vi");
    expect(LOCALE_COOKIE_NAME).toBe("viread_locale");
    expect(SUPPORTED_LOCALE_CODES).toHaveLength(30);
    expect(LOCALE_REGISTRY).toHaveLength(30);

    const viMeta = getLocaleMetadata("vi");
    expect(viMeta.status).toBe("complete");
    expect(viMeta.published).toBe(true);
    expect(viMeta.dir).toBe("ltr");

    expect(getPublishedLocales().map((entry) => entry.code)).toEqual([
      "vi",
      "en",
      "zh-Hans",
      "zh-Hant",
      "ja",
      "ko",
      "fr",
      "de",
      "es",
      "ar",
      "he",
    ]);
    expect(isLocalePublished("vi")).toBe(true);
    expect(isLocalePublished("en")).toBe(true);
    expect(isLocalePublished("ar")).toBe(true);
    expect(isLocalePublished("ne")).toBe(false);

    expect(getLocaleDirection("ar")).toBe("rtl");
    expect(getLocaleDirection("he")).toBe("rtl");
    expect(getLocaleDirection("ja")).toBe("ltr");
    expect(getPopularLocales().length).toBeGreaterThanOrEqual(8);
  });

  it("normalizes case, underscores, regional variants, and legacy codes", () => {
    expect(normalizeLocale("vi")).toBe("vi");
    expect(normalizeLocale("VI-VN")).toBe("vi");
    expect(normalizeLocale("en_US")).toBe("en");
    expect(normalizeLocale("zh-CN")).toBe("zh-Hans");
    expect(normalizeLocale("zh_sg")).toBe("zh-Hans");
    expect(normalizeLocale("zh-TW")).toBe("zh-Hant");
    expect(normalizeLocale("zh-HK")).toBe("zh-Hant");
    expect(normalizeLocale("he-IL")).toBe("he");
    expect(normalizeLocale("iw-IL")).toBe("he");
    expect(normalizeLocale("in-ID")).toBe("id");
    expect(normalizeLocale("tl-PH")).toBe("fil");
    expect(normalizeLocale("  ar-SA  ")).toBe("ar");
  });

  it("rejects traversal, XSS payloads, control characters, and unsupported tags", () => {
    const maliciousOrInvalid: unknown[] = [
      "",
      "   ",
      null,
      undefined,
      123,
      {},
      "../vi",
      "../../etc/passwd",
      "vi/../../en",
      "<script>alert(1)</script>",
      "en;alert(1)",
      "vi\0en",
      "english",
      "xx",
      "zz-ZZ",
      "zh", // wait: zh maps to zh-Hans; verify zh-XX is rejected
      "zh-XX",
    ];

    for (const candidate of maliciousOrInvalid) {
      if (candidate === "zh") {
        expect(normalizeLocale(candidate)).toBe("zh-Hans");
      } else {
        expect(normalizeLocale(candidate)).toBeNull();
      }
    }
  });

  it("resolves priority strictly without consulting navigator.language", () => {
    const navigatorLanguageSpy = Object.getOwnPropertyDescriptor(
      window.navigator,
      "language",
    );
    Object.defineProperty(window.navigator, "language", {
      configurable: true,
      get: () => "fr-FR",
    });

    try {
      expect(resolveLocalePriority({})).toBe("vi");

      expect(
        resolveLocalePriority({
          explicitLocale: "ja",
          accountLocale: "en",
          accountUserId: "user-a",
          activeUserId: "user-a",
          deviceLocale: "ar",
        }),
      ).toBe("ja");

      expect(
        resolveLocalePriority({
          accountLocale: "en",
          accountUserId: "user-a",
          activeUserId: "user-a",
          deviceLocale: "ar",
        }),
      ).toBe("en");

      // Account A's preference must NOT apply when activeUserId is Account B or signed-out
      expect(
        resolveLocalePriority({
          accountLocale: "en",
          accountUserId: "user-a",
          activeUserId: "user-b",
          deviceLocale: "ar",
        }),
      ).toBe("ar");

      expect(
        resolveLocalePriority({
          accountLocale: "en",
          accountUserId: "user-a",
          activeUserId: null,
        }),
      ).toBe("vi");
    } finally {
      if (navigatorLanguageSpy) {
        Object.defineProperty(
          window.navigator,
          "language",
          navigatorLanguageSpy,
        );
      }
    }
  });
});
