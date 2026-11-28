import { expect, test, type Page } from "@playwright/test";

const MOCK_API_URL =
  process.env.VIREAD_MOCK_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://127.0.0.1:18080";
const CRON_SECRET =
  process.env.CRON_SECRET ?? "viread_e2e_cron_secret_0123456789abcdef";

function attachSafetyObservers(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const escapedRequests: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("request", (req) => {
    const url = req.url();
    if (
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost") ||
      url.startsWith("data:") ||
      url.startsWith("blob:")
    ) {
      return;
    }
    // External supabase.co / API requests must be intercepted by page.route mocks
    escapedRequests.push(url);
  });

  return { consoleErrors, pageErrors, escapedRequests };
}

function parseMaxAgeSeconds(headerValue: string): number | null {
  const match = /\bmax-age=(\d+)\b/i.exec(headerValue);
  return match ? Number(match[1]) : null;
}

async function installSafeSupabaseAndApiRoutes(
  page: Page,
  options: {
    onHealthRequest?: () => void;
    healthMode?: "ok" | "error-500" | "abort";
  } = {},
) {
  await page.route("**/*.supabase.co/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: null, session: null }),
    });
  });

  await page.route(`${MOCK_API_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/health") {
      options.onHealthRequest?.();
      if (options.healthMode === "error-500") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Simulated cold-start failure" }),
        });
        return;
      }
      if (options.healthMode === "abort") {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok", mode: "playwright-route" }),
      });
      return;
    }
    await route.fallback();
  });
}

test.describe("[harness] Vercel production smoke & invariants", () => {
  test("/login and /register render cleanly with zero console errors, zero real Supabase traffic, and zero overflow on desktop & mobile", async ({
    page,
  }) => {
    await installSafeSupabaseAndApiRoutes(page);
    const { consoleErrors, pageErrors, escapedRequests } =
      attachSafetyObservers(page);

    for (const routePath of ["/login", "/register"]) {
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        const res = await page.goto(routePath, {
          waitUntil: "domcontentloaded",
        });
        expect(res?.status()).toBe(200);
        await expect(page.locator("h1").first()).toBeVisible();

        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(overflow.scrollWidth).toBeLessThanOrEqual(
          overflow.innerWidth + 1,
        );
      }
    }

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    // Only route-intercepted sampleid.supabase.co would appear if auth calls ran; assert zero unmocked escapes
    for (const externalUrl of escapedRequests) {
      expect(externalUrl).toContain("sampleid.supabase.co");
    }
  });

  test("/wasm/* serves immutable Cache-Control while HTML routes (/login, /dashboard) do not", async ({
    request,
  }) => {
    const wasmNoticeRes = await request.get("/wasm/sherpa/NOTICE.txt");
    expect(wasmNoticeRes.status()).toBe(200);
    const wasmCache = wasmNoticeRes.headers()["cache-control"] ?? "";
    expect(wasmCache).toContain("public");
    expect(wasmCache).toContain("max-age=31536000");
    expect(wasmCache).toContain("immutable");

    const loginRes = await request.get("/login");
    expect(loginRes.status()).toBe(200);
    expect(loginRes.headers()["cache-control"] ?? "").not.toContain(
      "immutable",
    );

    const dashboardRes = await request.get("/dashboard", { maxRedirects: 0 });
    expect([307, 308]).toContain(dashboardRes.status());
    expect(dashboardRes.headers()["cache-control"] ?? "").not.toContain(
      "immutable",
    );
  });

  test("/api/cron/parent-emails rejects unauthorized requests (401) and succeeds (200) across transient 502 retry", async ({
    request,
  }) => {
    const unauthorizedRes = await request.get("/api/cron/parent-emails", {
      headers: { authorization: "Bearer invalid-cron-token" },
    });
    expect(unauthorizedRes.status()).toBe(401);

    const armRes = await request.post(`${MOCK_API_URL}/__mock/cron-arm-502`);
    expect(armRes.status()).toBe(200);

    const startedAt = Date.now();
    const cronRes = await request.get(
      "/api/cron/parent-emails?scope=engagement",
      {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      },
    );
    const elapsedMs = Date.now() - startedAt;

    expect(cronRes.status()).toBe(200);
    expect(elapsedMs).toBeLessThan(60_000);
    const payload = (await cronRes.json()) as {
      ok: boolean;
      summary: { attempt?: number; scope?: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary.scope).toBe("engagement");
    expect(payload.summary.attempt).toBe(2);

    const statsRes = await request.get(`${MOCK_API_URL}/__mock/stats`);
    const stats = (await statsRes.json()) as {
      cronState: { attempts: number };
    };
    expect(stats.cronState.attempts).toBe(2);
  });
});

test.describe("[M3-target] Vercel headers, proxy routing, and login pre-warm", () => {
  test("GET / returns a single-hop 307 redirect to /login", async ({
    request,
  }) => {
    const res = await request.get("/", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    const location = res.headers()["location"] ?? "";
    expect(location.endsWith("/login")).toBe(true);
  });

  test("/images/*, /audio/*, and /workers/* return public Cache-Control (>=3600s/86400s) and Strict-Transport-Security (HSTS >= 31536000)", async ({
    request,
  }) => {
    const assetExpectations = [
      { path: "/images/reading-studio.webp", minMaxAge: 86_400 },
      { path: "/audio/word-samples/thuc-nang.wav", minMaxAge: 86_400 },
      { path: "/workers/sherpa-stt-worker.js", minMaxAge: 3_600 },
    ];
    for (const { path: assetPath, minMaxAge } of assetExpectations) {
      const res = await request.get(assetPath);
      expect(res.status()).toBe(200);
      const cacheControl = res.headers()["cache-control"] ?? "";
      expect(cacheControl).toMatch(/\bpublic\b/i);
      expect(cacheControl).not.toMatch(/\bno-store\b/i);
      const cacheMaxAge = parseMaxAgeSeconds(cacheControl);
      expect(cacheMaxAge).not.toBeNull();
      expect(cacheMaxAge!).toBeGreaterThanOrEqual(minMaxAge);

      const hsts = res.headers()["strict-transport-security"] ?? "";
      const hstsMaxAge = parseMaxAgeSeconds(hsts);
      expect(hstsMaxAge).not.toBeNull();
      expect(hstsMaxAge!).toBeGreaterThanOrEqual(31_536_000);
    }
  });

  test("/api/parent-email-relay bypasses auth proxy redirect", async ({
    request,
  }) => {
    const res = await request.post("/api/parent-email-relay", {
      maxRedirects: 0,
      data: {},
    });
    expect(res.status()).not.toBe(307);
    const location = res.headers()["location"] ?? "";
    expect(location).not.toContain("/login");
  });

  test("/login emits a non-blocking /health pre-warm GET request", async ({
    page,
  }) => {
    let healthRequests = 0;
    await installSafeSupabaseAndApiRoutes(page, {
      onHealthRequest: () => {
        healthRequests += 1;
      },
    });

    await page.goto("/login", { waitUntil: "networkidle" });
    await expect
      .poll(() => healthRequests, { timeout: 5000 })
      .toBeGreaterThanOrEqual(1);
  });

  test("/login renders cleanly with zero page errors when /health pre-warm fails (500 or aborted)", async ({
    page,
  }) => {
    for (const healthMode of ["error-500", "abort"] as const) {
      let healthAttempted = false;
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await installSafeSupabaseAndApiRoutes(page, {
        healthMode,
        onHealthRequest: () => {
          healthAttempted = true;
        },
      });
      const { pageErrors } = attachSafetyObservers(page);

      const res = await page.goto("/login", { waitUntil: "domcontentloaded" });
      expect(res?.status()).toBe(200);
      await expect(page.locator("h1").first()).toBeVisible();
      await expect(page.locator('button[type="submit"]').first()).toBeVisible();
      await expect.poll(() => healthAttempted, { timeout: 5000 }).toBe(true);
      expect(pageErrors).toEqual([]);
    }
  });
});

test.describe("[M4-target] RootLayout preconnect, admin i18n trim & assistant lazy-load", () => {
  test("/login and /register SSR HTML/Link headers include configured preconnect origins and exclude admin-only strings", async ({
    request,
  }) => {
    // String unique to messages/*/admin.json (qualityHub.description)
    const adminOnlyString =
      "Kiểm tra metadata, xử lý báo cáo phụ huynh, duyệt an toàn sách";
    const expectedOrigins = [
      new URL(MOCK_API_URL).origin,
      "https://sampleid.supabase.co",
    ];

    for (const routePath of ["/login", "/register"]) {
      const res = await request.get(routePath);
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(html).not.toContain(adminOnlyString);

      const linkHeader = res.headers()["link"] ?? "";
      for (const origin of expectedOrigins) {
        const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const htmlOriginRegex = new RegExp(
          `<link[^>]+(?:rel=["']preconnect["'][^>]+href=["']${escapedOrigin}|href=["']${escapedOrigin}[^"']*["'][^>]+rel=["']preconnect["'])`,
          "i",
        );
        const headerOriginRegex = new RegExp(
          `<${escapedOrigin}/?>[^>]*;\\s*rel=["']?preconnect["']?`,
          "i",
        );
        expect(
          htmlOriginRegex.test(html) || headerOriginRegex.test(linkHeader),
          `Expected SSR HTML or Link header for ${routePath} to preconnect ${origin}`,
        ).toBe(true);
      }
    }
  });

  test("collapsed assistant launcher opens assistant panel lazily on click", async ({
    page,
  }) => {
    await installSafeSupabaseAndApiRoutes(page);
    const { consoleErrors, pageErrors } = attachSafetyObservers(page);

    await page.goto("/login", { waitUntil: "domcontentloaded" });

    const launcher = page.getByTestId("viread-assistant-launcher");
    await expect(launcher).toBeVisible();
    await expect(page.getByTestId("viread-assistant-panel")).toHaveCount(0);

    await launcher.click();
    await expect(page.getByTestId("viread-assistant-panel")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
