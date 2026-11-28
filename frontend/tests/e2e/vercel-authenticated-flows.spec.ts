import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { stringToBase64URL } from "@supabase/ssr";

import { authFixtureHeaders } from "./auth-fixture";

const MOCK_API_URL =
  process.env.VIREAD_MOCK_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://127.0.0.1:18080";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "92000000-0000-4000-8000-000000000001";
const BOOK_1_ID = "82000000-0000-4000-8000-000000000010";
const SESSION_ID = "72000000-0000-4000-8000-000000000001";
const PAGE_1_ID = "83000000-0000-4000-8000-000000000011";
const PAGE_2_ID = "83000000-0000-4000-8000-000000000012";
const REV_1_ID = "84000000-0000-4000-8000-000000000011";
const REV_2_ID = "84000000-0000-4000-8000-000000000012";
const REPORT_PRIMARY_ID = "85000000-0000-4000-8000-000000000010";
const REPORT_1_ID = "85000000-0000-4000-8000-000000000011";
const PERIOD_1_ID = "86000000-0000-4000-8000-000000000001";
const NOW = "2026-11-21T10:00:00Z";

function makeFakeJwt(sub: string, role: "parent" | "admin"): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 36000,
      iat: Math.floor(Date.now() / 1000) - 60,
      role: "authenticated",
      sub,
      user_metadata: { role },
    }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-e2e-signature`;
}

async function seedAuthenticatedParentContext(
  context: BrowserContext,
  options: { onRefreshToken?: () => string } = {},
) {
  await context.setExtraHTTPHeaders(authFixtureHeaders("parent"));

  let activeToken = makeFakeJwt(PARENT_ID, "parent");
  const buildSession = (token: string) => ({
    access_token: token,
    token_type: "bearer",
    expires_in: 36000,
    expires_at: Math.floor(Date.now() / 1000) + 36000,
    refresh_token: "synthetic-refresh-token",
    user: {
      id: PARENT_ID,
      aud: "authenticated",
      role: "authenticated",
      email: "parent@viread.local",
      user_metadata: { role: "parent" },
      app_metadata: { provider: "email" },
      created_at: NOW,
    },
  });

  const sessionPayload = buildSession(activeToken);
  await context.addCookies([
    {
      name: "sb-sampleid-auth-token",
      value: `base64-${stringToBase64URL(JSON.stringify(sessionPayload))}`,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  await context.route("https://sampleid.supabase.co/**", async (route) => {
    const reqUrl = new URL(route.request().url());
    if (reqUrl.pathname.startsWith("/auth/v1/token")) {
      activeToken =
        options.onRefreshToken?.() ?? makeFakeJwt(PARENT_ID, "parent");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildSession(activeToken)),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionPayload.user),
    });
  });

  await context.addInitScript(
    ({ userId, childId }) => {
      try {
        window.sessionStorage.setItem(
          `viread:selected-child:${userId}`,
          childId,
        );
      } catch {
        // Ignore restricted storage contexts.
      }
    },
    { userId: PARENT_ID, childId: CHILD_ID },
  );
}

interface MockRouteBehavior {
  childDelayMs?: number;
  dashboardDelayMs?: number;
  periodsDelayMs?: number;
  reportDelayMs?: number;
  catalogMode?: "ok" | "fail-once-503" | "fail-once-401";
}

function attachConsoleSchemaGuard(page: Page) {
  const schemaErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      msg.text().includes("API schema validation")
    ) {
      schemaErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  return { schemaErrors, pageErrors };
}

async function installAuthenticatedMockApi(
  page: Page,
  behavior: MockRouteBehavior = {},
) {
  const events: Array<{
    method: string;
    path: string;
    phase: "start" | "end";
    ts: number;
  }> = [];
  let catalogAttempts = 0;
  const deletedReportIds = new Set<string>();

  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  };
  const json = (data: unknown, status = 200) => ({
    status,
    headers: corsHeaders,
    contentType: "application/json",
    body: JSON.stringify(data),
  });

  const profile = {
    id: PARENT_ID,
    display_name: "Phụ huynh Kiểm thử",
    email: "parent@viread.local",
    role: "parent",
    avatar_url: null,
    preferred_locale: "vi",
    created_at: NOW,
  };

  const child = {
    id: CHILD_ID,
    parent_id: PARENT_ID,
    alias: "Bé An",
    grade: 2,
    settings: {},
    created_at: NOW,
    avatar_url: null,
  };

  const catalog = [
    {
      id: BOOK_1_ID,
      title: "Chú Mèo Đi Hia",
      author: "ViRead",
      min_grade: 1,
      max_grade: 3,
      lifecycle_status: "ACTIVE",
      visibility_scope: "CATALOG",
      cover_url: null,
      cover_source_type: null,
    },
  ];

  await page.route(`${MOCK_API_URL}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    const url = new URL(req.url());
    const p = url.pathname;
    events.push({
      method: req.method(),
      path: p,
      phase: "start",
      ts: Date.now(),
    });

    const finish = async (res: ReturnType<typeof json>) => {
      events.push({
        method: req.method(),
        path: p,
        phase: "end",
        ts: Date.now(),
      });
      await route.fulfill(res);
    };

    if (p === "/health") {
      await finish(json({ status: "ok" }));
      return;
    }

    if (p === "/profiles/me") {
      await finish(json(profile));
      return;
    }

    if (p === "/profiles/children") {
      await finish(json([child]));
      return;
    }

    if (p === `/profiles/children/${CHILD_ID}`) {
      if (behavior.childDelayMs) {
        await new Promise((r) => setTimeout(r, behavior.childDelayMs));
      }
      await finish(json(child));
      return;
    }

    if (p === "/profiles/dashboard-summary") {
      if (behavior.dashboardDelayMs) {
        await new Promise((r) => setTimeout(r, behavior.dashboardDelayMs));
      }
      await finish(
        json({
          profile,
          children: [child],
          latest_sessions_by_child: { [CHILD_ID]: null },
        }),
      );
      return;
    }

    if (p === "/books/catalog" || p === "/books/") {
      catalogAttempts += 1;
      if (behavior.catalogMode === "fail-once-503" && catalogAttempts === 1) {
        await finish(json({ detail: "cold start" }, 503));
        return;
      }
      if (behavior.catalogMode === "fail-once-401" && catalogAttempts === 1) {
        await finish(json({ detail: "expired token" }, 401));
        return;
      }
      await finish(json(catalog));
      return;
    }

    if (
      p === "/reading-management/collections" ||
      p === `/reading-management/children/${CHILD_ID}/collections`
    ) {
      await finish(json([]));
      return;
    }

    if (p === "/studio/tasks") {
      await finish(
        json({
          actor_id: PARENT_ID,
          actor_role: "parent",
          active_count: 0,
          waiting_review_count: 0,
          failed_count: 0,
          completed_count: 0,
          worker_online: false,
          recommended_poll_ms: null,
          tasks: [],
        }),
      );
      return;
    }

    if (p === "/tasks" || p.startsWith("/tasks/") || p === "/global-tasks") {
      await finish(json({ items: [], total: 0 }));
      return;
    }

    if (p === `/system/progress/${CHILD_ID}/periods`) {
      if (behavior.periodsDelayMs) {
        await new Promise((r) => setTimeout(r, behavior.periodsDelayMs));
      }
      await finish(
        json({
          items: [
            {
              id: PERIOD_1_ID,
              child_id: CHILD_ID,
              period_start: "2026-11-01",
              period_end: "2026-11-15",
              generated_at: NOW,
            },
          ],
          next_cursor: null,
        }),
      );
      return;
    }

    if (p === `/system/progress/${CHILD_ID}`) {
      if (behavior.reportDelayMs) {
        await new Promise((r) => setTimeout(r, behavior.reportDelayMs));
      }
      await finish(
        json({
          id: PERIOD_1_ID,
          generated_at: NOW,
          child_id: CHILD_ID,
          period_start: "2026-11-01",
          period_end: "2026-11-15",
          completed_sessions: 3,
          reading_duration_ms: 900_000,
          omission_count: 1,
          repetition_count: 0,
          long_pause_count: 0,
          omission_rate: 5,
          repetition_rate: 0,
          long_pause_rate: 0,
          comprehension_accuracy: 100,
          assessment: null,
          assessment_coverage: null,
          difficult_words: [],
          previous_period: null,
          trend_deltas: null,
          legacy: null,
          data_status: "complete",
          availability: {
            metrics: "available",
            difficult_words: "available",
            comparison: "absent",
          },
        }),
      );
      return;
    }

    if (p === `/reading/sessions/${SESSION_ID}`) {
      await finish(
        json({
          id: SESSION_ID,
          child_id: CHILD_ID,
          book_id: BOOK_1_ID,
          state: "FINISHED",
          started_at: "2026-11-21T09:50:00Z",
          ended_at: NOW,
          duration_ms: 600_000,
        }),
      );
      return;
    }

    if (
      p === `/reading/sessions/${SESSION_ID}/page` ||
      p === `/reading/pages/${PAGE_1_ID}`
    ) {
      await finish(
        json({
          page_id: PAGE_1_ID,
          page_revision_id: REV_1_ID,
          page_number: 1,
          confidence: 0.99,
          width: 600,
          height: 800,
          text: "Bé mèo khỏe.",
          words: ["Bé", "mèo", "khỏe"].map((text, idx) => ({
            word_id: `50000000-0000-4000-8000-00000000000${idx + 1}`,
            word_index: idx,
            text,
            bbox: [0.1 + idx * 0.2, 0.2, 0.15, 0.05],
          })),
        }),
      );
      return;
    }

    if (p === `/reading/sessions/${SESSION_ID}/progress`) {
      await finish(
        json({
          session_id: SESSION_ID,
          persisted: true,
          start_page_id: PAGE_1_ID,
          end_page_id: PAGE_2_ID,
          current_page_id: PAGE_2_ID,
          start_page_number: 1,
          end_page_number: 2,
          current_page_number: 2,
          current_index: 1,
          total_pages: 2,
          completed_pages: 2,
          pages: [
            {
              page_id: PAGE_1_ID,
              page_revision_id: REV_1_ID,
              page_number: 1,
              page_order: 0,
              status: "COMPLETED",
              started_at: "2026-11-21T09:50:00Z",
              completed_at: "2026-11-21T09:55:00Z",
            },
            {
              page_id: PAGE_2_ID,
              page_revision_id: REV_2_ID,
              page_number: 2,
              page_order: 1,
              status: "COMPLETED",
              started_at: "2026-11-21T09:55:00Z",
              completed_at: NOW,
            },
          ],
        }),
      );
      return;
    }

    if (p === `/reading/sessions/${SESSION_ID}/practice-state`) {
      await finish(
        json({
          session_id: SESSION_ID,
          legacy_evidence_present: false,
          pages: [],
          words: [],
        }),
      );
      return;
    }

    if (p === `/reading/sessions/${SESSION_ID}/completion-summary`) {
      await finish(
        json({
          duration_minutes: 10,
          pages_explored: 2,
          selected_range_pages: 2,
          practiced_words: 3,
          spoken_words: ["Bé", "mèo", "khỏe"],
          transcripts: ["Bé mèo khỏe"],
          correct_words: ["Bé", "mèo", "khỏe"],
          mispronounced_words: [],
          skipped_words: [],
          score: 100,
          assessment: {
            first_pass_correct: 3,
            first_pass_incorrect: 0,
            self_corrected_words: 0,
            unresolved_words: 0,
            retry_attempts: 0,
            skipped_after_retry_limit: 0,
            recognition_uncertain: 0,
          },
        }),
      );
      return;
    }

    if (p === "/reading/events" && req.method() === "POST") {
      await finish(
        json({
          Id: "51000000-0000-4000-8000-000000000001",
          SessionId: SESSION_ID,
          PageId: PAGE_1_ID,
          PageRevisionId: REV_1_ID,
          WordId: "50000000-0000-4000-8000-000000000001",
          Type: "WORD_RETRY",
          StartMs: 0,
          EndMs: 500,
          Confidence: 0.95,
          Status: "CONFIRMED",
          Metadata: {},
          CreatedAt: NOW,
        }),
      );
      return;
    }

    if (p === "/reading/history") {
      await finish(
        json({
          sessions: [
            {
              id: SESSION_ID,
              child_id: CHILD_ID,
              book_id: BOOK_1_ID,
              state: "FINISHED",
              started_at: "2026-11-21T09:50:00Z",
              ended_at: NOW,
              duration_ms: 600_000,
            },
          ],
          next_cursor: null,
        }),
      );
      return;
    }

    if (p === `/reading/history/${SESSION_ID}`) {
      await finish(
        json({
          id: SESSION_ID,
          child_id: CHILD_ID,
          book_id: BOOK_1_ID,
          state: "FINISHED",
          started_at: "2026-11-21T09:50:00Z",
          ended_at: NOW,
          duration_ms: 600_000,
          selected_range_pages: 1,
          pages_completed: 1,
          selected_page_revision_ids: [REV_1_ID],
          reference_page_revision_ids: [REV_1_ID],
          events: [],
          fluency_assessment: null,
          comprehension: [],
          report_id: REPORT_1_ID,
          availability: {
            events: "available",
            fluency: "absent",
            comprehension: "absent",
          },
        }),
      );
      return;
    }

    if (p === `/reading/history/${SESSION_ID}/book`) {
      await finish(json(catalog[0]));
      return;
    }

    if (p === `/reading/reports/${REPORT_1_ID}` && req.method() === "DELETE") {
      deletedReportIds.add(REPORT_1_ID);
      await finish(json({ deleted: true }));
      return;
    }

    if (p === `/reading/sessions/${SESSION_ID}/reports`) {
      const makeAlignment = () => [
        {
          book_word: "Bé",
          spoken_word: "Bé",
          book_index: 0,
          spoken_index: 0,
          status: "MATCH",
        },
        {
          book_word: "mèo",
          spoken_word: "mèo",
          book_index: 1,
          spoken_index: 1,
          status: "MATCH",
        },
        {
          book_word: "khỏe",
          spoken_word: "khỏe",
          book_index: 2,
          spoken_index: 2,
          status: "MATCH",
        },
      ];
      const baseSummary = {
        missing_words: [],
        extra_words: [],
        substitutions: [],
        repeated_count: 0,
        repeated_words: [],
        hesitations: [],
        hesitation_seconds: 0,
      };
      const allReports = [
        {
          report_id: REPORT_PRIMARY_ID,
          page_id: PAGE_1_ID,
          page_revision_id: REV_1_ID,
          transcript: "Bé mèo khỏe",
          created_at: "2026-11-21T09:58:00Z",
          distance: 0,
          alignment: makeAlignment(),
          summary: {
            assessment_version: 1,
            ...baseSummary,
          },
        },
        {
          report_id: REPORT_1_ID,
          page_id: PAGE_1_ID,
          page_revision_id: REV_1_ID,
          transcript: "Bé mèo khỏe",
          created_at: NOW,
          distance: 0,
          alignment: makeAlignment(),
          summary: baseSummary,
        },
      ].filter((r) => !deletedReportIds.has(r.report_id));

      await finish(
        json({
          session_id: SESSION_ID,
          total: allReports.length,
          assessment: {
            first_pass_correct: 3,
            first_pass_incorrect: 0,
            self_corrected_words: 0,
            unresolved_words: 0,
            retry_attempts: 0,
            skipped_after_retry_limit: 0,
            recognition_uncertain: 0,
          },
          reports: allReports,
        }),
      );
      return;
    }

    if (p === "/voice/status") {
      await finish(json({ available: false, mode: "browser" }));
      return;
    }

    if (p === "/assistant/context") {
      await finish(json({ page_title: "ViRead", hints: [] }));
      return;
    }

    if (p === "/assistant/chat" && req.method() === "POST") {
      const body = req.postDataJSON() as { message?: string } | null;
      await finish(
        json({
          reply: `Gợi ý nhanh cho ba mẹ: ${body?.message ?? "Xin chào"}`,
          source_tier: "tier_0_kb",
          provider_id: "kb-local",
          model_id: null,
          bandwidth_applied: "high",
          latency_ms: 6,
          cached: false,
          role_scope: "parent",
          quick_actions: [],
          suggested_prompts: [],
        }),
      );
      return;
    }

    await finish(json({ detail: "MOCK_NOT_FOUND", path: p }, 404));
  });

  return {
    getEvents: () => events,
    getCatalogAttempts: () => catalogAttempts,
  };
}

