import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { cookiesMock } = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

import {
  getServerI18n,
  getServerLocale,
  resolveServerLocaleFromCookieValue,
} from "@/lib/i18n/server";
import { findDuplicateJsonKeys, runI18nAudit } from "@/scripts/check-i18n.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const frontendMessagesDir = path.resolve(currentDir, "../../messages");

beforeEach(() => {
  cookiesMock.mockReset();
});

describe("i18n server locale resolution", () => {
  it("resolves published cookie safely and falls back to vi for unpublished or malicious cookies", async () => {
    cookiesMock.mockResolvedValue({
      get: (name: string) =>
        name === "viread_locale" ? { value: "vi" } : undefined,
    });
    expect(await getServerLocale()).toBe("vi");

    const snapshot = await getServerI18n();
    expect(snapshot.locale).toBe("vi");
    expect(snapshot.dir).toBe("ltr");
    expect(snapshot.messages.common).toBeDefined();

    // Published non-vi locale cookie resolves to that locale
    cookiesMock.mockResolvedValue({
      get: () => ({ value: "en" }),
    });
    expect(await getServerLocale()).toBe("en");

    // Unpublished locale in cookie falls back to "vi" in default server resolution
    cookiesMock.mockResolvedValue({
      get: () => ({ value: "ne" }),
    });
    expect(await getServerLocale()).toBe("vi");

    // Traversal/XSS payloads fall back to "vi"
    expect(resolveServerLocaleFromCookieValue("../en")).toBe("vi");
    expect(
      resolveServerLocaleFromCookieValue("<script>alert(1)</script>"),
    ).toBe("vi");

    // Explicitly allowing unpublished returns normalized locale
    expect(
      resolveServerLocaleFromCookieValue("ne-NP", { publishedOnly: false }),
    ).toBe("ne");
  });

  it("handles cookies() called outside Next.js request scope without throwing", async () => {
    cookiesMock.mockRejectedValue(
      new Error("cookies was called outside a request scope"),
    );
    expect(await getServerLocale()).toBe("vi");
  });
});

describe("check-i18n audit script", () => {
  it("passes cleanly on frontend/messages/* under strict mode", () => {
    const result = runI18nAudit({
      messagesDir: frontendMessagesDir,
      strict: true,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.localeSummaries).toHaveLength(11);
    const viSummary = result.localeSummaries.find((s) => s.locale === "vi");
    const enSummary = result.localeSummaries.find((s) => s.locale === "en");
    expect(viSummary).toMatchObject({
      locale: "vi",
      missingCount: 0,
      extraCount: 0,
      placeholderErrors: 0,
      coveragePct: 100,
    });
    expect(enSummary).toMatchObject({
      locale: "en",
      missingCount: 0,
      extraCount: 0,
      placeholderErrors: 0,
      coveragePct: 100,
    });
  });

  it("detects duplicate JSON keys, missing keys, placeholder mismatches, and untranslated text", () => {
    expect(
      findDuplicateJsonKeys('{"a":"1","nested":{"b":"2","b":"3"},"a":"4"}'),
    ).toEqual(["nested.b", "a"]);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "viread-i18n-"));
    try {
      const viDir = path.join(tempRoot, "vi");
      const enDir = path.join(tempRoot, "en");
      fs.mkdirSync(viDir, { recursive: true });
      fs.mkdirSync(enDir, { recursive: true });

      const namespaces = [
        "common",
        "auth",
        "navigation",
        "parent",
        "child",
        "admin",
        "books",
        "ocr",
        "reading",
        "speech",
        "difficultWords",
        "reports",
        "entertainment",
        "games",
        "settings",
        "errors",
        "validation",
        "notifications",
        "accessibility",
      ];

      for (const ns of namespaces) {
        const viPayload =
          ns === "common"
            ? {
                brand: "ViRead",
                greeting: "Xin chào {name}",
                items: "{count, plural, =0 {Không có} other {# mục}}",
                extraSource: "Chỉ có ở nguồn",
              }
            : { ok: `${ns} ok` };
        const enPayload =
          ns === "common"
            ? {
                brand: "ViRead",
                greeting: "Hello {wrongVar}",
                items: "count items",
                extraTarget: "Extra key",
              }
            : { ok: `${ns} ok` };
        fs.writeFileSync(
          path.join(viDir, `${ns}.json`),
          JSON.stringify(viPayload),
        );
        fs.writeFileSync(
          path.join(enDir, `${ns}.json`),
          JSON.stringify(enPayload),
        );
      }

      const audit = runI18nAudit({ messagesDir: tempRoot });
      expect(audit.ok).toBe(false);
      expect(
        audit.errors.some((e) => e.includes("Missing key: common.extraSource")),
      ).toBe(true);
      expect(
        audit.errors.some((e) =>
          e.includes("Extra key not in vi: common.extraTarget"),
        ),
      ).toBe(true);
      expect(
        audit.errors.some((e) =>
          e.includes("Placeholder mismatch at common.greeting"),
        ),
      ).toBe(true);
      expect(
        audit.errors.some((e) =>
          e.includes("Plural structure mismatch at common.items"),
        ),
      ).toBe(true);
      // Brand allowlist "ViRead" must not be flagged as untranslated
      expect(audit.warnings.some((w) => w.includes("common.brand"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("never duplicates the root layout brand suffix inside books.myBooks page titles", () => {
    const localeDirs = fs
      .readdirSync(frontendMessagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(localeDirs.length).toBeGreaterThanOrEqual(11);
    for (const locale of localeDirs) {
      const booksJson = JSON.parse(
        fs.readFileSync(
          path.join(frontendMessagesDir, locale, "books.json"),
          "utf8",
        ),
      ) as { myBooks?: { pageTitle?: string; detailPageTitle?: string } };
      expect(booksJson.myBooks?.pageTitle).toBeTruthy();
      expect(booksJson.myBooks?.pageTitle).not.toMatch(/\|\s*ViRead\s*$/);
      expect(booksJson.myBooks?.detailPageTitle).toBeTruthy();
      expect(booksJson.myBooks?.detailPageTitle).not.toMatch(/\|\s*ViRead\s*$/);
    }
  });
});
