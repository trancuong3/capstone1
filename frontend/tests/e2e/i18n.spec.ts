import { expect, test, type Page } from "@playwright/test";

import { authFixtureHeaders } from "./auth-fixture";

const PUBLISHED_LOCALES = [
  { code: "vi", dir: "ltr", nativeName: "Tiếng Việt" },
  { code: "en", dir: "ltr", nativeName: "English" },
  { code: "zh-Hans", dir: "ltr", nativeName: "简体中文" },
  { code: "zh-Hant", dir: "ltr", nativeName: "繁體中文" },
  { code: "ja", dir: "ltr", nativeName: "日本語" },
  { code: "ko", dir: "ltr", nativeName: "한국어" },
  { code: "fr", dir: "ltr", nativeName: "Français" },
  { code: "de", dir: "ltr", nativeName: "Deutsch" },
  { code: "es", dir: "ltr", nativeName: "Español" },
  { code: "ar", dir: "rtl", nativeName: "العربية" },
  { code: "he", dir: "rtl", nativeName: "עברית" },
] as const;

const RAW_KEY_PATTERN =
  /\b(?:common|auth|navigation|parent|child|admin|books|ocr|reading|speech|difficultWords|reports|entertainment|games|settings|errors|validation|notifications|accessibility)\.[a-z][a-zA-Z0-9]+(?:\.[a-z][a-zA-Z0-9]+)+/;

const RESPONSIVE_VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 768, height: 1024 },
  { width: 1024, height: 900 },
  { width: 1440, height: 1000 },
  { width: 1920, height: 1080 },
] as const;

const RESPONSIVE_LOCALES = ["vi", "en", "de", "ja", "ar"] as const;

function attachErrorCollectors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  };
  const onPageError = (error: Error) => {
    pageErrors.push(error.message);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  return {
    consoleErrors,
    pageErrors,
    detach: () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    },
  };
}

function getSelectorTrigger(page: Page) {
  return page
    .locator('[data-variant] button[aria-haspopup="dialog"]:visible')
    .first();
}

async function openLanguageSelector(page: Page) {
  const trigger = getSelectorTrigger(page);
  await expect(trigger).toBeVisible();
  await expect(async () => {
    if ((await trigger.getAttribute("aria-expanded")) !== "true") {
      await trigger.click();
    }
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 10_000 });
}

async function selectLocaleViaUi(page: Page, code: string) {
  await openLanguageSelector(page);
  const option = page
    .locator(`[role="option"][data-locale-code="${code}"]`)
    .first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator("html")).toHaveAttribute("lang", code);
}

