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
    error_code: null as string | null,
    error_message_vi: null as string | null,
    created_at: NOW,
    updated_at: NOW,
    started_at: NOW,
    completed_at: null as string | null,
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

  test("Admin GlobalTaskCenter clears warnings after reading/interacting, persists across reload, and re-alerts only on new or updated warnings", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: authFixtureHeaders("admin"),
    });
    await seedBrowserSession(context, "admin", ADMIN_ID);

    const failTaskId = "91111111-1111-4111-8111-111111111101";
    const reviewTaskId = "91111111-1111-4111-8111-111111111102";
    const newReviewTaskId = "91111111-1111-4111-8111-111111111103";

    let adminTasks = [
      makeTask({
        id: failTaskId,
        title_vi: "Nhận diện chữ trang kho chung",
        status: "FAILED",
        status_label_vi: "Xử lý thất bại",
        stage: "FAILED",
        stage_label_vi: "Gặp lỗi",
        attempt_count: 1,
        progress_pct: 0,
        can_retry: true,
        can_cancel: false,
        error_code: "OCR_TIMEOUT",
        error_message_vi: "Hết thời gian nhận diện trang.",
        updated_at: "2026-11-28T10:00:00.000Z",
        completed_at: "2026-11-28T10:00:00.000Z",
      }),
      makeTask({
        id: reviewTaskId,
        source: "admin_ai_workflow",
        job_type: "ADMIN_AI_WORKFLOW",
        title_vi: "Soát lỗi AI & Kiểm tra an toàn",
        status: "WAITING_FOR_REVIEW",
        status_label_vi: "Cần xác minh",
        stage: "WAITING_FOR_REVIEW",
        stage_label_vi: "Chờ người dùng xác minh",
        attempt_count: 1,
        progress_pct: 100,
        can_retry: false,
        can_cancel: false,
        updated_at: "2026-11-28T10:00:10.000Z",
      }),
    ];

    const buildAdminFeed = () => ({
      actor_id: ADMIN_ID,
      actor_role: "admin",
      portal: "admin",
      active_count: adminTasks.filter((t) =>
        ["QUEUED", "RUNNING", "WAITING_FOR_WORKER"].includes(String(t.status)),
      ).length,
      waiting_review_count: adminTasks.filter(
        (t) => t.status === "WAITING_FOR_REVIEW",
      ).length,
      failed_count: adminTasks.filter((t) => t.status === "FAILED").length,
      completed_count: adminTasks.filter((t) => t.status === "SUCCEEDED")
        .length,
      worker_online: true,
      recommended_poll_ms: 15000,
      tasks: adminTasks,
    });

    await context.route(`${API_BASE}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;

      if (pathname === "/studio/admin/tasks") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(buildAdminFeed()),
        });
        return;
      }

      if (
        (pathname === `/studio/admin/tasks/${failTaskId}/retry` ||
          pathname === `/studio/tasks/${failTaskId}/retry`) &&
        route.request().method() === "POST"
      ) {
        const retriedTask = makeTask({
          id: failTaskId,
          title_vi: "Nhận diện chữ trang kho chung",
          status: "RUNNING",
          status_label_vi: "Đang xử lý",
          stage: "OCR",
          stage_label_vi: "Nhận diện chữ (OCR)",
          attempt_count: 2,
          progress_completed: 2,
          progress_total: 4,
          progress_unit: "trang",
          progress_pct: 50,
          can_retry: false,
          can_cancel: true,
          error_code: null,
          error_message_vi: null,
          updated_at: "2026-11-28T10:01:00.000Z",
          completed_at: null,
        });
        adminTasks = [retriedTask, adminTasks[1]];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            task: retriedTask,
            action: "retried",
            deduplicated: false,
            message_vi: "Đã xếp lịch chạy lại.",
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

    // 1) Initial load shows unread FAILED warning on Admin AI taskbar.
    await page.goto("/admin/books");
    const trigger = page.getByTestId("global-task-center-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("Tác vụ lỗi (1)");
    await expect(trigger).toHaveClass(/bg-red-50/);

    // 2) Opening the drawer to read clears both FAILED & WAITING_FOR_REVIEW warnings immediately.
    await trigger.click();
    const drawer = page.getByTestId("global-task-center-panel");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId(`task-card-${failTaskId}`)).toBeVisible();
    await expect(trigger).toContainText("Tác vụ AI");
    await expect(trigger).not.toContainText("Tác vụ lỗi");
    await expect(trigger).not.toContainText("Cần xác minh");
    await expect(trigger).not.toHaveClass(/bg-red-50/);
    await expect(trigger).not.toHaveClass(/bg-amber-50/);
    await expect(
      page.getByTestId("global-task-center-sidebar-count"),
    ).toHaveCount(0);

    // 3) Clicking Retry transitions taskbar to active running state (which stays visible after closing drawer).
    await drawer
      .getByTestId(`task-card-${failTaskId}`)
      .getByRole("button", { name: "Thử lại" })
      .click();
    await expect(trigger).toContainText("AI đang chạy (1)");
    await drawer
      .getByRole("button", { name: "Đóng trung tâm tác vụ AI" })
      .click();
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toContainText("AI đang chạy (1)");

    // 4) Retry attempt 2 fails again -> warning MUST re-alert!
    adminTasks = [
      makeTask({
        id: failTaskId,
        title_vi: "Nhận diện chữ trang kho chung",
        status: "FAILED",
        status_label_vi: "Xử lý thất bại",
        stage: "FAILED",
        stage_label_vi: "Gặp lỗi",
        attempt_count: 2,
        progress_pct: 0,
        can_retry: true,
        can_cancel: false,
        error_code: "OCR_TIMEOUT",
        error_message_vi: "Thử lại lần 2 vẫn lỗi.",
        updated_at: "2026-11-28T10:02:00.000Z",
        completed_at: "2026-11-28T10:02:00.000Z",
      }),
      adminTasks[1],
    ];
    await page.reload();
    await expect(trigger).toContainText("Tác vụ lỗi (1)");
    await expect(trigger).toHaveClass(/bg-red-50/);

    // 5) Read updated failure via drawer, close, and reload -> MUST persist suppressed across page.reload()!
    await trigger.click();
    await expect(drawer).toBeVisible();
    await expect(trigger).toContainText("Tác vụ AI");
    await drawer
      .getByRole("button", { name: "Đóng trung tâm tác vụ AI" })
      .click();
    await expect(drawer).toHaveCount(0);

    await page.reload();
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("Tác vụ AI");
    await expect(trigger).not.toContainText("Tác vụ lỗi");
    await expect(trigger).not.toContainText("Cần xác minh");
    await expect(trigger).not.toHaveClass(/bg-red-50/);
    await expect(trigger).not.toHaveClass(/bg-amber-50/);
    await expect(
      page.getByTestId("global-task-center-sidebar-count"),
    ).toHaveCount(0);

    // 6) Brand-new WAITING_FOR_REVIEW task arrives -> MUST re-alert with amber warning!
    adminTasks = [
      ...adminTasks,
      makeTask({
        id: newReviewTaskId,
        source: "admin_ai_workflow",
        job_type: "ADMIN_AI_WORKFLOW",
        title_vi: "Soát lỗi AI & Kiểm tra an toàn",
        status: "WAITING_FOR_REVIEW",
        status_label_vi: "Cần xác minh",
        stage: "WAITING_FOR_REVIEW",
        stage_label_vi: "Chờ người dùng xác minh",
        attempt_count: 1,
        progress_pct: 100,
        can_retry: false,
        can_cancel: false,
        updated_at: "2026-11-28T10:05:00.000Z",
      }),
    ];
    await page.reload();
    await expect(trigger).toContainText("Cần xác minh (1)");
    await expect(trigger).toHaveClass(/bg-amber-50/);

    // 7) Visiting /admin/tasks directly acknowledges the new warning & persists across reload.
    await page.goto("/admin/tasks");
    await expect(
      page.getByTestId(`studio-task-row-${newReviewTaskId}`),
    ).toBeVisible();
    await expect(trigger).toContainText("Tác vụ AI");
    await page.reload();
    await expect(trigger).toContainText("Tác vụ AI");
    await expect(trigger).not.toHaveClass(/bg-amber-50/);

    monitor.assertNoErrors();
    await context.close();
  });

  test("ParentAccountDropdown suppresses warnings after direct /my-books actions and drawer reading, persists across reload, and re-alerts on new/updated warnings", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: authFixtureHeaders("parent"),
    });
    await seedBrowserSession(context, "parent", PARENT_A_ID);

    const subReadyId = "92222222-2222-4222-8222-222222222201";
    const subFailId = "92222222-2222-4222-8222-222222222202";
    const subNewReviewId = "92222222-2222-4222-8222-222222222203";
    const batchId = "92222222-2222-4222-8222-222222222210";
    const committedPageId = "92222222-2222-4222-8222-222222222220";
    const committedRevId = "92222222-2222-4222-8222-222222222221";
    const hash1 = "1".repeat(64);
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6pYAAAAASUVORK5CYII=",
      "base64",
    );

    const makeParentSubmissionDto = (
      overrides: Record<string, unknown> = {},
    ) => ({
      id: subReadyId,
      book_id: PARENT_BOOK_ID,
      batch_id: batchId,
      batch_total_pages: 2,
      source_page_number: 1,
      target_page_number: 1,
      source_file_name: "trang-1.png",
      source_format: "IMAGE",
      image_width: 400,
      image_height: 300,
      image_url: `${API_BASE}/books/my-books/${PARENT_BOOK_ID}/submissions/${overrides.id ?? subReadyId}/image`,
      source_type: "OWNED_PHYSICAL_BOOK",
      source_type_label: "Sách giấy gia đình sở hữu",
      source_note: "Sách nhà bé",
      submission_version: 1,
      optimistic_lock_version: 1,
      workflow_status: "PASSED_READY_TO_ADD",
      workflow_status_label: "Đạt — sẵn sàng thêm vào sách",
      ocr_status: "COMPLETED",
      ocr_text: "Ngày xửa ngày xưa có chú mèo con.",
      ocr_error_code: null,
      is_image_only: false,
      proofread_status: "COMPLETED",
      proofread_text: "Ngày xửa ngày xưa có chú mèo con.",
      proofread_suggestions: [],
      uncertain_word_indices: [],
      proofread_error_code: null,
      spelling_accepted: true,
      candidate_text: "Ngày xửa ngày xưa có chú mèo con.",
      candidate_hash: hash1,
      tool_check_status: "PASSED",
      tool_check_suitability: "SUITABLE",
      tool_check_scope: {
        modality: "TEXT_ONLY",
        covers_all_chunks: true,
        chunks_checked: 1,
        total_chunks: 1,
        image_visual_safety_checked: false,
        requires_admin_visual_review: false,
        copyright_scanner_status: "NOT_CONFIGURED",
        local_ai_enforced: true,
      },
      tool_check_findings_count: 0,
      tool_check_parent_notice: null,
      tool_check_policy_blocked: false,
      tool_check_workflow_id: null,
      tool_check_error_code: null,
      provider_events: [],
      can_add_to_book: true,
      can_request_admin_review: false,
      can_retry: false,
      admin_decision: null,
      admin_decision_reason: null,
      approved_snapshot_hash: null,
      approved_submission_version: null,
      committed_page_id: null,
      committed_revision_id: null,
      created_at: NOW,
      updated_at: "2026-11-28T09:00:00.000Z",
      ...overrides,
    });

    let bookDetail = {
      book: {
        id: PARENT_BOOK_ID,
        title: "Nhật Ký Mèo Con Gia Đình A",
        author: "Phụ huynh A",
        min_grade: 1,
        max_grade: 3,
        lifecycle_status: "ACTIVE",
        visibility_scope: "PARENT_PRIVATE",
        moderation_status: "ACTIVE",
        suspended_reason: null,
        source_declaration: "Sách giấy gia đình mua",
        committed_page_count: 0,
        pending_submission_count: 0,
        flagged_submission_count: 0,
        failed_submission_count: 1,
        ready_to_add_count: 1,
        readable_for_children: false,
        has_held_multipage_batch: false,
        privacy_notice:
          "Chỉ phụ huynh sở hữu và các hồ sơ trẻ của gia đình được đọc sách này.",
        created_at: NOW,
      },
      pages: [] as Array<Record<string, unknown>>,
      submissions: [
        makeParentSubmissionDto({ id: subReadyId, source_page_number: 1 }),
        makeParentSubmissionDto({
          id: subFailId,
          source_page_number: 2,
          target_page_number: 2,
          source_file_name: "trang-2.png",
          workflow_status: "CHECK_FAILED",
          workflow_status_label: "Kiểm tra lỗi — có thể thử lại",
          tool_check_status: "FAILED",
          tool_check_suitability: null,
          tool_check_error_code: "OLLAMA_TIMEOUT",
          can_add_to_book: false,
          can_retry: true,
          updated_at: "2026-11-28T09:00:10.000Z",
        }),
      ],
    };

    let parentTasks = [
      makeTask({
        id: subReadyId,
        source: "parent_submission",
        job_type: "PARENT_PAGE_PIPELINE",
        title_vi: "Kiểm tra trang sách của tôi",
        book_id: PARENT_BOOK_ID,
        book_page_id: null,
        book_title: "Nhật Ký Mèo Con Gia Đình A",
        page_number: 1,
        actor_id: PARENT_A_ID,
        actor_role: "parent",
        portal: "parent",
        status: "SUCCEEDED",
        status_label_vi: "Bản đọc đã sẵn sàng để xem",
        stage: "COMPLETED",
        stage_label_vi: "Hoàn tất",
        attempt_count: 1,
        progress_pct: 100,
        can_retry: false,
        can_cancel: false,
        result_href: `/my-books?bookId=${PARENT_BOOK_ID}`,
        updated_at: "2026-11-28T09:00:00.000Z",
        completed_at: "2026-11-28T09:00:00.000Z",
      }),
      makeTask({
        id: subFailId,
        source: "parent_submission",
        job_type: "PARENT_PAGE_PIPELINE",
        title_vi: "Kiểm tra trang sách của tôi",
        book_id: PARENT_BOOK_ID,
        book_page_id: null,
        book_title: "Nhật Ký Mèo Con Gia Đình A",
        page_number: 2,
        actor_id: PARENT_A_ID,
        actor_role: "parent",
        portal: "parent",
        status: "FAILED",
        status_label_vi: "Xử lý thất bại",
        stage: "FAILED",
        stage_label_vi: "Gặp lỗi",
        attempt_count: 1,
        progress_pct: 33,
        can_retry: false,
        can_cancel: false,
        error_code: "OLLAMA_TIMEOUT",
        error_message_vi: "Không thể hoàn tất kiểm tra trang 2.",
        result_href: `/my-books?bookId=${PARENT_BOOK_ID}`,
        updated_at: "2026-11-28T09:00:10.000Z",
        completed_at: "2026-11-28T09:00:10.000Z",
      }),
    ];

    const buildParentFeed = () => ({
      actor_id: PARENT_A_ID,
      actor_role: "parent",
      portal: "parent",
      active_count: parentTasks.filter((t) =>
        ["QUEUED", "RUNNING", "WAITING_FOR_WORKER"].includes(String(t.status)),
      ).length,
      waiting_review_count: parentTasks.filter(
        (t) => t.status === "WAITING_FOR_REVIEW",
      ).length,
      failed_count: parentTasks.filter((t) => t.status === "FAILED").length,
      completed_count: parentTasks.filter((t) => t.status === "SUCCEEDED")
        .length,
      worker_online: true,
      recommended_poll_ms: 15000,
      tasks: parentTasks,
    });

    await context.route(`${API_BASE}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const method = route.request().method();

      if (pathname === "/studio/parent/tasks") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(buildParentFeed()),
        });
        return;
      }

      if (
        pathname === `/books/my-books/${PARENT_BOOK_ID}` &&
        method === "GET"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(bookDetail),
        });
        return;
      }

      if (
        pathname ===
          `/books/my-books/${PARENT_BOOK_ID}/submissions/${subReadyId}/add-page` &&
        method === "POST"
      ) {
        const committedSub = makeParentSubmissionDto({
          id: subReadyId,
          workflow_status: "ADDED_TO_BOOK",
          workflow_status_label: "Đã thêm vào sách",
          can_add_to_book: false,
          committed_page_id: committedPageId,
          committed_revision_id: committedRevId,
          updated_at: "2026-11-28T09:01:00.000Z",
        });
        bookDetail = {
          book: {
            ...bookDetail.book,
            committed_page_count: 1,
            ready_to_add_count: 0,
            readable_for_children: true,
          },
          pages: [
            {
              page_id: committedPageId,
              page_number: 1,
              current_verified_revision_id: committedRevId,
              verified_text: "Ngày xửa ngày xưa có chú mèo con.",
              verified_text_preview: "Ngày xửa ngày xưa có chú mèo con.",
              image_url: `${API_BASE}/books/my-books/${PARENT_BOOK_ID}/pages/${committedPageId}/image`,
              created_at: NOW,
            },
          ],
          submissions: [committedSub, bookDetail.submissions[1]],
        };
        // Backend keeps ADDED_TO_BOOK mapped to SUCCEEDED with bumped updated_at!
        parentTasks = [
          {
            ...parentTasks[0],
            book_page_id: committedPageId,
            status: "SUCCEEDED",
            updated_at: "2026-11-28T09:01:00.000Z",
            completed_at: "2026-11-28T09:01:00.000Z",
          },
          parentTasks[1],
        ];
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            book_id: PARENT_BOOK_ID,
            page_id: committedPageId,
            page_number: 1,
            revision_id: committedRevId,
            submission: committedSub,
            book_readable_for_children: true,
          }),
        });
        return;
      }

      if (
        pathname ===
          `/books/my-books/${PARENT_BOOK_ID}/submissions/${subFailId}/retry` &&
        method === "POST"
      ) {
        const retriedSub = makeParentSubmissionDto({
          id: subFailId,
          source_page_number: 2,
          target_page_number: 2,
          source_file_name: "trang-2.png",
          workflow_status: "CHECKING",
          workflow_status_label: "Đang kiểm tra",
          tool_check_status: "RUNNING",
          tool_check_error_code: null,
          can_add_to_book: false,
          can_retry: false,
          updated_at: "2026-11-28T09:02:00.000Z",
        });
        bookDetail = {
          ...bookDetail,
          submissions: [bookDetail.submissions[0], retriedSub],
        };
        parentTasks = [
          parentTasks[0],
          {
            ...parentTasks[1],
            status: "RUNNING",
            status_label_vi: "Đang xử lý",
            stage: "TOOL_CHECK",
            stage_label_vi: "Kiểm tra an toàn & chất lượng",
            attempt_count: 2,
            progress_pct: 66,
            error_code: null,
            error_message_vi: null,
            updated_at: "2026-11-28T09:02:00.000Z",
            completed_at: null,
          },
        ];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(retriedSub),
        });
        return;
      }

      if (pathname.endsWith("/image")) {
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          body: tinyPng,
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

    // 1) Visit private book manager directly -> red notification dot is visible on ParentAccountDropdown.
    await page.goto(`/my-books/${PARENT_BOOK_ID}`);
    await expect(
      page.getByRole("heading", { name: "Nhật Ký Mèo Con Gia Đình A" }),
    ).toBeVisible();
    await expect(page.getByTestId("avatar-notification-dot")).toBeVisible();

    // 2) Directly commit page 1 (addPage) without opening the task drawer:
    // page 1 stays suppressed even after ADDED_TO_BOOK bumps updated_at, while failed page 2 still alerts.
    await page
      .locator(`[data-submission-id="${subReadyId}"]`)
      .getByRole("button", { name: "Thêm trang vào sách" })
      .click();
    await expect(page.getByText(/Đã thêm vào sách đọc/)).toBeVisible();
    await expect(page.getByTestId("avatar-notification-dot")).toBeVisible();

    // 3) Directly retry failed page 2 without opening the task drawer ->
    // red alert dot clears and switches to calm blue running dot!
    await page.getByRole("button", { name: "Thử lại kiểm tra" }).click();
    await expect(page.getByTestId("avatar-notification-dot")).toHaveCount(0);
    await expect(page.getByTestId("avatar-running-dot")).toBeVisible();

    // 4) Retry attempt 2 fails again -> red alert dot MUST re-appear!
    parentTasks = [
      parentTasks[0],
      {
        ...parentTasks[1],
        status: "FAILED",
        status_label_vi: "Xử lý thất bại",
        stage: "FAILED",
        stage_label_vi: "Gặp lỗi",
        attempt_count: 2,
        error_code: "OLLAMA_TIMEOUT",
        error_message_vi: "Lần thử lại thứ 2 vẫn lỗi.",
        updated_at: "2026-11-28T09:03:00.000Z",
        completed_at: "2026-11-28T09:03:00.000Z",
      },
    ];
    await page.reload();
    await expect(page.getByTestId("avatar-notification-dot")).toBeVisible();

    // 5) Open ParentAccountDropdown -> see red dot & failure subtitle -> click to open drawer -> clears immediately!
    const accountMenuTrigger = page.getByRole("button", {
      name: "Mở menu tài khoản",
    });
    await accountMenuTrigger.click();
    await expect(page.getByTestId("menu-ai-tasks-red-dot")).toBeVisible();
    await expect(page.getByTestId("menu-ai-tasks-trigger")).toContainText(
      "1 tác vụ gặp lỗi cần xem",
    );
    await page.getByTestId("menu-ai-tasks-trigger").click();
    const drawer = page.getByTestId("global-task-center-panel");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("avatar-notification-dot")).toHaveCount(0);
    await drawer
      .getByRole("button", { name: "Đóng trung tâm tác vụ AI" })
      .click();
    await expect(drawer).toHaveCount(0);

    // 6) Reload with same backend feed -> warning MUST stay suppressed across page.reload()!
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Nhật Ký Mèo Con Gia Đình A" }),
    ).toBeVisible();
    await expect(page.getByTestId("avatar-notification-dot")).toHaveCount(0);
    await accountMenuTrigger.click();
    await expect(page.getByTestId("menu-ai-tasks-red-dot")).toHaveCount(0);
    await expect(page.getByTestId("menu-ai-tasks-trigger")).toContainText(
      "Chưa có tác vụ mới",
    );

    // 7) Brand-new WAITING_FOR_REVIEW task arrives -> MUST re-alert with red notification dot!
    parentTasks = [
      ...parentTasks,
      makeTask({
        id: subNewReviewId,
        source: "parent_submission",
        job_type: "PARENT_PAGE_PIPELINE",
        title_vi: "Kiểm tra trang sách của tôi",
        book_id: PARENT_BOOK_ID,
        book_page_id: null,
        book_title: "Nhật Ký Mèo Con Gia Đình A",
        page_number: 3,
        actor_id: PARENT_A_ID,
        actor_role: "parent",
        portal: "parent",
        status: "WAITING_FOR_REVIEW",
        status_label_vi: "Cần xác minh",
        stage: "WAITING_FOR_REVIEW",
        stage_label_vi: "Chờ người dùng xác minh",
        attempt_count: 1,
        progress_pct: 100,
        can_retry: false,
        can_cancel: false,
        result_href: `/my-books?bookId=${PARENT_BOOK_ID}`,
        updated_at: "2026-11-28T09:10:00.000Z",
      }),
    ];
    await page.reload();
    await expect(page.getByTestId("avatar-notification-dot")).toBeVisible();

    monitor.assertNoErrors();
    await context.close();
  });
});
