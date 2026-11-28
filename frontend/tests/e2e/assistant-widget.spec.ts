import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { stringToBase64URL } from "@supabase/ssr";

import { authFixtureHeaders } from "./auth-fixture";

const API_BASE = "http://127.0.0.1:8000";
const NOW = "2026-11-27T10:00:00Z";
const PARENT_ID = "91000000-0000-4000-8000-000000000001";
const ADMIN_ID = "91000000-0000-4000-8000-000000000002";
const CHILD_ID = "92000000-0000-4000-8000-000000000001";
const CHILD_TWO_ID = "92000000-0000-4000-8000-000000000002";
const BOOK_ID = "82000000-0000-4000-8000-000000000010";
const SESSION_ID = "72000000-0000-4000-8000-000000000001";
const PAGE_1_ID = "83000000-0000-4000-8000-000000000011";
const REV_1_ID = "84000000-0000-4000-8000-000000000011";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return (
    a.x < b.x + b.width - margin &&
    a.x + a.width > b.x + margin &&
    a.y < b.y + b.height - margin &&
    a.y + a.height > b.y + margin
  );
}

function makeFakeJwt(sub: string, role: "admin" | "parent"): string {
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
  return `${header}.${payload}.synthetic-assistant-sig`;
}

async function seedAuthSession(
  context: BrowserContext,
  userId: string,
  role: "admin" | "parent",
): Promise<void> {
  const sessionPayload = {
    access_token: makeFakeJwt(userId, role),
    token_type: "bearer",
    expires_in: 36000,
    expires_at: Math.floor(Date.now() / 1000) + 36000,
    refresh_token: "synthetic-refresh-token",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: role === "admin" ? "admin@viread.local" : "parent@viread.local",
      user_metadata: { role },
      app_metadata: { provider: "email" },
      created_at: NOW,
    },
  };
  await context.addCookies([
    {
      name: "sb-example-auth-token",
      value: `base64-${stringToBase64URL(JSON.stringify(sessionPayload))}`,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await context.route("https://example.supabase.co/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionPayload.user),
    }),
  );
}

async function seedParentSession(context: BrowserContext): Promise<void> {
  await seedAuthSession(context, PARENT_ID, "parent");
}

async function openAssistantPanel(page: Page) {
  const launcher = page.getByTestId("viread-assistant-launcher");
  const panel = page.getByTestId("viread-assistant-panel");
  const loading = page.getByTestId("viread-assistant-panel-loading");
  await expect(launcher).toBeVisible();
  await expect(async () => {
    if (!(await panel.isVisible()) && !(await loading.isVisible())) {
      await launcher.click();
    }
    await expect(panel).toBeVisible({ timeout: 2_500 });
  }).toPass({ timeout: 20_000, intervals: [250, 500, 1_000] });
  return panel;
}

