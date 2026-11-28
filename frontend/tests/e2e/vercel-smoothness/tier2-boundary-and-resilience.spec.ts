import { expect, test } from "@playwright/test";

import {
  assertNoRawErrorLeak,
  IDS,
  installMockApi,
  type MockBook,
} from "./fixtures/mock-api";

async function assertNoHorizontalOverflow(
  page: import("@playwright/test").Page,
  label: string,
) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    metrics.scrollWidth,
    `[${label}] horizontal overflow detected`,
  ).toBeLessThanOrEqual(metrics.clientWidth);
}

test.describe("Tier 2: Boundary, Negative & Resilience Coverage", () => {
  // =========================================================================
  // FA1: Auth, Route Guards & Non-Blocking Session (5 tests)
  // =========================================================================
  test.describe("FA1: Auth Boundaries & Guard Failures", () => {
    test("T2-FA1-1: /login?oauth_error=email_required displays safe Facebook email permission error", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/login?oauth_error=email_required");

      await expect(
        page.getByText(/Facebook không cung cấp email cho tài khoản này/),
      ).toBeVisible();
      assertNoRawErrorLeak(await page.locator("body").innerText(), "T2-FA1-1");
      tracker.assertCleanHealth("T2-FA1-1");
    });

    test("T2-FA1-2: /login?oauth_error=oauth_failed displays safe social OAuth error copy", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/login?oauth_error=oauth_failed");

      await expect(
        page.getByText(/Không thể hoàn tất đăng nhập xã hội/),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA1-2");
    });

    test("T2-FA1-3: invalid credentials on /login show Vietnamese error without leaking raw auth JSON", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        supabaseTokenShouldFail: true,
      });
      await page.goto("/login?state=default");

      await page.getByLabel("Email của ba mẹ").fill("parent@example.test");
      await page.getByLabel("Mật khẩu", { exact: true }).fill("wrongpass123");
      await page.getByRole("button", { name: "Đăng nhập" }).click();

      const errorAlert = page.getByRole("main").getByRole("alert");
      await expect(errorAlert).toBeVisible();
      await expect(errorAlert).toContainText(
        /Email hoặc mật khẩu chưa đúng|Có lỗi xảy ra/,
      );
      const alertText = await page.locator("main").innerText();
      expect(alertText).not.toContain("invalid_grant");
      assertNoRawErrorLeak(alertText, "T2-FA1-3");
      tracker.assertCleanHealth("T2-FA1-3", { expectedHttpStatuses: [400] });
    });

    test.describe("unauthenticated protected routes", () => {
      test.use({ extraHTTPHeaders: {} });

      test("T2-FA1-4: unauthenticated /settings, /reports, /my-books redirect to /login?next=...", async ({
        page,
      }) => {
        for (const target of ["/settings", "/reports", "/my-books"]) {
          await page.goto(target);
          await expect(page).toHaveURL(
            new RegExp(`/login\\?next=${encodeURIComponent(target)}`),
          );
        }
      });
    });

    test("T2-FA1-5: 401 on GET /books/catalog does not retry (attemptCount === 1) and renders safe error", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/books/catalog",
            sequence: [{ status: 401, body: { detail: "JWT expired" } }],
          },
        ],
      });
      await page.goto("/books");

      await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/books/catalog"))
        .toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA1-5");
      tracker.assertCleanHealth("T2-FA1-5", { expectedHttpStatuses: [401] });
    });
  });

  // =========================================================================
  // FA2: Child Selection & Profile Boundaries (5 tests)
  // =========================================================================
  test.describe("FA2: Child Profile Boundaries & Validation", () => {
    test("T2-FA2-1: /children with zero children renders empty state and onboarding CTA", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, { emptyChildren: true });
      await page.goto("/children");

      await expect(
        page.getByRole("heading", { name: "Chưa có hồ sơ bé" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Tạo hồ sơ đầu tiên" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA2-1");
    });

    test("T2-FA2-2: /children/new blocks empty alias locally without calling POST /profiles/children", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/children/new");

      await page.getByRole("button", { name: "Lưu hồ sơ" }).click();
      await expect(page.locator("form")).toContainText(/tên|bé/i);
      expect(tracker.getAttemptCount("POST", "/profiles/children")).toBe(0);
      tracker.assertCleanHealth("T2-FA2-2");
    });

    test("T2-FA2-3: /children/[foreignId] 404 renders safe not-found view", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/children/${IDS.foreignChild}`);

      await expect(
        page.getByRole("heading", { name: "Không tìm thấy hồ sơ bé" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Về danh sách hồ sơ" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA2-3", { expectedHttpStatuses: [404] });
    });

    test("T2-FA2-4: 503 on GET /profiles/children is not retried and recovers on 'Thử lại'", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/profiles/children",
            sequence: [
              {
                status: 503,
                body: { detail: "SELECT * FROM children failed" },
              },
            ],
          },
        ],
      });
      await page.goto("/children");

      await expect(page.getByText("Chưa tải được hồ sơ bé")).toBeVisible();
      expect(tracker.getAttemptCount("GET", "/profiles/children")).toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA2-4");

      await page.getByRole("button", { name: "Thử lại" }).click();
      await expect(
        page.getByRole("link", { name: "Bé An, lớp 1" }),
      ).toBeVisible();
      expect(tracker.getAttemptCount("GET", "/profiles/children")).toBe(2);
      tracker.assertCleanHealth("T2-FA2-4", { expectedHttpStatuses: [503] });
    });

    test("T2-FA2-5: POST /profiles/children 502 does not auto-retry and hides raw backend payload", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "POST",
            path: "/profiles/children",
            sequence: [
              {
                status: 502,
                body: {
                  detail: "psycopg2.OperationalError: connection refused",
                },
              },
            ],
          },
        ],
      });
      await page.goto("/children/new");
      await page.getByLabel("Tên gọi của bé").fill("Bé Test");
      await page.getByRole("button", { name: "Lưu hồ sơ" }).click();

      await expect(
        page.getByText("Chưa thể lưu hồ sơ. Ba mẹ vui lòng thử lại sau."),
      ).toBeVisible();
      expect(tracker.getAttemptCount("POST", "/profiles/children")).toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA2-5");
      tracker.assertCleanHealth("T2-FA2-5", { expectedHttpStatuses: [502] });
    });
  });

  // =========================================================================
  // FA3: Library, Book Covers & Private Media Boundaries (5 tests)
  // =========================================================================
  test.describe("FA3: Library & Private Book Error Boundaries", () => {
    test("T2-FA3-1: empty catalog on /books renders 'Thư viện đang được cập nhật'", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, { emptyCatalog: true });
      await page.goto("/books");

      await expect(
        page.getByRole("heading", { name: "Thư viện đang được cập nhật" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA3-1");
    });

    test("T2-FA3-2: unmatched search renders empty filtered state and 'Xóa bộ lọc' restores catalog", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/books");

      await page
        .getByPlaceholder("Tìm theo tên sách hoặc tác giả")
        .fill("Không Tồn Tại XYZ");
      await expect(
        page.getByRole("heading", { name: "Không tìm thấy cuốn sách phù hợp" }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Xóa bộ lọc" }).click();
      await expect(
        page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA3-2");
    });

    test("T2-FA3-3: 503 on GET /books/catalog is not retried and 'Thử lại' recovers cleanly", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/books/catalog",
            sequence: [{ status: 503, body: { detail: "private sql token" } }],
          },
        ],
      });
      await page.goto("/books");

      await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
      expect(tracker.getAttemptCount("GET", "/books/catalog")).toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA3-3");

      await page.getByRole("button", { name: "Thử lại" }).click();
      await expect(
        page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA3-3", { expectedHttpStatuses: [503] });
    });

    test("T2-FA3-4: /books/[unknownId] 404 renders safe not-found screen", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/books/${IDS.foreignChild}`);

      await expect(
        page.getByRole("heading", { name: "Không tìm thấy sách" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Về thư viện sách" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA3-4", { expectedHttpStatuses: [404] });
    });

    test("T2-FA3-5: POST /books/my-books 422 does not auto-retry (attemptCount === 1) and shows safe error", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "POST",
            path: "/books/my-books",
            sequence: [
              { status: 422, body: { detail: "Invalid grade range" } },
            ],
          },
        ],
      });
      await page.goto("/my-books");

      await page.getByRole("button", { name: /Tạo sách riêng/ }).click();
      await page
        .getByPlaceholder(/Ví dụ|Tên sách/i)
        .first()
        .fill("Sách Lỗi");
      await page.locator('form button[type="submit"]').click();

      await expect(page.getByText("Thao tác chưa hoàn tất")).toBeVisible();
      await expect(
        page.getByText("Có lỗi xảy ra. Vui lòng thử lại sau."),
      ).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("POST", "/books/my-books"))
        .toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA3-5");
      tracker.assertCleanHealth("T2-FA3-5", { expectedHttpStatuses: [422] });
    });
  });

  // =========================================================================
  // FA4: Reading Session Resilience & Error Dialogs (5 tests)
  // =========================================================================
  test.describe("FA4: Reading Session Error & Recovery Boundaries", () => {
    test("T2-FA4-1: ?state=paused displays recoverable ReadingStatusDialog and exit confirm controls", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reading/${IDS.session1}?state=paused`);

      const pausedDialog = page.getByRole("dialog", {
        name: "Bé đang nghỉ một chút",
      });
      await expect(pausedDialog).toContainText("không tạo lỗi đọc");
      await expect(page.locator("[data-child-error-count='0']")).toBeVisible();

      await pausedDialog.getByRole("button", { name: "Dừng buổi đọc" }).click();
      const exitDialog = page.getByRole("dialog", {
        name: "Bé muốn nghỉ hôm nay?",
      });
      await expect(exitDialog).toBeVisible();
      await exitDialog.getByRole("button", { name: "Đọc tiếp" }).click();
      await expect(exitDialog).toHaveCount(0);
      tracker.assertCleanHealth("T2-FA4-1");
    });

    test("T2-FA4-2: ?state=microphone-denied records 0 child reading errors", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reading/${IDS.session1}?state=microphone-denied`);

      await expect(
        page.getByRole("dialog", { name: "Mình chưa nghe thấy giọng bé" }),
      ).toContainText("không kết luận bé đọc sai");
      await expect(page.locator("[data-child-error-count='0']")).toBeVisible();
      tracker.assertCleanHealth("T2-FA4-2");
    });

    test("T2-FA4-3: ?state=reconnecting shows safe reconnect dialog and recovers on 'Kết nối lại'", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reading/${IDS.session1}?state=reconnecting`);

      const dialog = page.getByRole("dialog", {
        name: "Đợi mình một chút nhé…",
      });
      await expect(dialog).toContainText("không tạo lỗi đọc");
      await expect(page.locator("[data-child-error-count='0']")).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Kết thúc an toàn" }),
      ).toBeVisible();

      await dialog.getByRole("button", { name: "Kết nối lại" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText("Mình đang chờ bé")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA4-3");
    });

    test("T2-FA4-4: ?state=stt-error and ?state=tts-error never blame child reading accuracy and stt-error recovers cleanly", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reading/${IDS.session1}?state=stt-error`);
      const sttDialog = page.getByRole("dialog", { name: "Mình chưa nghe rõ" });
      await expect(sttDialog).toContainText("không tạo lỗi đọc");
      await expect(page.locator("[data-child-error-count='0']")).toBeVisible();
      await sttDialog.getByRole("button", { name: "Thử nghe lại" }).click();
      await expect(sttDialog).toHaveCount(0);
      await expect(page.getByText("Mình đang chờ bé")).toBeVisible();

      await page.goto(`/reading/${IDS.session1}?state=tts-error`);
      const ttsBanner = page.getByTestId("tts-error-banner");
      await expect(ttsBanner).toBeVisible();
      await expect(ttsBanner).toHaveAttribute("role", "status");
      await expect(ttsBanner).toContainText("Từ này mình đọc thế nào nhỉ?");
      await expect(ttsBanner).toContainText("vẫn có thể nhìn chữ");
      tracker.assertCleanHealth("T2-FA4-4");
    });

    test("T2-FA4-5: ?state=page-confidence-low keeps page picker closed and supports safe finish", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reading/${IDS.session1}?state=page-confidence-low`);

      const dialog = page.getByRole("dialog", {
        name: "Mình chưa nhìn rõ trang sách",
      });
      await expect(dialog).toBeVisible();
      await expect(page.locator("[data-child-error-count='0']")).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Chọn trang", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("dialog", { name: "Bé đang đọc trang nào?" }),
      ).toHaveCount(0);

      await dialog.getByRole("button", { name: "Kết thúc an toàn" }).click();
      await expect(
        page.getByRole("dialog", { name: "Bé muốn nghỉ hôm nay?" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA4-5");
    });
  });

  // =========================================================================
  // FA5: Progress Report Boundaries (5 tests)
  // =========================================================================
  test.describe("FA5: Progress Reports Error & Edge Cases", () => {
    test("T2-FA5-1: inverted period_start > period_end shows invalid-period message and recovery link", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(
        `/reports?childId=${IDS.childA}&period_start=2026-10-10&period_end=2026-10-01`,
      );

      await expect(page.getByText("Kỳ báo cáo không hợp lệ")).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Xem báo cáo mới nhất" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA5-1");
    });

    test("T2-FA5-2: /reports with zero children renders empty state with /children/new CTA", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, { emptyChildren: true });
      await page.goto("/reports");

      await expect(
        page.getByRole("heading", { name: "Chưa có dữ liệu báo cáo" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Tạo hồ sơ bé" }),
      ).toHaveAttribute("href", "/children/new");
      tracker.assertCleanHealth("T2-FA5-2");
    });

    test("T2-FA5-3: /reports?childId=foreign renders safe not-found state", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reports?childId=${IDS.foreignChild}`);

      await expect(page.getByText("Không tìm thấy báo cáo")).toBeVisible();
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA5-3");
      tracker.assertCleanHealth("T2-FA5-3", { expectedHttpStatuses: [404] });
    });

    test("T2-FA5-4: 503 on /system/progress/[childId] is not retried and 'Thử lại' recovers", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: `/system/progress/${IDS.childA}`,
            sequence: [{ status: 503, body: { detail: "DB pool exhausted" } }],
          },
        ],
      });
      await page.goto(`/reports?childId=${IDS.childA}`);

      await expect(
        page
          .getByText("Chưa tải được báo cáo")
          .or(page.getByText("Dữ liệu đang chờ bổ sung")),
      ).toBeVisible();
      await expect
        .poll(() =>
          tracker.getAttemptCount("GET", `/system/progress/${IDS.childA}`),
        )
        .toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA5-4");

      const retryBtn = page.getByRole("button", { name: "Thử lại" });
      await expect(retryBtn).toBeVisible();
      await retryBtn.first().click();
      await expect(page.getByText("Buổi đọc hoàn thành")).toBeVisible();
      tracker.assertCleanHealth("T2-FA5-4", { expectedHttpStatuses: [503] });
    });

    test("T2-FA5-5: partial report data_status renders incomplete-data notice without fabricating zeros", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        reportDataStatus: "partial",
      });
      await page.goto(`/reports?childId=${IDS.childA}`);

      await expect(
        page.getByText("Báo cáo có dữ liệu chưa đầy đủ"),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA5-5");
    });
  });

  // =========================================================================
  // FA6: Account Settings & Support Boundaries (5 tests)
  // =========================================================================
  test.describe("FA6: Settings & Support Validation & Failure Boundaries", () => {
    test("T2-FA6-1: 503 on GET /profiles/me in /settings is not retried and 'Thử tải lại' recovers", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/profiles/me",
            sequence: [{ status: 503, body: { detail: "Auth unavailable" } }],
          },
        ],
      });
      await page.goto("/settings");

      await expect(page.getByText("Không thể tải thông tin")).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/profiles/me"))
        .toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA6-1");

      await page.getByRole("button", { name: "Thử tải lại" }).click();
      await expect(
        page.getByRole("heading", { name: "Cài đặt tài khoản" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA6-1", { expectedHttpStatuses: [503] });
    });

    test("T2-FA6-2: /settings password form validates short and mismatched passwords client-side", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/settings");

      await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
      await page.locator("#current-password").fill("oldpass123");
      await page.locator("#new-password").fill("short");
      await page.locator("#confirm-new-password").fill("short");
      await page.getByRole("button", { name: "Lưu mật khẩu mới" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        /ít nhất 8 ký tự/i,
      );

      await page.locator("#new-password").fill("validpass123");
      await page.locator("#confirm-new-password").fill("different123");
      await page.getByRole("button", { name: "Lưu mật khẩu mới" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        /chưa khớp|không khớp|trùng khớp/i,
      );
      tracker.assertCleanHealth("T2-FA6-2");
    });

    test("T2-FA6-3: PUT /parent-notifications/preferences 422 does not retry and keeps safe error copy", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "PUT",
            path: "/parent-notifications/preferences",
            sequence: [
              { status: 422, body: { detail: "Invalid quiet hours" } },
            ],
          },
        ],
      });
      await page.goto("/settings");

      await page.getByRole("button", { name: "Lưu cài đặt email" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
      await expect
        .poll(() =>
          tracker.getAttemptCount("PUT", "/parent-notifications/preferences"),
        )
        .toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA6-3");
      tracker.assertCleanHealth("T2-FA6-3", { expectedHttpStatuses: [422] });
    });

    test("T2-FA6-4: /help-support validates required fields and invalid email before POST /support/feedback", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/help-support");

      await page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await expect
        .poll(() => tracker.getAttemptCount("POST", "/support/feedback"))
        .toBe(0);

      await page.getByLabel("Tiêu đề").fill("Tiêu đề hợp lệ");
      await page.getByLabel("Nội dung").fill("Nội dung hợp lệ");
      await page.getByLabel("Email liên hệ").fill("not-an-email");
      await page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("POST", "/support/feedback"))
        .toBe(0);
      tracker.assertCleanHealth("T2-FA6-4");
    });

    test("T2-FA6-5: POST /support/feedback 503 does not retry and renders safe email-unavailable message", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "POST",
            path: "/support/feedback",
            sequence: [{ status: 503, body: { detail: "SMTP down" } }],
          },
        ],
      });
      await page.goto("/help-support");

      await page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await page.getByLabel("Tiêu đề").fill("Cần hỗ trợ");
      await page.getByLabel("Nội dung").fill("Gặp lỗi khi mở trang.");
      await page.getByRole("button", { name: "Gửi phản hồi" }).click();

      await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("POST", "/support/feedback"))
        .toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA6-5");
      tracker.assertCleanHealth("T2-FA6-5", { expectedHttpStatuses: [503] });
    });
  });

  // =========================================================================
  // FA7: Non-Retry Invariants, Timeouts & Cron Hardening (6 tests)
  // =========================================================================
  test.describe("FA7: Non-Retry Guarantees, Timeouts & Cron Fail-Closed", () => {
    test("T2-FA7-1: GET /books/catalog 503 never retries (attemptCount === 1) and strips SQL leakage", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/books/catalog",
            sequence: [
              {
                status: 503,
                body: {
                  detail:
                    "Traceback (most recent call last): SELECT * FROM books",
                },
              },
            ],
          },
        ],
      });
      await page.goto("/books");

      await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/books/catalog"))
        .toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA7-1");
      tracker.assertCleanHealth("T2-FA7-1", { expectedHttpStatuses: [503] });
    });

    test("T2-FA7-2: GET /books/catalog 403 and 422 never retry (attemptCount === 1)", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/books/catalog",
            sequence: [
              { status: 403, body: { detail: "Forbidden" } },
              { status: 422, body: { detail: "Validation failed" } },
            ],
          },
        ],
      });
      await page.goto("/books");
      await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/books/catalog"))
        .toBe(1);
      assertNoRawErrorLeak(
        await page.locator("main").innerText(),
        "T2-FA7-2-403",
      );

      await page.getByRole("button", { name: "Thử lại" }).click();
      await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/books/catalog"))
        .toBe(2);
      assertNoRawErrorLeak(
        await page.locator("main").innerText(),
        "T2-FA7-2-422",
      );
      tracker.assertCleanHealth("T2-FA7-2", {
        expectedHttpStatuses: [403, 422],
      });
    });

    test("T2-FA7-3: structured backend domain 504 (LOCAL_OCR_TIMEOUT) on GET is NOT retried", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/books/catalog",
            sequence: [
              {
                status: 504,
                body: { detail: { code: "LOCAL_OCR_TIMEOUT" } },
              },
            ],
          },
        ],
      });
      await page.goto("/books");

      await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/books/catalog"))
        .toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA7-3");
      tracker.assertCleanHealth("T2-FA7-3", { expectedHttpStatuses: [504] });
    });

    test("T2-FA7-4: POST /books/my-books 502 and 520 never auto-retry (attemptCount === 1 each)", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "POST",
            path: "/books/my-books",
            sequence: [
              {
                status: 502,
                contentType: "text/html",
                body: "<html>Bad Gateway</html>",
              },
              {
                status: 520,
                contentType: "text/html",
                body: "<html>Cloudflare 520</html>",
              },
            ],
          },
        ],
      });
      await page.goto("/my-books");

      await page.getByRole("button", { name: /Tạo sách riêng/ }).click();
      await page
        .getByPlaceholder(/Ví dụ|Tên sách/i)
        .first()
        .fill("Sách 502");
      await page.locator('form button[type="submit"]').click();

      await expect(page.getByText("Thao tác chưa hoàn tất")).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("POST", "/books/my-books"))
        .toBe(1);

      await page
        .getByPlaceholder(/Ví dụ|Tên sách/i)
        .first()
        .fill("Sách 520");
      await page.locator('form button[type="submit"]').click();
      await expect(page.getByText("Thao tác chưa hoàn tất")).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("POST", "/books/my-books"))
        .toBe(2);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA7-4");
      tracker.assertCleanHealth("T2-FA7-4", {
        expectedHttpStatuses: [502, 520],
      });
    });

    test("T2-FA7-5: 503 on GET /profiles/me never retries (attemptCount === 1) and shows bounded error UI", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/profiles/me",
            sequence: [
              {
                status: 503,
                body: { detail: "SELECT * FROM profiles unavailable" },
              },
            ],
          },
        ],
      });
      await page.goto("/settings");

      await expect(page.getByText("Không thể tải thông tin")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Thử tải lại" }),
      ).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/profiles/me"))
        .toBe(1);
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA7-5");
      tracker.assertCleanHealth("T2-FA7-5", { expectedHttpStatuses: [503] });
    });

    test("T2-FA7-6: /api/cron/parent-emails rejects wrong Bearer token and unsupported DELETE method", async ({
      request,
    }) => {
      const badAuth = await request.post("/api/cron/parent-emails?scope=all", {
        headers: { Authorization: "Bearer wrong-token-value-123456" },
      });
      expect([401, 503]).toContain(badAuth.status());

      const badMethod = await request.delete("/api/cron/parent-emails");
      expect(badMethod.status()).toBe(405);
    });
  });

  // =========================================================================
  // FA8: Asset Fallbacks, Role Isolation, XSS & Responsive Parity (5 tests)
  // =========================================================================
  test.describe("FA8: Security, Asset Fallbacks & Responsive Boundaries", () => {
    test("T2-FA8-1: broken BookCover image URL falls back cleanly to METADATA_RENDER without pageerror", async ({
      page,
    }) => {
      const brokenBooks: MockBook[] = [
        {
          id: IDS.book1,
          title: "Sách Ảnh Bị Lỗi",
          author: "Tác Giả",
          min_grade: 1,
          max_grade: 2,
          lifecycle_status: "ACTIVE",
          visibility_scope: "CATALOG",
          cover_url: "http://127.0.0.1:8000/public-assets/missing-cover.png",
          cover_source_type: "USER_UPLOAD",
        },
      ];
      const tracker = await installMockApi(page, {
        initialBooks: brokenBooks,
        faults: [
          {
            method: "GET",
            path: "/public-assets/missing-cover.png",
            sequence: [{ status: 404, body: { detail: "Not found" } }],
          },
        ],
      });
      await page.goto("/books");

      await expect(
        page.locator('[data-cover-source="METADATA_RENDER"]').first(),
      ).toBeVisible();
      tracker.assertCleanHealth("T2-FA8-1", { expectedHttpStatuses: [404] });
    });

    test("T2-FA8-2: tampered locale cookie falls back safely without XSS execution", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.context().addCookies([
        {
          name: "viread_locale",
          value: "xx-invalid<script>window.__xss=1</script>",
          domain: "127.0.0.1",
          path: "/",
        },
      ]);
      await page.goto("/dashboard");

      await expect(
        page.getByRole("heading", { name: "Góc đọc gia đình" }),
      ).toBeVisible();
      const xssTriggered = await page.evaluate(() =>
        Boolean((window as unknown as { __xss?: unknown }).__xss),
      );
      expect(xssTriggered).toBe(false);
      tracker.assertCleanHealth("T2-FA8-2");
    });

    test("T2-FA8-3: /entertainment/picture-description handles 503 catalog response gracefully", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/games/picture-description/catalog",
            sequence: [
              { status: 503, body: { detail: "Catalog unavailable" } },
            ],
          },
        ],
      });
      await page.goto("/entertainment/picture-description");

      await expect(page.locator("h1:visible").first()).toBeVisible();
      await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
      assertNoRawErrorLeak(await page.locator("main").innerText(), "T2-FA8-3");
      tracker.assertCleanHealth("T2-FA8-3", { expectedHttpStatuses: [503] });
    });

    test("T2-FA8-4: parent role visiting /admin/books fails closed away from admin workspace", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/admin/books");

      await expect(page).not.toHaveURL(/\/admin\/books/);
      tracker.assertCleanHealth("T2-FA8-4");
    });

    test("T2-FA8-5: mobile 390x844 viewport preserves zero horizontal overflow on /books and /reading", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const tracker = await installMockApi(page);

      await page.goto("/books");
      await expect(
        page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page, "T2-FA8-5-books-mobile");

      await page.goto(`/reading/${IDS.session1}?state=reading`);
      await expect(page.getByText("Mình đang chờ bé")).toBeVisible();
      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();
      await expect(page.getByText("Mình đang nghe bé đọc")).toBeVisible();
      await assertNoHorizontalOverflow(page, "T2-FA8-5-reading-mobile");
      tracker.assertCleanHealth("T2-FA8-5");
    });
  });
});