test.describe("[harness] Authenticated concurrent assistant flow", () => {
  test("assistant chat executes concurrently while dashboard-summary is delayed", async ({
    context,
    page,
  }) => {
    await seedAuthenticatedParentContext(context);
    const tracker = await installAuthenticatedMockApi(page, {
      dashboardDelayMs: 2500,
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const launcher = page.getByTestId("viread-assistant-launcher");
    await expect(launcher).toBeVisible();
    const panel = page.getByTestId("viread-assistant-panel");

    // In next dev, first-hit hydration & next/dynamic panel chunk load can race a single early click
    await expect
      .poll(
        async () => {
          if (await panel.isVisible()) return true;
          await launcher.click().catch(() => undefined);
          return await panel.isVisible();
        },
        { timeout: 20_000, intervals: [300, 600, 1000] },
      )
      .toBe(true);

    await panel.locator("input").fill("Cách chọn sách lớp 2?");
    await panel.locator('button[type="submit"]').click();

    await expect(panel).toContainText("Cách chọn sách lớp 2?");
    await expect(panel).toContainText("Gợi ý nhanh cho ba mẹ");

    const assistantStart = tracker
      .getEvents()
      .find((e) => e.path === "/assistant/chat" && e.phase === "start");
    expect(assistantStart).toBeDefined();
  });
});

test.describe("[M3-target] Authenticated catalog concurrency, scoped cache & resilience", () => {
  test("auth + /books catalog load concurrently without blocking on delayed child fetch", async ({
    context,
    page,
  }) => {
    await seedAuthenticatedParentContext(context);
    const tracker = await installAuthenticatedMockApi(page, {
      childDelayMs: 1200,
    });

    await page.goto(`/books?childId=${CHILD_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: "Chú Mèo Đi Hia" }),
    ).toBeVisible();

    const events = tracker.getEvents();
    const catalogStart = events.find(
      (e) => e.path === "/books/catalog" && e.phase === "start",
    );
    const childEnd = events.find(
      (e) => e.path === `/profiles/children/${CHILD_ID}` && e.phase === "end",
    );
    expect(catalogStart).toBeDefined();
    if (childEnd) {
      expect(catalogStart!.ts).toBeLessThan(childEnd.ts);
    }
  });

  test("reading event mutation preserves cached /books/catalog across client navigation", async ({
    context,
    page,
  }) => {
    await seedAuthenticatedParentContext(context);
    const { schemaErrors, pageErrors } = attachConsoleSchemaGuard(page);
    const tracker = await installAuthenticatedMockApi(page);

    await page.goto(`/books?childId=${CHILD_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: "Chú Mèo Đi Hia" }),
    ).toBeVisible();
    const initialCatalogHits = tracker.getCatalogAttempts();
    expect(initialCatalogHits).toBe(1);

    // Navigate via SPA links through /books -> /dashboard -> /sessions -> /sessions/[sessionId]
    // and execute a real /reading/* mutation via requestApi (DELETE /reading/reports/:id)
    // directly inside SessionReadingReports on /sessions/[sessionId].
    await page.locator('a[href="/dashboard"]:visible').first().click();
    await page.waitForURL(/\/dashboard(\?|$)/);
    await page.locator('a[href="/sessions"]:visible').first().click();
    await page.waitForURL(/\/sessions(\?|$)/);
    await page
      .locator(`a[href^="/sessions/${SESSION_ID}"]:visible`)
      .first()
      .click();
    await page.waitForURL(new RegExp(`/sessions/${SESSION_ID}(\\?|$)`));

    const reportsSection = page.getByTestId("session-primary-reading-report");
    await expect(reportsSection).toBeVisible();
    const additionalComparisons = reportsSection.locator("details").first();
    await additionalComparisons.locator("summary").click();
    await additionalComparisons.locator("li button").last().click();
    await page.getByRole("alertdialog").getByRole("button").last().click();

    await expect
      .poll(
        () =>
          tracker
            .getEvents()
            .some(
              (e) =>
                e.method === "DELETE" &&
                e.path === `/reading/reports/${REPORT_1_ID}` &&
                e.phase === "end",
            ),
        { timeout: 5000 },
      )
      .toBe(true);

    // Return via SPA history back to /books so in-memory readCache remains alive
    await page.goBack();
    await page.waitForURL(/\/sessions(\?|$)/);
    await page.goBack();
    await page.waitForURL(/\/dashboard(\?|$)/);
    await page.goBack();
    await page.waitForURL(/\/books(\?|$)/);
    await expect(
      page.getByRole("heading", { name: "Chú Mèo Đi Hia" }),
    ).toBeVisible();
    expect(tracker.getCatalogAttempts()).toBe(initialCatalogHits);
    expect(schemaErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("bounded GET retry recovers from simulated cold-start 503 on /books/catalog", async ({
    context,
    page,
  }) => {
    await seedAuthenticatedParentContext(context);
    const tracker = await installAuthenticatedMockApi(page, {
      catalogMode: "fail-once-503",
    });

    await page.goto(`/books?childId=${CHILD_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: "Chú Mèo Đi Hia" }),
    ).toBeVisible();
    expect(tracker.getCatalogAttempts()).toBe(2);
  });

  test("401 token refresh recovery retries once with refreshed Supabase session token", async ({
    context,
    page,
  }) => {
    let refreshCount = 0;
    await seedAuthenticatedParentContext(context, {
      onRefreshToken: () => {
        refreshCount += 1;
        return makeFakeJwt(PARENT_ID, "parent");
      },
    });
    const tracker = await installAuthenticatedMockApi(page, {
      catalogMode: "fail-once-401",
    });

    await page.goto(`/books?childId=${CHILD_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: "Chú Mèo Đi Hia" }),
    ).toBeVisible();
    expect(refreshCount).toBeGreaterThanOrEqual(1);
    expect(tracker.getCatalogAttempts()).toBe(2);
  });

  test("ProgressReportScreen loads periods and report concurrently without sequential waterfall", async ({
    context,
    page,
  }) => {
    await seedAuthenticatedParentContext(context);
    const { schemaErrors, pageErrors } = attachConsoleSchemaGuard(page);
    const tracker = await installAuthenticatedMockApi(page, {
      periodsDelayMs: 600,
      reportDelayMs: 600,
    });

    await page.goto(
      `/reports?childId=${CHILD_ID}&period_start=2026-11-01&period_end=2026-11-15`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByText("Tiến bộ của Bé An")).toBeVisible();

    const events = tracker.getEvents();
    const periodsStart = events.find(
      (e) =>
        e.path === `/system/progress/${CHILD_ID}/periods` &&
        e.phase === "start",
    );
    const periodsEnd = events.find(
      (e) =>
        e.path === `/system/progress/${CHILD_ID}/periods` && e.phase === "end",
    );
    const reportStart = events.find(
      (e) => e.path === `/system/progress/${CHILD_ID}` && e.phase === "start",
    );
    const reportEnd = events.find(
      (e) => e.path === `/system/progress/${CHILD_ID}` && e.phase === "end",
    );
    expect(periodsStart).toBeDefined();
    expect(periodsEnd).toBeDefined();
    expect(reportStart).toBeDefined();
    expect(reportEnd).toBeDefined();
    expect(reportStart!.ts).toBeLessThan(periodsEnd!.ts);
    expect(periodsStart!.ts).toBeLessThan(reportEnd!.ts);
    expect(schemaErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("useValidatedSelectedChild skips redundant child GET when dashboard-summary cache is fresh", async ({
    context,
    page,
  }) => {
    await seedAuthenticatedParentContext(context);
    const { schemaErrors, pageErrors } = attachConsoleSchemaGuard(page);
    const tracker = await installAuthenticatedMockApi(page);

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const chooseBookBtn = page.locator("button.desk-primary");
    await expect(chooseBookBtn).toBeEnabled();
    await chooseBookBtn.click();
    await page.waitForURL(/\/books(\?|$)/);

    await expect(
      page.getByRole("heading", { name: "Chú Mèo Đi Hia" }),
    ).toBeVisible();

    const childGetCalls = tracker
      .getEvents()
      .filter(
        (e) =>
          e.method === "GET" &&
          e.path === `/profiles/children/${CHILD_ID}` &&
          e.phase === "start",
      );
    expect(childGetCalls).toHaveLength(0);
    expect(schemaErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("[M4-target] Route group consolidation for /sessions/[sessionId]/report", () => {
  test("/sessions/[sessionId]/report renders inside (app) shell", async ({
    context,
    page,
  }) => {
    await seedAuthenticatedParentContext(context);
    await installAuthenticatedMockApi(page);

    await page.goto(`/sessions/${SESSION_ID}/report`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("standalone-session-report")).toBeVisible();
    // Verify parent AppShell navigation wraps the consolidated (app) report route
    await expect(page.locator("header, nav").first()).toBeVisible();
  });
});
