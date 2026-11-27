import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  escapePlainTextForHtml,
  formatDate,
  formatDateTime,
  formatDuration,
  formatList,
  formatMessage,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
  translateMessage,
} from "@/lib/i18n/formatter";
import { viMessages } from "@/messages/vi";

describe("i18n formatter and Intl helpers", () => {
  it("interpolates placeholders and prevents prototype property access", () => {
    expect(formatMessage("Xin chào {name}!", { name: "Bé An" }, "vi")).toBe(
      "Xin chào Bé An!",
    );
    expect(formatMessage("Xin chào {missing}!", {}, "vi")).toBe(
      "Xin chào {missing}!",
    );
    expect(
      formatMessage("Test {constructor} {__proto__}", { name: "ok" }, "vi"),
    ).toBe("Test {constructor} {__proto__}");
  });

  it("handles ICU-subset pluralization across vi, en, ja, ar", () => {
    const enTemplate =
      "{count, plural, =0 {No books} one {# book} other {# books}}";
    expect(formatMessage(enTemplate, { count: 0 }, "en")).toBe("No books");
    expect(formatMessage(enTemplate, { count: 1 }, "en")).toBe("1 book");
    expect(formatMessage(enTemplate, { count: 5 }, "en")).toBe("5 books");

    const viTemplate = "{count, plural, =0 {Không có mục nào} other {# mục}}";
    expect(formatMessage(viTemplate, { count: 0 }, "vi")).toBe(
      "Không có mục nào",
    );
    expect(formatMessage(viTemplate, { count: 12 }, "vi")).toBe("12 mục");

    const arTemplate =
      "{count, plural, zero {لا كتب} one {كتاب واحد} two {كتابان} few {# كتب} many {# كتابا} other {# كتاب}}";
    expect(formatMessage(arTemplate, { count: 2 }, "ar")).toBe("كتابان");
    expect(formatMessage(arTemplate, { count: 3 }, "ar")).toBe(
      `${formatNumber(3, "ar")} كتب`,
    );
    expect(formatMessage(arTemplate, { count: 15 }, "ar")).toBe(
      `${formatNumber(15, "ar")} كتابا`,
    );

    const jaTemplate = "{count, plural, other {#冊}}";
    expect(formatMessage(jaTemplate, { count: 4 }, "ja")).toBe("4冊");
  });

  it("falls back safely to vi dictionary when key or locale bundle is missing", () => {
    expect(
      translateMessage(
        { common: { actions: { save: "Save" } } },
        viMessages,
        "en",
        "common.actions.cancel",
      ),
    ).toBe("Hủy");

    expect(
      translateMessage(undefined, viMessages, "en", "common.brand.name"),
    ).toBe("ViRead");

    expect(
      translateMessage(undefined, viMessages, "vi", "non.existent.key"),
    ).toBe("non.existent.key");
  });

  it("treats XSS payloads in parameters as safe plain text and escapes them in React DOM", () => {
    const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const text = translateMessage(
      viMessages,
      viMessages,
      "vi",
      "child.switcher.selectedAria",
      { alias: payload },
    );

    expect(text).toContain(payload);
    expect(escapePlainTextForHtml(payload)).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;",
    );

    const { container } = render(<p data-testid="safe">{text}</p>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });

  it("formats dates, times, numbers, percents, durations, relative times, and lists honoring locale and timezone", () => {
    const sampleDate = new Date("2026-05-15T14:30:00.000Z");

    const hcmTime = formatTime(sampleDate, "en", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour12: false,
    });
    const utcTime = formatTime(sampleDate, "en", {
      timeZone: "UTC",
      hour12: false,
    });
    expect(hcmTime).toContain("21:30");
    expect(utcTime).toContain("14:30");

    expect(formatDate(sampleDate, "ja", { timeZone: "Asia/Tokyo" })).toContain(
      "2026",
    );
    expect(
      formatDateTime(sampleDate, "vi", { timeZone: "Asia/Ho_Chi_Minh" }),
    ).toContain("2026");

    const styledDateTime = formatDateTime("2026-11-27T17:09:49.254Z", "vi", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Asia/Ho_Chi_Minh",
    });
    expect(styledDateTime).not.toContain("T17:09");
    expect(styledDateTime).not.toMatch(/Z$/);
    expect(styledDateTime).toContain("00:09");

    const styledDate = formatDate(sampleDate, "vi", {
      dateStyle: "medium",
      timeZone: "Asia/Ho_Chi_Minh",
    });
    expect(styledDate).not.toContain("T14:30");
    expect(styledDate).toContain("2026");

    const styledTime = formatTime(sampleDate, "vi", {
      timeStyle: "short",
      timeZone: "Asia/Ho_Chi_Minh",
    });
    expect(styledTime).not.toContain("T14:30");
    expect(styledTime).toContain("21:30");

    expect(formatDate("invalid-date", "vi")).toBe("—");
    expect(formatNumber(1234.5, "en")).toBe("1,234.5");
    expect(formatNumber(1234.5, "vi")).toContain("1.234");
    expect(formatPercent(0.85, "en")).toBe("85%");
    expect(formatPercent(85, "en", { isRatio: false })).toBe("85%");
    expect(formatDuration(125, "en")).toMatch(/2/);
    expect(formatDuration(125, "vi")).toMatch(/2/);
    expect(formatRelativeTime(-1, "day", "en")).toMatch(/yesterday/i);
    expect(formatRelativeTime(-1, "day", "vi")).toMatch(/hôm qua/i);
    expect(formatList(["Lan", "Minh"], "en")).toBe("Lan and Minh");
    expect(formatList(["Lan", "Minh"], "vi")).toContain("Lan");
  });
});