async function installAssistantMockApi(page: Page): Promise<void> {
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  };
  const json = (data: unknown) => ({
    status: 200,
    headers: corsHeaders,
    contentType: "application/json",
    body: JSON.stringify(data),
  });

  await page.route(`${API_BASE}/**`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    const url = new URL(route.request().url());
    const p = url.pathname;

    if (p === "/assistant/chat") {
      const reqBody = route.request().postDataJSON() as {
        message?: string;
        current_path?: string;
        bandwidth_profile?: "low" | "medium" | "high";
      };
      const msg = (reqBody?.message ?? "").toLowerCase();
      const currentPath = reqBody?.current_path ?? "/";
      if (msg.includes("thời tiết") || msg.includes("bitcoin")) {
        await route.fulfill(
          json({
            reply:
              "Trợ lý ViRead chỉ hỗ trợ hướng dẫn đọc sách và tính năng trong ViRead nhé!",
            source_tier: "tier_0_kb",
            provider_id: "viread_domain_guard",
            model_id: "grounded-viread-kb-v1",
            bandwidth_applied: reqBody?.bandwidth_profile ?? "high",
            latency_ms: 3,
            cached: false,
            role_scope: currentPath.startsWith("/admin")
              ? "admin"
              : currentPath === "/login"
                ? "public"
                : "parent",
            quick_actions: [],
            suggested_prompts: [],
          }),
        );
        return;
      }
      if (currentPath.startsWith("/admin") && msg.includes("dashboard")) {
        await route.fulfill(
          json({
            reply: "Quản trị viên chỉ làm việc trên khu vực /admin.",
            source_tier: "tier_0_kb",
            provider_id: "viread_scope_guard",
            model_id: "grounded-viread-kb-v1",
            bandwidth_applied: reqBody?.bandwidth_profile ?? "high",
            latency_ms: 4,
            cached: false,
            role_scope: "admin",
            quick_actions: [{ label: "Trang khách", href: "/dashboard" }],
            suggested_prompts: [],
            navigation_offer: {
              label: "Mở Tổng quan khách",
              href: "/dashboard",
              requires_child_selection: true,
            },
          }),
        );
        return;
      }
      if (currentPath === "/login" && msg.includes("dashboard")) {
        await route.fulfill(
          json({
            reply: "Bạn cần đăng nhập trước khi vào trang khách hàng.",
            source_tier: "tier_0_kb",
            provider_id: "viread_scope_guard",
            model_id: "grounded-viread-kb-v1",
            bandwidth_applied: reqBody?.bandwidth_profile ?? "high",
            latency_ms: 4,
            cached: false,
            role_scope: "public",
            quick_actions: [{ label: "Tổng quan", href: "/dashboard" }],
            suggested_prompts: [],
            navigation_offer: {
              label: "Mở Tổng quan",
              href: "/dashboard",
              requires_child_selection: true,
            },
          }),
        );
        return;
      }
      if (msg.includes("memory game") || msg.includes("lật thẻ")) {
        await route.fulfill(
          json({
            reply:
              "Bé có thể chơi **Memory Game lật thẻ** (`/entertainment/memory-game`) để luyện nhớ mặt chữ vui nhé!",
            source_tier: "tier_0_kb",
            provider_id: "viread_kb",
            model_id: "grounded-viread-kb-v1",
            bandwidth_applied: reqBody?.bandwidth_profile ?? "high",
            latency_ms: 18,
            cached: false,
            role_scope: "parent",
            quick_actions: [
              {
                label: "Mở Memory Game",
                href: "/entertainment/memory-game",
              },
            ],
            suggested_prompts: [],
            navigation_offer: {
              label: "Mở Memory Game lật thẻ",
              href: "/entertainment/memory-game",
              reason: "Trò chơi ghép thẻ giúp bé luyện phản xạ mặt chữ.",
              requires_child_selection: true,
              scenario_id: "memory_game",
            },
          }),
        );
        return;
      }
      if (msg.includes("kho sách") || msg.includes("chọn sách")) {
        await route.fulfill(
          json({
            reply:
              "Bạn có thể vào **Kho sách ViRead** (`/books`) để chọn truyện phù hợp cho bé nhé!",
            source_tier: "tier_0_kb",
            provider_id: "viread_kb",
            model_id: "grounded-viread-kb-v1",
            bandwidth_applied: reqBody?.bandwidth_profile ?? "high",
            latency_ms: 16,
            cached: false,
            role_scope: "parent",
            quick_actions: [{ label: "Mở Kho sách", href: "/books" }],
            suggested_prompts: [],
            navigation_offer: {
              label: "Mở Kho sách ViRead",
              href: "/books",
              reason: "Chọn sách phù hợp với lớp của bé.",
              requires_child_selection: true,
              scenario_id: "books_catalog",
            },
          }),
        );
        return;
      }
      if (msg.includes("mật khẩu")) {
        await route.fulfill(
          json({
            reply:
              "Mình sẵn sàng hỗ trợ bạn đổi mật khẩu nhé! Bạn có muốn chuyển đến trang **Cài đặt** (`/settings`) ngay không?",
            source_tier: "tier_0_kb",
            provider_id: "viread_kb",
            model_id: "grounded-viread-kb-v1",
            bandwidth_applied: reqBody?.bandwidth_profile ?? "high",
            latency_ms: 45,
            cached: false,
            role_scope: "parent",
            quick_actions: [{ label: "Mở Cài đặt", href: "/settings" }],
            suggested_prompts: [],
            navigation_offer: {
              label: "Đi đến trang Cài đặt đổi mật khẩu",
              href: "/settings",
              reason: "Đổi mật khẩu an toàn trong tài khoản của chính bạn.",
            },
          }),
        );
        return;
      }
      await route.fulfill(
        json({
          reply:
            "### Hướng dẫn ViRead\n1. Mở **Quản lý đọc** (`/reading-management`) để đặt lịch nhắc đọc.\n* *Lưu ý: kiểm tra email đã xác minh.*",
          source_tier: "tier_1_cloud",
          provider_id: "gemini_primary",
          model_id: "gemini-3.5-flash-lite",
          bandwidth_applied: reqBody?.bandwidth_profile ?? "high",
          latency_ms: 420,
          cached: false,
          role_scope: "parent",
          quick_actions: [
            { label: "Mở Quản lý đọc", href: "/reading-management" },
          ],
          suggested_prompts: ["Làm sao ôn từ khó cho bé?"],
        }),
      );
      return;
    }

    if (p === "/profiles/me") {
      await route.fulfill(
        json({
          id: PARENT_ID,
          display_name: "Phụ huynh Kiểm thử",
          email: "parent@viread.local",
          role: "parent",
          avatar_url: null,
          preferred_locale: "vi",
          created_at: NOW,
        }),
      );
      return;
    }

    if (p === "/profiles/dashboard-summary") {
      await route.fulfill(
        json({
          profile: {
            id: PARENT_ID,
            display_name: "Phụ huynh Kiểm thử",
            email: "parent@viread.local",
            role: "parent",
            avatar_url: null,
            preferred_locale: "vi",
            created_at: NOW,
          },
          children: [
            {
              id: CHILD_ID,
              parent_id: PARENT_ID,
              alias: "Bé An",
              grade: 2,
              settings: {},
              created_at: NOW,
            },
            {
              id: CHILD_TWO_ID,
              parent_id: PARENT_ID,
              alias: "Bé Bình",
              grade: 4,
              settings: {},
              created_at: NOW,
            },
          ],
          latest_sessions_by_child: {
            [CHILD_ID]: null,
            [CHILD_TWO_ID]: null,
          },
        }),
      );
      return;
    }

    if (p === "/profiles/children") {
      await route.fulfill(
        json([
          {
            id: CHILD_ID,
            parent_id: PARENT_ID,
            alias: "Bé An",
            grade: 2,
            settings: {},
            created_at: NOW,
          },
          {
            id: CHILD_TWO_ID,
            parent_id: PARENT_ID,
            alias: "Bé Bình",
            grade: 4,
            settings: {},
            created_at: NOW,
          },
        ]),
      );
      return;
    }

    if (p === `/profiles/children/${CHILD_ID}`) {
      await route.fulfill(
        json({
          id: CHILD_ID,
          parent_id: PARENT_ID,
          alias: "Bé An",
          grade: 2,
          settings: {},
          created_at: NOW,
        }),
      );
      return;
    }

    if (p === `/profiles/children/${CHILD_TWO_ID}`) {
      await route.fulfill(
        json({
          id: CHILD_TWO_ID,
          parent_id: PARENT_ID,
          alias: "Bé Bình",
          grade: 4,
          settings: {},
          created_at: NOW,
        }),
      );
      return;
    }

    if (p.startsWith("/reading-management/")) {
      await route.fulfill(json([]));
      return;
    }

    if (
      p === "/books/catalog" ||
      p === `/books/catalog/${BOOK_ID}` ||
      p === "/books" ||
      p === `/books/${BOOK_ID}`
    ) {
      const book = {
        id: BOOK_ID,
        name: "Chú mèo đi hia",
        title: "Chú mèo đi hia",
        author: "Charles Perrault",
        min_grade: 1,
        max_grade: 3,
        lifecycle_status: "ACTIVE",
      };
      await route.fulfill(
        json(p === "/books/catalog" || p === "/books" ? [book] : book),
      );
      return;
    }

    if (p === `/books/${BOOK_ID}/pages`) {
      await route.fulfill(
        json([
          {
            page_id: PAGE_1_ID,
            page_number: 1,
            lifecycle_status: "ACTIVE",
            current_verified_revision_id: REV_1_ID,
            preview_url: null,
          },
        ]),
      );
      return;
    }

    if (p === `/reading/sessions/${SESSION_ID}`) {
      await route.fulfill(
        json({
          id: SESSION_ID,
          child_id: CHILD_ID,
          book_id: BOOK_ID,
          state: "PAGE_READY",
          started_at: NOW,
          ended_at: null,
          duration_ms: null,
        }),
      );
      return;
    }

    if (p === `/reading/sessions/${SESSION_ID}/page`) {
      await route.fulfill(
        json({
          page_id: PAGE_1_ID,
          page_revision_id: REV_1_ID,
          page_number: 1,
          confidence: 0.99,
          width: 600,
          height: 800,
          image_overlay_safe: false,
          image_url: null,
          text: "Sáng sớm bé An đọc sách vui vẻ.",
          words: ["Sáng", "sớm", "bé", "An", "đọc", "sách", "vui", "vẻ."].map(
            (text, idx) => ({
              word_id: `91000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
              word_index: idx,
              text,
              bbox: [0.06 + idx * 0.1, 0.12, 0.08, 0.04],
              line_index: 0,
            }),
          ),
        }),
      );
      return;
    }

    if (p === `/reading/sessions/${SESSION_ID}/progress`) {
      await route.fulfill(
        json({
          session_id: SESSION_ID,
          persisted: true,
          start_page_id: PAGE_1_ID,
          end_page_id: PAGE_1_ID,
          current_page_id: PAGE_1_ID,
          start_page_number: 1,
          end_page_number: 1,
          current_page_number: 1,
          current_index: 0,
          total_pages: 1,
          completed_pages: 0,
          pages: [
            {
              page_id: PAGE_1_ID,
              page_revision_id: REV_1_ID,
              page_number: 1,
              page_order: 0,
              status: "IN_PROGRESS",
              started_at: NOW,
              completed_at: null,
            },
          ],
        }),
      );
      return;
    }

    if (p === `/reading/sessions/${SESSION_ID}/practice-state`) {
      await route.fulfill(
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
      await route.fulfill(
        json({
          assessment: null,
          duration_minutes: 1,
          pages_explored: 1,
          selected_range_pages: 1,
          practiced_words: 8,
          score: 100,
          correct_words: [],
          mispronounced_words: [],
          skipped_words: [],
          transcripts: [],
          spoken_words: [],
        }),
      );
      return;
    }

    if (p === "/voice/status") {
      await route.fulfill(
        json({
          default_mode: "local_only",
          default_voice_id: "local_north_truc_ly",
          local: { available: true, stt_ready: true, tts_ready: true },
          google: {
            stt_configured: false,
            tts_configured: false,
            stt_cooldown: false,
            tts_cooldown: false,
          },
        }),
      );
      return;
    }

    if (p === "/voice/voices") {
      await route.fulfill(
        json({
          default_voice_id: "local_north_truc_ly",
          voices: [
            {
              voice_id: "local_north_truc_ly",
              name: "Trúc Ly",
              gender: "female",
            },
          ],
        }),
      );
      return;
    }

    if (p.startsWith("/reading-presence/")) {
      await route.fulfill(json({ email_enabled: false, updated_at: NOW }));
      return;
    }

    if (p === "/studio/tasks") {
      await route.fulfill(
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

    if (p === "/tasks" || p.startsWith("/tasks/")) {
      await route.fulfill(json({ items: [], total: 0 }));
      return;
    }

    await route.fulfill(json({}));
  });
}

test.describe("ViRead Assistant Widget real browser geometry & E2E", () => {
  test.setTimeout(90_000);

  test("compact dimensions, hide/reload persistence, markdown rendering, and zero overlap on /dashboard, /admin/login, and /reading/*", async ({
    browser,
  }, testInfo) => {
    const isDesktop = testInfo.project.name === "desktop-chromium";
    const viewport = isDesktop
      ? { width: 1440, height: 1000 }
      : { width: 390, height: 844 };

    // 1. Public /admin/login must NOT expose any admin workspace links or prompts
    const publicContext = await browser.newContext({ viewport });
    const publicPage = await publicContext.newPage();
    await publicPage.goto("/admin/login", { waitUntil: "networkidle" });
    const publicPanel = await openAssistantPanel(publicPage);
    await expect(
      publicPanel.getByTestId("viread-assistant-role-badge"),
    ).toHaveText("Hỗ trợ Khách");
    await expect(publicPanel).toContainText("Đăng nhập Quản trị");
    const adminLinks = await publicPanel.locator('a[href^="/admin/"]').count();
    expect(adminLinks).toBe(0);
    await publicContext.close();

    // 2. Authenticated parent on /dashboard + /reading/*
    const context = await browser.newContext({
      viewport,
      extraHTTPHeaders: authFixtureHeaders("parent"),
    });
    await seedParentSession(context);
    const page = await context.newPage();
    await installAssistantMockApi(page);

    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: /Bé An/i })).toBeVisible();
    const launcher = page.getByTestId("viread-assistant-launcher");
    await expect(launcher).toBeVisible();

    // No horizontal overflow
    const dashOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(dashOverflow).toBeLessThanOrEqual(2);

    // Mobile: launcher clears MobileBottomNav cleanly
    if (!isDesktop) {
      const bottomNavBox = await page
        .getByTestId("mobile-bottom-nav")
        .boundingBox();
      const launcherBox = await launcher.boundingBox();
      expect(bottomNavBox).not.toBeNull();
      expect(launcherBox).not.toBeNull();
      expect(boxesOverlap(launcherBox!, bottomNavBox!, 1)).toBe(false);
    }

    // Open panel -> compact size <= 360px wide x 460px tall
    const panel = await openAssistantPanel(page);
    await expect(panel.getByTestId("viread-assistant-role-badge")).toHaveText(
      "Hỗ trợ Phụ huynh",
    );
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.width).toBeLessThanOrEqual(360);
    expect(panelBox!.height).toBeLessThanOrEqual(460);

    // Send prompt -> renders formatted markdown without raw ** asterisks
    await panel
      .getByLabel("Nhập câu hỏi về ViRead")
      .fill("Đặt lịch nhắc đọc thế nào?");
    await panel.getByLabel("Gửi câu hỏi").click();
    await expect(
      panel.locator("strong", { hasText: "Quản lý đọc" }),
    ).toBeVisible();
    await expect(
      panel.locator("code", { hasText: "/reading-management" }),
    ).toBeVisible();
    const panelText = await panel.textContent();
    expect(panelText).not.toContain("**");
    expect(panelText).not.toContain("###");
    await expect(
      page.getByTestId("viread-assistant-source-meta"),
    ).toContainText("Gemini");

    // Interactive Yes/No navigation confirmation: Không stays on /dashboard, Có navigates to /settings
    await panel
      .getByLabel("Nhập câu hỏi về ViRead")
      .fill("Tôi muốn đổi mật khẩu");
    await panel.getByLabel("Gửi câu hỏi").click();
    await expect(panel.getByTestId("viread-assistant-nav-card")).toBeVisible();
    await panel.getByTestId("viread-assistant-nav-no").click();
    expect(new URL(page.url()).pathname).toBe("/dashboard");
    await expect(
      panel.getByTestId("viread-assistant-nav-status"),
    ).toContainText("Đã giữ nguyên trang hiện tại");

    await panel
      .getByLabel("Nhập câu hỏi về ViRead")
      .fill("Chuyển trang đổi mật khẩu ngay");
    await panel.getByLabel("Gửi câu hỏi").click();
    await panel.getByTestId("viread-assistant-nav-yes").click();
    await page.waitForURL("**/settings");
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: /Bé An/i })).toBeVisible();
    await openAssistantPanel(page);

    // Hide assistant -> persists across reload -> restore via edge tab
    await page.getByTestId("viread-assistant-hide").click();
    await expect(page.getByTestId("viread-assistant-hidden-tab")).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("viread-assistant-hidden-tab")).toBeVisible();
    await expect(
      page.getByTestId("viread-assistant-launcher"),
    ).not.toBeVisible();
    await page
      .getByTestId("viread-assistant-hidden-tab")
      .locator("button")
      .click();
    await expect(page.getByTestId("viread-assistant-launcher")).toBeVisible();

    // 3. Active reading route: ZERO overlap with header, reading topBar, pageOptions, or dock
    await page.goto(`/reading/${SESSION_ID}?state=reading`, {
      waitUntil: "networkidle",
    });
    await expect(page.locator('[data-reading-shell="true"]')).toBeVisible({
      timeout: 20_000,
    });
    const readingWrap = page.getByTestId("viread-assistant-launcher-wrap");
    await expect(readingWrap).toBeVisible();

    const wrapBox = await readingWrap.boundingBox();
    const headerBox = await page
      .locator('[data-reading-shell="true"] header')
      .first()
      .boundingBox();
    const topBarBox = await page
      .locator('[data-reading-topbar="true"]')
      .boundingBox();
    const dockBox = await page
      .locator('[data-reading-dock="true"]')
      .boundingBox();

    expect(wrapBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(topBarBox).not.toBeNull();
    expect(dockBox).not.toBeNull();

    expect(wrapBox!.width).toBeLessThanOrEqual(44);
    expect(boxesOverlap(wrapBox!, headerBox!, 1)).toBe(false);
    expect(boxesOverlap(wrapBox!, topBarBox!, 1)).toBe(false);
    expect(boxesOverlap(wrapBox!, dockBox!, 1)).toBe(false);

    // 4. RTL Arabic locale: zero overflow and widget aligns to logical end (left edge)
    await context.addCookies([
      {
        name: "viread_locale",
        value: "ar",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const rtlOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(rtlOverflow).toBeLessThanOrEqual(2);
    const rtlLauncherBox = await page
      .getByTestId("viread-assistant-launcher")
      .boundingBox();
    expect(rtlLauncherBox).not.toBeNull();
    // Logical `end` in RTL places widget on the left half of the viewport
    expect(rtlLauncherBox!.x).toBeLessThan(viewport.width / 2);

    await context.close();
  });

  test("soft child-selection gate inside chatbot lets parent pick a child and reach /books and /entertainment/memory-game without /dashboard redirect", async ({
    browser,
  }, testInfo) => {
    const isDesktop = testInfo.project.name === "desktop-chromium";
    const viewport = isDesktop
      ? { width: 1440, height: 1000 }
      : { width: 390, height: 844 };

    const context = await browser.newContext({
      viewport,
      extraHTTPHeaders: authFixtureHeaders("parent"),
    });
    await seedParentSession(context);
    const page = await context.newPage();
    await installAssistantMockApi(page);

    // 1. Start on /dashboard with NO child selected -> ask for Kho sách -> click Yes -> pick Bé An -> lands on /books
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      window.sessionStorage.clear();
    });
    const panel = await openAssistantPanel(page);

    await panel.getByLabel("Nhập câu hỏi về ViRead").fill("Mở kho sách cho bé");
    await panel.getByLabel("Gửi câu hỏi").click();

    await expect(panel.getByTestId("viread-assistant-nav-card")).toBeVisible();
    await expect(
      panel.getByTestId("viread-assistant-child-required-notice"),
    ).toBeVisible();
    await panel.getByTestId("viread-assistant-nav-yes").click();

    // Soft child-picker appears inside chatbot while staying on /dashboard
    const picker = panel.getByTestId("viread-assistant-child-picker");
    await expect(picker).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/dashboard");

    await picker
      .getByTestId(`viread-assistant-select-child-${CHILD_ID}`)
      .click();
    await page.waitForURL("**/books");
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).pathname).toBe("/books");
    await expect(
      page.getByRole("heading", { name: "Chú mèo đi hia" }),
    ).toBeVisible({
      timeout: 15_000,
    });

    // 2. Clear selected child in a fresh reload on /dashboard -> ask for Memory Game -> pick Bé Bình -> lands on /entertainment/memory-game
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      window.sessionStorage.clear();
    });
    await page.reload({ waitUntil: "networkidle" });

    const panel2 = await openAssistantPanel(page);
    await panel2
      .getByLabel("Nhập câu hỏi về ViRead")
      .fill("Bé muốn chơi Memory Game lật thẻ");
    await panel2.getByLabel("Gửi câu hỏi").click();
    await panel2.getByTestId("viread-assistant-nav-yes").click();

    const picker2 = panel2.getByTestId("viread-assistant-child-picker");
    await expect(picker2).toBeVisible();
    await picker2
      .getByTestId(`viread-assistant-select-child-${CHILD_TWO_ID}`)
      .click();
    await page.waitForURL("**/entertainment/memory-game");
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).pathname).toBe("/entertainment/memory-game");

    await context.close();
  });

  test("enforces role badges, Admin/Parent/Guest route isolation, role-switch history reset, and ViRead-only off-topic refusal", async ({
    browser,
  }, testInfo) => {
    const isDesktop = testInfo.project.name === "desktop-chromium";
    const viewport = isDesktop
      ? { width: 1440, height: 1000 }
      : { width: 390, height: 844 };

    // 1. Guest on /login: "Hỗ trợ Khách" badge, ViRead-only off-topic refusal, blocks /dashboard
    const guestContext = await browser.newContext({ viewport });
    const guestPage = await guestContext.newPage();
    await installAssistantMockApi(guestPage);
    await guestPage.goto("/login", { waitUntil: "networkidle" });
    const guestPanel = await openAssistantPanel(guestPage);
    await expect(
      guestPanel.getByTestId("viread-assistant-role-badge"),
    ).toHaveText("Hỗ trợ Khách");

    await guestPanel
      .getByLabel("Nhập câu hỏi về ViRead")
      .fill("Thời tiết Hà Nội hôm nay thế nào?");
    await guestPanel.getByLabel("Gửi câu hỏi").click();
    await expect(guestPanel).toContainText("chỉ hỗ trợ hướng dẫn đọc sách");

    await guestPanel
      .getByLabel("Nhập câu hỏi về ViRead")
      .fill("Mở dashboard phụ huynh");
    await guestPanel.getByLabel("Gửi câu hỏi").click();
    await expect(guestPanel).toContainText("cần đăng nhập trước");
    expect(await guestPanel.locator('a[href="/dashboard"]').count()).toBe(0);
    await expect(
      guestPanel.getByTestId("viread-assistant-nav-card"),
    ).toHaveCount(0);
    await guestContext.close();

    // 2. Parent on /dashboard -> SPA nav to /settings preserves history; switching to /login (public) clears history
    const parentContext = await browser.newContext({
      viewport,
      extraHTTPHeaders: authFixtureHeaders("parent"),
    });
    await seedParentSession(parentContext);
    const parentPage = await parentContext.newPage();
    await installAssistantMockApi(parentPage);
    await parentPage.goto("/dashboard", { waitUntil: "networkidle" });
    const parentPanel = await openAssistantPanel(parentPage);
    await expect(
      parentPanel.getByTestId("viread-assistant-role-badge"),
    ).toHaveText("Hỗ trợ Phụ huynh");

    await parentPanel
      .getByLabel("Nhập câu hỏi về ViRead")
      .fill("Tôi muốn đổi mật khẩu");
    await parentPanel.getByLabel("Gửi câu hỏi").click();
    await expect(
      parentPanel.getByTestId("viread-assistant-nav-card"),
    ).toBeVisible();
    await parentPanel.getByTestId("viread-assistant-nav-yes").click();
    await parentPage.waitForURL("**/settings");
    await expect(
      parentPanel.getByTestId("viread-assistant-role-badge"),
    ).toHaveText("Hỗ trợ Phụ huynh");
    await expect(parentPanel).toContainText("Tôi muốn đổi mật khẩu");

    await parentPage.goto("/login", { waitUntil: "networkidle" });
    const switchedPublicPanel = await openAssistantPanel(parentPage);
    await expect(
      switchedPublicPanel.getByTestId("viread-assistant-role-badge"),
    ).toHaveText("Hỗ trợ Khách");
    await expect(switchedPublicPanel).not.toContainText(
      "Tôi muốn đổi mật khẩu",
    );
    await parentContext.close();

    // 3. Admin on /admin/health: "Hỗ trợ Quản trị" badge, blocks customer /dashboard, never shows child-picker
    const adminContext = await browser.newContext({
      viewport,
      extraHTTPHeaders: authFixtureHeaders("admin"),
    });
    await seedAuthSession(adminContext, ADMIN_ID, "admin");
    const adminPage = await adminContext.newPage();
    await installAssistantMockApi(adminPage);
    await adminPage.goto("/admin/health", { waitUntil: "networkidle" });
    const adminPanel = await openAssistantPanel(adminPage);
    await expect(
      adminPanel.getByTestId("viread-assistant-role-badge"),
    ).toHaveText("Hỗ trợ Quản trị");

    await adminPanel
      .getByLabel("Nhập câu hỏi về ViRead")
      .fill("Mở dashboard phụ huynh");
    await adminPanel.getByLabel("Gửi câu hỏi").click();
    await expect(adminPanel).toContainText("khu vực /admin");
    expect(await adminPanel.locator('a[href="/dashboard"]').count()).toBe(0);
    await expect(
      adminPanel.getByTestId("viread-assistant-nav-card"),
    ).toHaveCount(0);
    await expect(
      adminPanel.getByTestId("viread-assistant-active-child-badge"),
    ).toHaveCount(0);
    await expect(
      adminPanel.getByTestId("viread-assistant-child-picker"),
    ).toHaveCount(0);
    await adminContext.close();
  });
});
