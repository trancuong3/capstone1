import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { stringToBase64URL } from "@supabase/ssr";

import { createPlaywrightAuthFixtureHeaders } from "@/lib/auth/playwright-auth-fixture";
import { authFixtureHeaders } from "./auth-fixture";

const API_BASE = "http://127.0.0.1:8000";
const NOW = "2026-11-27T10:00:00.000Z";
// Must match lib/auth/server-authorization.ts Playwright fixture identities.
const ADMIN_ID = "88000000-0000-4000-8000-000000000001";
const PARENT_A_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_B_ID = "22222222-2222-4222-8222-222222222222";
const CHILD_ID = "33333333-3333-4333-8333-333333333333";
const ADMIN_BOOK_ID = "44444444-4444-4444-8444-444444444441";
const ADMIN_PAGE_ID = "44444444-4444-4444-8444-444444444442";
const PARENT_BOOK_ID = "55555555-5555-4555-8555-555555555551";
const PARENT_B_BOOK_ID = "55555555-5555-4555-8555-555555555552";

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
  return `${header}.${payload}.synthetic-e2e-signature`;
}

async function seedBrowserSession(
  context: BrowserContext,
  role: "admin" | "parent",
  userId: string,
) {
  const accessToken = makeFakeJwt(userId, role);
  const sessionPayload = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 36000,
    expires_at: Math.floor(Date.now() / 1000) + 36000,
    refresh_token: "synthetic-refresh-token",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${role}@viread.local`,
      user_metadata: { role },
      app_metadata: { provider: "email" },
      created_at: NOW,
    },
  };
  const encoded = `base64-${stringToBase64URL(JSON.stringify(sessionPayload))}`;
  await context.addCookies([
    {
      name: "sb-example-auth-token",
      value: encoded,
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

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "66666666-6666-4666-8666-666666666601",
    source: "smart_studio_job",
    job_type: "OCR_EXTRACT",
    title_vi: "Nhận diện chữ OCR",
    book_id: ADMIN_BOOK_ID,
    book_page_id: ADMIN_PAGE_ID,
    book_title: "Sách Danh Mục Chung",
    page_number: 2,
    source_revision_id: null,
    actor_id: ADMIN_ID,
    actor_role: "admin",
    portal: "admin",
    status: "RUNNING",
    status_label_vi: "Đang xử lý",
    stage: "OCR",
    stage_label_vi: "Nhận diện chữ (OCR)",
    priority: 50,
    attempt_count: 1,
    max_attempts: 3,
    progress_completed: 9,
    progress_total: 20,
    progress_unit: "trang",
    progress_pct: 45,
    progress_mode: "measured",
    is_indeterminate: false,
    can_retry: false,
    can_cancel: true,
    result_href: `/admin/books/${ADMIN_BOOK_ID}`,
    result_ref: {},
    checkpoints: {},
    error_code: null,
    error_message_vi: null,
    created_at: NOW,
    updated_at: NOW,
    started_at: NOW,
    completed_at: null,
    ...overrides,
  };
}

function attachPageErrorMonitor(page: Page) {
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("response", (res) => {
    if (res.status() >= 500) {
      serverErrors.push(`${res.status()} ${res.url()}`);
    }
  });
  return {
    assertNoErrors() {
      expect(pageErrors, "Unexpected uncaught page errors").toEqual([]);
      expect(serverErrors, "Unexpected HTTP 5xx responses").toEqual([]);
    },
  };
}

test.describe("AI Task Center portal isolation & percentage progress bars", () => {
  test("Admin portal uses /studio/admin/tasks exclusively, strips leaked parent tasks, shows % progress bars, and has zero cross-role filters", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: authFixtureHeaders("admin"),
    });
    await seedBrowserSession(context, "admin", ADMIN_ID);

    const studioUrls: string[] = [];
    await context.route(`${API_BASE}/**`, async (route) => {
      const url = route.request().url();
      const pathname = new URL(url).pathname;

      if (pathname.startsWith("/studio/")) {
        studioUrls.push(pathname);
      }

      if (pathname === "/studio/admin/tasks") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            actor_id: ADMIN_ID,
            actor_role: "admin",
            portal: "admin",
            active_count: 3,
            waiting_review_count: 0,
            failed_count: 0,
            completed_count: 0,
            worker_online: true,
            recommended_poll_ms: 15000,
            tasks: [
              makeTask({
                id: "77777777-7777-4777-8777-777777777701",
                job_type: "BATCH_BOOK_IMPORT",
                title_vi: "Nhập sách PDF kho chung",
                book_id: ADMIN_BOOK_ID,
                book_title: "Truyện Cổ Tích Kho Chung",
                progress_completed: 9,
                progress_total: 20,
                progress_unit: "trang",
                progress_pct: 45,
                progress_mode: "measured",
                is_indeterminate: false,
              }),
              makeTask({
                id: "77777777-7777-4777-8777-777777777702",
                job_type: "COVER_GENERATE",
                title_vi: "Tạo bìa sách kho chung bằng AI",
                book_id: ADMIN_BOOK_ID,
                book_title: "Truyện Cổ Tích Kho Chung",
                progress_completed: null,
                progress_total: null,
                progress_unit: null,
                progress_pct: 75,
                progress_mode: "measured",
                is_indeterminate: false,
              }),
              // Intentionally leaked Parent task -> MUST be stripped by sanitizeScopedTaskFeed!
              makeTask({
                id: "77777777-7777-4777-8777-777777777799",
                title_vi: "Tác vụ phụ huynh bị rò rỉ",
                book_id: PARENT_BOOK_ID,
                book_title: "Sách Riêng Phụ Huynh Bị Rò Rỉ",
                actor_id: PARENT_A_ID,
                actor_role: "parent",
                portal: "parent",
                result_href: `/my-books/${PARENT_BOOK_ID}`,
              }),
            ],
          }),
        });
        return;
      }

      if (pathname === "/health") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "ok",
            ocr: {
              ready: true,
              mode: "remote_worker",
              workers: [{ online: true }],
            },
          }),
        });
        return;
      }

      if (pathname === "/books/admin/catalog") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([]),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });

    const page = await context.newPage();
    const monitor = attachPageErrorMonitor(page);

    // 1) Visit dedicated Admin tasks page
    await page.goto("/admin/tasks");
    const tasksPage = page.getByTestId("studio-tasks-page");
    await expect(tasksPage).toBeVisible();
    await expect(tasksPage).toHaveAttribute("data-portal", "admin");
    await expect(
      page.getByRole("heading", { name: "Tác vụ AI quản trị" }),
    ).toBeVisible();
    await expect(page.getByTestId("studio-tasks-scope-badge")).toContainText(
      "Không gian quản trị",
    );

    // Verify both Admin tasks render with progressbar & visible %
    const row1 = page.getByTestId(
      "studio-task-row-77777777-7777-4777-8777-777777777701",
    );
    await expect(row1).toBeVisible();
    await expect(row1).toContainText("45%");
    await expect(row1.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "45",
    );

    const row2 = page.getByTestId(
      "studio-task-row-77777777-7777-4777-8777-777777777702",
    );
    await expect(row2).toBeVisible();
    await expect(row2).toContainText("75%");
    await expect(row2.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "75",
    );

    // Leaked parent task and cross-role filters MUST NOT exist!
    await expect(page.getByText("Sách Riêng Phụ Huynh Bị Rò Rỉ")).toHaveCount(
      0,
    );
    await expect(page.getByText("Tất cả vai trò")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Phụ huynh", exact: true }),
    ).toHaveCount(0);
    await expect(tasksPage.locator('a[href^="/my-books"]')).toHaveCount(0);

    // Confirm no infinite refresh loop after settling
    await page.waitForTimeout(350);
    expect(
      studioUrls.filter((u) => u === "/studio/admin/tasks").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      studioUrls.filter((u) => u === "/studio/admin/tasks").length,
    ).toBeLessThanOrEqual(3);
    expect(
      studioUrls.filter((u) => u.includes("/studio/parent/tasks")),
    ).toEqual([]);

    // 2) Verify Admin sidebar trigger button & drawer on /admin/books
    await page.goto("/admin/books");
    const trigger = page.getByTestId("global-task-center-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("data-portal", "admin");
    await expect(trigger).toContainText("AI đang chạy (2)");
    await expect(trigger).toContainText("45%");

    await trigger.click();
    const drawer = page.getByTestId("global-task-center-panel");
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("data-portal", "admin");
    await expect(drawer).toContainText("Tác vụ AI quản trị");
    await expect(drawer).toContainText("45%");
    await expect(drawer).toContainText("75%");
    await expect(drawer).not.toContainText("Sách Riêng Phụ Huynh Bị Rò Rỉ");
    await expect(
      drawer.getByTestId("global-task-center-full-page-link"),
    ).toHaveAttribute("href", "/admin/tasks");

    expect(
      studioUrls.filter((u) => u.includes("/studio/parent/tasks")),
    ).toEqual([]);
    monitor.assertNoErrors();
    await context.close();
  });

  test("Parent portal uses /studio/parent/tasks exclusively, strips Admin & Parent B leaks, shows % progress bars, and has zero /admin links", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: authFixtureHeaders("parent"),
    });
    await seedBrowserSession(context, "parent", PARENT_A_ID);

    const studioUrls: string[] = [];
    await context.route(`${API_BASE}/**`, async (route) => {
      const url = route.request().url();
      const pathname = new URL(url).pathname;

      if (pathname.startsWith("/studio/")) {
        studioUrls.push(pathname);
      }

      if (pathname === "/studio/parent/tasks") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            actor_id: PARENT_A_ID,
            actor_role: "parent",
            portal: "parent",
            active_count: 3,
            waiting_review_count: 0,
            failed_count: 0,
            completed_count: 0,
            worker_online: true,
            recommended_poll_ms: 15000,
            tasks: [
              makeTask({
                id: "88888888-8888-4888-8888-888888888801",
                job_type: "OCR_EXTRACT",
                title_vi: "Kiểm tra trang sách gia đình A",
                book_id: PARENT_BOOK_ID,
                book_page_id: null,
                book_title: "Nhật Ký Mèo Con Gia Đình A",
                actor_id: PARENT_A_ID,
                actor_role: "parent",
                portal: "parent",
                progress_completed: 3,
                progress_total: 5,
                progress_unit: "trang",
                progress_pct: 60,
                progress_mode: "measured",
                is_indeterminate: false,
                result_href: `/my-books/${PARENT_BOOK_ID}`,
              }),
              // Intentionally leaked Admin task -> MUST be stripped by sanitizeScopedTaskFeed!
              makeTask({
                id: "88888888-8888-4888-8888-888888888891",
                title_vi: "Tác vụ quản trị bị rò rỉ",
                book_id: ADMIN_BOOK_ID,
                book_title: "Sách Kho Quản Trị Bị Rò Rỉ",
                actor_id: ADMIN_ID,
                actor_role: "admin",
                portal: "admin",
                result_href: `/admin/books/${ADMIN_BOOK_ID}`,
              }),
              // Intentionally leaked Parent B task -> MUST be stripped by sanitizeScopedTaskFeed!
              makeTask({
                id: "88888888-8888-4888-8888-888888888892",
                title_vi: "Tác vụ phụ huynh B bị rò rỉ",
                book_id: PARENT_B_BOOK_ID,
                book_title: "Sách Riêng Gia Đình B",
                actor_id: PARENT_B_ID,
                actor_role: "parent",
                portal: "parent",
                result_href: `/my-books/${PARENT_B_BOOK_ID}`,
              }),
            ],
          }),
        });
        return;
      }

      if (pathname === "/profiles/dashboard-summary") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            profile: {
              id: PARENT_A_ID,
              display_name: "Phụ huynh A",
              role: "parent",
              email: "parent@viread.local",
              created_at: NOW,
            },
            children: [
              {
                id: CHILD_ID,
                alias: "Bé Mèo",
                grade: 2,
                created_at: NOW,
              },
            ],
            latest_sessions_by_child: {},
          }),
        });
        return;
      }

      if (pathname === "/profiles/me") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: PARENT_A_ID,
            display_name: "Phụ huynh A",
            role: "parent",
            email: "parent@viread.local",
            created_at: NOW,
          }),
        });
        return;
      }

      if (pathname === "/profiles/children") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              id: CHILD_ID,
              alias: "Bé Mèo",
              grade: 2,
              created_at: NOW,
            },
          ]),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });

    const page = await context.newPage();
    const monitor = attachPageErrorMonitor(page);

    await page.goto("/studio/tasks");
    const tasksPage = page.getByTestId("studio-tasks-page");
    await expect(tasksPage).toBeVisible();
    await expect(tasksPage).toHaveAttribute("data-portal", "parent");
    await expect(
      page.getByRole("heading", { name: "Tác vụ AI của tôi" }),
    ).toBeVisible();
    await expect(page.getByTestId("studio-tasks-scope-badge")).toContainText(
      "Không gian phụ huynh",
    );

    // Parent A's own task renders with progressbar & 60%
    const parentRow = page.getByTestId(
      "studio-task-row-88888888-8888-4888-8888-888888888801",
    );
    await expect(parentRow).toBeVisible();
    await expect(parentRow).toContainText("Nhật Ký Mèo Con Gia Đình A");
    await expect(parentRow).toContainText("60%");
    await expect(parentRow.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "60",
    );

    // Both leaked tasks (Admin & Parent B) MUST be stripped!
    await expect(page.getByText("Sách Kho Quản Trị Bị Rò Rỉ")).toHaveCount(0);
    await expect(page.getByText("Sách Riêng Gia Đình B")).toHaveCount(0);

    // Zero cross-role filter buttons & zero /admin links
    await expect(page.getByText("Tất cả vai trò")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Quản trị", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);

    // Open Parent drawer from the account menu (PR #226 moved parent task trigger into ParentAccountDropdown)
    // and verify Parent-only scope, 60% progress bar, and /studio/tasks link
    const accountMenuTrigger = page.getByRole("button", {
      name: "Mở menu tài khoản",
    });
    await expect(accountMenuTrigger).toBeVisible();
    await accountMenuTrigger.click();
    const menuTaskTrigger = page.getByTestId("menu-ai-tasks-trigger");
    await expect(menuTaskTrigger).toBeVisible();
    await menuTaskTrigger.click();

    const drawer = page.getByTestId("global-task-center-panel");
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("data-portal", "parent");
    await expect(drawer).toContainText("Tác vụ AI của tôi");
    await expect(drawer).toContainText("60%");
    await expect(drawer).not.toContainText("Sách Kho Quản Trị Bị Rò Rỉ");
    await expect(drawer).not.toContainText("Sách Riêng Gia Đình Bị Rò Rỉ");
    await expect(drawer).not.toContainText("Sách Riêng Gia Đình B");
    await expect(
      drawer.getByTestId("global-task-center-full-page-link"),
    ).toHaveAttribute("href", "/studio/tasks");

    expect(
      studioUrls.filter((u) => u === "/studio/parent/tasks").length,
    ).toBeGreaterThanOrEqual(1);
    expect(studioUrls.filter((u) => u.includes("/studio/admin/tasks"))).toEqual(
      [],
    );

    monitor.assertNoErrors();
    await context.close();
  });

  test("Public /admin/login never mounts the AI Task Center button or drawer and never fetches tasks", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: createPlaywrightAuthFixtureHeaders(
        "parent",
        "guest-token-is-deliberately-invalid".repeat(2),
      ),
    });

    const studioUrls: string[] = [];
    await context.route(`${API_BASE}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith("/studio/")) {
        studioUrls.push(pathname);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });

    const page = await context.newPage();
    const monitor = attachPageErrorMonitor(page);

    await page.goto("/admin/login");
    await expect(
      page.getByRole("heading", { name: /Đăng nhập quản trị/i }),
    ).toBeVisible();

    await expect(page.getByTestId("global-task-center-trigger")).toHaveCount(0);
    await expect(page.getByTestId("global-task-center-panel")).toHaveCount(0);
    await expect(page.getByText("Trung tâm tác vụ AI")).toHaveCount(0);
    await expect(page.getByText("Tác vụ AI quản trị")).toHaveCount(0);

    await page.waitForTimeout(250);
    expect(studioUrls).toEqual([]);
    monitor.assertNoErrors();
    await context.close();
  });
});