test.describe("Global multilingual & internationalization E2E", () => {
  test("defaults to Vietnamese even when browser locale and Accept-Language request English", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      locale: "en-US",
      extraHTTPHeaders: {
        ...authFixtureHeaders("parent"),
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const page = await context.newPage();
    const errors = attachErrorCollectors(page);

    try {
      await page.goto("/login?state=default", {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator("html")).toHaveAttribute("lang", "vi");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      await expect(
        page.getByRole("heading", { name: "Đăng nhập" }),
      ).toBeVisible();
      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
      await context.close();
    }
  });

  test("switches across all 11 published locales with dir, cookie, and reload persistence", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Full 11-locale cycle runs once on desktop-chromium.",
    );

    const errors = attachErrorCollectors(page);
    try {
      await page.goto("/login?state=default", {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator("html")).toHaveAttribute("lang", "vi");

      for (const locale of PUBLISHED_LOCALES) {
        if (locale.code === "vi") continue;

        await selectLocaleViaUi(page, locale.code);
        await expect(page.locator("html")).toHaveAttribute("dir", locale.dir);

        const cookies = await page.context().cookies();
        const localeCookie = cookies.find((c) => c.name === "viread_locale");
        expect(localeCookie?.value).toBe(locale.code);

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("html")).toHaveAttribute("lang", locale.code);
        await expect(page.locator("html")).toHaveAttribute("dir", locale.dir);
        await expect(getSelectorTrigger(page)).toContainText(locale.nativeName);

        const bodyText = await page.locator("body").innerText();
        expect(bodyText, `Raw key leaked in ${locale.code}`).not.toMatch(
          RAW_KEY_PATTERN,
        );
      }

      await selectLocaleViaUi(page, "vi");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute("lang", "vi");

      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
    }
  });

  test("mobile bottom-sheet language selector searches, switches locale, and avoids overflow", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile-chromium",
      "Bottom sheet behavior applies to mobile viewports.",
    );

    const errors = attachErrorCollectors(page);
    try {
      await page.goto("/login?state=default", {
        waitUntil: "domcontentloaded",
      });
      await openLanguageSelector(page);

      const sheet = page.locator('[data-language-sheet="true"]');
      await expect(sheet).toBeVisible();

      const searchInput = sheet.locator('input[type="search"]');
      await expect(searchInput).toBeVisible();
      await searchInput.fill("日本語");

      const jaOption = sheet.locator('[role="option"][data-locale-code="ja"]');
      await expect(jaOption).toBeVisible();
      await jaOption.click();

      await expect(sheet).toBeHidden();
      await expect(page.locator("html")).toHaveAttribute("lang", "ja");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

      const widths = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);

      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
    }
  });

  test("preserves Vietnamese LTR learning content and hides selector on child ReadingScreen in RTL mode", async ({
    page,
    baseURL,
  }) => {
    const errors = attachErrorCollectors(page);
    const originUrl = baseURL ?? "http://127.0.0.1:3000";
    const originHost = new URL(originUrl).hostname;
    const parentId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    const bookId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const pageId = "55555555-5555-4555-8555-555555555555";
    const revisionId = "66666666-6666-4666-8666-666666666666";
    const now = "2026-10-08T00:00:00Z";
    const corsHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization,content-type,accept,x-viread-locale",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    };

    try {
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const jwtPayload = Buffer.from(
        JSON.stringify({
          sub: parentId,
          exp: expiry,
          aud: "authenticated",
          role: "authenticated",
        }),
      ).toString("base64url");
      const mockAuthSession = {
        access_token: `eyJhbGciOiJIUzI1NiJ9.${jwtPayload}.isolated-test-signature`,
        refresh_token: "isolated-test-refresh",
        token_type: "bearer",
        expires_at: expiry,
        expires_in: 3600,
        user: {
          id: parentId,
          aud: "authenticated",
          role: "authenticated",
          email: "parent@example.test",
          app_metadata: {},
          user_metadata: { display_name: "Ba mẹ API" },
          created_at: now,
        },
      };

      await page.context().addCookies([
        {
          name: "viread_locale",
          value: "ar",
          url: originUrl,
        },
        {
          name: "sb-example-auth-token",
          value: `base64-${Buffer.from(JSON.stringify(mockAuthSession)).toString("base64url")}`,
          domain: originHost,
          path: "/",
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
          expires: expiry,
        },
      ]);

      const words = ["Bé", "mèo", "đọc"].map((text, index) => ({
        word_id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        word_index: index,
        text,
        bbox: [0.1 + index * 0.28, 0.2, 0.25, 0.08],
        line_index: 0,
      }));

      await page.route("http://127.0.0.1:8000/**", async (route) => {
        if (route.request().method() === "OPTIONS") {
          return route.fulfill({ status: 204, headers: corsHeaders });
        }
        const path = new URL(route.request().url()).pathname;
        const json = (body: unknown, status = 200) =>
          route.fulfill({
            status,
            headers: corsHeaders,
            contentType: "application/json",
            body: JSON.stringify(body),
          });

        if (path === "/reading-source.svg") {
          return route.fulfill({
            status: 200,
            headers: corsHeaders,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#fff8df"/></svg>',
          });
        }
        if (path === "/profiles/me") {
          return json({
            id: parentId,
            role: "parent",
            display_name: "Ba mẹ API",
            created_at: now,
            email: "parent@example.test",
            contact_phone: "+84900000000",
            email_verified: true,
            contact_info_status: "available",
            children: [
              {
                id: childId,
                parent_id: parentId,
                alias: "Bé An",
                grade: 2,
                settings: {},
                created_at: now,
              },
            ],
          });
        }
        if (path === `/profiles/children/${childId}`) {
          return json({
            id: childId,
            parent_id: parentId,
            alias: "Bé An",
            grade: 2,
            settings: {},
            created_at: now,
          });
        }
        if (path === `/books/catalog/${bookId}`) {
          return json({
            id: bookId,
            name: "Câu chuyện tiếng Việt",
            title: "Bé mèo đọc sách",
            author: "Tác giả mẫu",
            min_grade: 1,
            max_grade: 3,
            lifecycle_status: "ACTIVE",
          });
        }
        if (path === `/books/catalog/${bookId}/pages`) {
          return json([
            {
              page_id: pageId,
              page_number: 1,
              lifecycle_status: "ACTIVE",
              current_verified_revision_id: revisionId,
              preview_url: "http://127.0.0.1:8000/reading-source.svg",
            },
          ]);
        }
        if (path === `/reading/sessions/${sessionId}`) {
          return json({
            id: sessionId,
            child_id: childId,
            book_id: bookId,
            state: "PAGE_READY",
            started_at: now,
            ended_at: null,
            duration_ms: null,
          });
        }
        if (
          path === `/reading/sessions/${sessionId}/page` ||
          path === `/reading/pages/${pageId}`
        ) {
          return json({
            page_id: pageId,
            page_revision_id: revisionId,
            page_number: 1,
            confidence: 0.95,
            width: 600,
            height: 800,
            image_overlay_safe: true,
            image_url: "http://127.0.0.1:8000/reading-source.svg",
            text: "Bé mèo đọc",
            words,
          });
        }
        if (path === `/reading/sessions/${sessionId}/progress`) {
          return json({
            session_id: sessionId,
            persisted: true,
            start_page_id: pageId,
            end_page_id: pageId,
            current_page_id: pageId,
            start_page_number: 1,
            end_page_number: 1,
            current_page_number: 1,
            current_index: 0,
            total_pages: 1,
            completed_pages: 0,
            pages: [
              {
                page_id: pageId,
                page_revision_id: revisionId,
                page_number: 1,
                page_order: 0,
                status: "IN_PROGRESS",
                started_at: now,
                completed_at: null,
              },
            ],
          });
        }
        if (path === `/reading/sessions/${sessionId}/practice-state`) {
          return json({
            session_id: sessionId,
            legacy_evidence_present: false,
            pages: [],
            words: [],
          });
        }
        if (path === `/reading/sessions/${sessionId}/completion-summary`) {
          return json({
            assessment: null,
            duration_minutes: null,
            pages_explored: 0,
            selected_range_pages: 1,
            practiced_words: 0,
            score: null,
            correct_words: [],
            mispronounced_words: [],
            skipped_words: [],
            transcripts: [],
            spoken_words: [],
          });
        }
        if (path === `/reading/sessions/${sessionId}/reports`) {
          return json({
            session_id: sessionId,
            reports: [],
            total: 0,
            assessment: null,
          });
        }
        if (path === "/voice/status") {
          return json({
            default_mode: "local_only",
            default_voice_id: "fixture_vi",
            local: { available: true, stt_ready: true, tts_ready: true },
            google: {
              stt_configured: false,
              tts_configured: false,
              stt_cooldown: false,
              tts_cooldown: false,
            },
          });
        }
        if (path === "/voice/voices") {
          return json({ default_voice_id: "fixture_vi", voices: [] });
        }
        if (path === "/reading-presence/settings") {
          return json({ email_enabled: false });
        }
        return json({});
      });

      await page.goto(`/reading/${sessionId}?state=reading`, {
        waitUntil: "domcontentloaded",
      });

      await expect(page.locator("html")).toHaveAttribute("lang", "ar");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

      const learningBlocks = page.locator(".viread-learning-content");
      await expect(learningBlocks.first()).toBeVisible({ timeout: 15_000 });
      const count = await learningBlocks.count();
      expect(count).toBeGreaterThan(0);

      for (let i = 0; i < count; i += 1) {
        const block = learningBlocks.nth(i);
        await expect(block).toHaveAttribute("dir", "ltr");
        await expect(block).toHaveAttribute("lang", "vi");
      }

      // Child reading screen intentionally omits the language selector
      await expect(
        page.locator('[data-variant] button[aria-haspopup="dialog"]'),
      ).toHaveCount(0);

      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
    }
  });

  test("safely rejects tampered, XSS, path-traversal, and unpublished locale cookies", async ({
    page,
    baseURL,
  }) => {
    const errors = attachErrorCollectors(page);
    const invalidCookies = [
      "<script>window.__xssTriggered=true</script>",
      "../../etc/passwd",
      "xx-INVALID",
      "th",
    ];

    try {
      for (const badValue of invalidCookies) {
        await page.context().clearCookies();
        await page.context().addCookies([
          {
            name: "viread_locale",
            value: encodeURIComponent(badValue),
            url: baseURL ?? "http://127.0.0.1:3000",
          },
        ]);

        await page.goto("/login?state=default", {
          waitUntil: "domcontentloaded",
        });

        await expect(page.locator("html")).toHaveAttribute("lang", "vi");
        await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
        const xssTriggered = await page.evaluate(
          () =>
            (window as unknown as { __xssTriggered?: boolean }).__xssTriggered,
        );
        expect(xssTriggered).toBeUndefined();
      }

      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
    }
  });

  test("preserves login form state across in-app switches, isolates accounts, and keeps cached switches under 300ms", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Latency and form retention test runs on desktop-chromium.",
    );

    const errors = attachErrorCollectors(page);
    try {
      await page.goto("/login?state=default", {
        waitUntil: "domcontentloaded",
      });

      // Ensure client JS hydration is complete before interacting with controlled form inputs
      await openLanguageSelector(page);
      await page.keyboard.press("Escape");

      const emailInput = page.locator('input[type="email"]').first();
      await expect(emailInput).toBeVisible();
      await emailInput.fill("parent.test@viread.example");

      await selectLocaleViaUi(page, "en");
      await expect(emailInput).toHaveValue("parent.test@viread.example");

      await selectLocaleViaUi(page, "ar");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(emailInput).toHaveValue("parent.test@viread.example");

      await selectLocaleViaUi(page, "vi");
      await expect(emailInput).toHaveValue("parent.test@viread.example");

      // Measure cached vi -> en switch latency using in-page performance.now()
      await openLanguageSelector(page);
      const enOption = page
        .locator('[role="option"][data-locale-code="en"]')
        .first();
      await expect(enOption).toBeVisible();

      const switchDurationMs = await page.evaluate(async () => {
        const option = document.querySelector<HTMLButtonElement>(
          '[role="option"][data-locale-code="en"]',
        );
        if (!option) return -1;
        const t0 = performance.now();
        option.click();
        await new Promise<void>((resolve) => {
          const check = () => {
            if (document.documentElement.lang === "en") {
              resolve();
            } else {
              requestAnimationFrame(check);
            }
          };
          check();
        });
        return performance.now() - t0;
      });

      console.log(
        `[i18n-perf] cached switch vi->en latency: ${switchDurationMs.toFixed(2)} ms`,
      );
      expect(switchDurationMs).toBeGreaterThanOrEqual(0);
      expect(switchDurationMs).toBeLessThan(300);
      await expect(emailInput).toHaveValue("parent.test@viread.example");

      // Cross-account isolation: switching to admin without shared cookie/storage resolves safely to vi
      await page.setExtraHTTPHeaders(authFixtureHeaders("admin"));
      await page.context().clearCookies();
      await page.evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
      });
      await page.goto("/admin/books", { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute("lang", "vi");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
    }
  });

  test("maintains zero horizontal overflow, console errors, and raw keys across 8 viewports and 5 scripts", async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "The 8-viewport matrix explicitly tests all widths from 320px to 1920px.",
    );

    const routesToCheck = ["/login?state=default", "/dashboard"] as const;
    const errors = attachErrorCollectors(page);

    try {
      for (const locale of RESPONSIVE_LOCALES) {
        const expectedDir = locale === "ar" ? "rtl" : "ltr";
        await page.context().clearCookies();
        await page.context().addCookies([
          {
            name: "viread_locale",
            value: locale,
            url: baseURL ?? "http://127.0.0.1:3000",
          },
        ]);

        for (const route of routesToCheck) {
          await page.setViewportSize({ width: 1440, height: 1000 });
          await page.goto(route, { waitUntil: "domcontentloaded" });
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          await expect(page.locator("html")).toHaveAttribute(
            "dir",
            expectedDir,
          );
          await expect(page.locator("h1").first()).toBeVisible();

          const bodyText = await page.locator("body").innerText();
          expect(bodyText, `Raw key on ${route} (${locale})`).not.toMatch(
            RAW_KEY_PATTERN,
          );

          for (const viewport of RESPONSIVE_VIEWPORTS) {
            await page.setViewportSize(viewport);
            const widths = await page.evaluate(() => ({
              clientWidth: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
            }));
            expect(
              widths.scrollWidth,
              `${route} overflows horizontally in ${locale} at ${viewport.width}px`,
            ).toBeLessThanOrEqual(widths.clientWidth);
          }
        }
      }

      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
    }
  });
});
