import { expect, test } from "@playwright/test";

import { IDS, installMockApi, seedParentSession } from "./fixtures/mock-api";

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

test.describe("Tier 1: Feature Coverage (Isolated Happy Paths)", () => {
  // =========================================================================
  // FA1: Auth, Route Guards & Non-Blocking Session (5 tests)
  // =========================================================================
  test.describe("FA1: Auth, Route Guards & Non-Blocking Session", () => {
    test("T1-FA1-1: /login renders credentials form, password toggle, OAuth buttons, and validates input", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/login?state=default");

      await expect(
        page.getByRole("heading", { name: "Đăng nhập" }),
      ).toBeVisible();
      await expect(page.getByLabel("Email của ba mẹ")).toBeVisible();
      const passwordInput = page.getByLabel("Mật khẩu", { exact: true });
      await expect(passwordInput).toHaveAttribute("type", "password");

      await page.getByRole("button", { name: "Hiện mật khẩu" }).click();
      await expect(passwordInput).toHaveAttribute("type", "text");

      await expect(
        page.getByRole("button", { name: "Tiếp tục với Google" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Tiếp tục với Facebook" }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Đăng nhập" }).click();
      await expect(
        page.getByText("Mật khẩu cần có ít nhất 8 ký tự."),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA1-1");
    });

    test("T1-FA1-2: /login navigates cleanly to /register and /forgot-password", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/login?state=default");

      await page
        .getByRole("main")
        .getByRole("link", { name: /Đăng ký/ })
        .click();
      await expect(page).toHaveURL(/\/register$/, { timeout: 15_000 });
      await expect(
        page.getByRole("heading", { name: /Đăng ký|Tạo tài khoản/ }),
      ).toBeVisible();

      await page.goto("/login?state=default");
      await page.getByRole("link", { name: "Quên mật khẩu?" }).click();
      await expect(page).toHaveURL(/\/forgot-password$/, { timeout: 15_000 });
      await expect(
        page.getByRole("heading", { name: /Quên mật khẩu|Khôi phục mật khẩu/ }),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA1-2");
    });

    test.describe("unauthenticated guard", () => {
      test.use({ extraHTTPHeaders: {} });

      test("T1-FA1-3: unauthenticated visit to /dashboard redirects to /login?next=%2Fdashboard", async ({
        page,
      }) => {
        await page.goto("/dashboard");
        await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
        await expect(
          page.getByRole("heading", { name: "Đăng nhập" }),
        ).toBeVisible();
      });
    });

    test("T1-FA1-4: authenticated parent accesses /dashboard without console or API errors", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/dashboard");

      await expect(
        page.getByRole("heading", { name: "Góc đọc gia đình" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Bé An, lớp 1" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA1-4");
    });

    test("T1-FA1-5: sign-out flow via AccountAvatarMenu clears session and redirects to /login", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { name: "Góc đọc gia đình" }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Mở menu tài khoản" }).click();
      const signOutItem = page.getByRole("menuitem", { name: "Đăng xuất" });
      await expect(signOutItem).toBeVisible();
      await signOutItem.click();

      await expect(page).toHaveURL(/\/login/);
      tracker.assertCleanHealth("T1-FA1-5");
    });
  });

  // =========================================================================
  // FA2: Child Selection Persistence & Profile Management (5 tests)
  // =========================================================================
  test.describe("FA2: Child Selection Persistence & Profile Management", () => {
    test("T1-FA2-1: /children renders parent child profiles from GET /profiles/children", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/children");

      await expect(
        page.getByRole("heading", { name: "Hồ sơ của các bé" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Bé An, lớp 1" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Bé Bình, lớp 2" }),
      ).toBeVisible();
      expect(
        tracker.getAttemptCount("GET", "/profiles/children"),
      ).toBeGreaterThanOrEqual(1);
      tracker.assertCleanHealth("T1-FA2-1");
    });

    test("T1-FA2-2: selecting child card on /dashboard marks aria-pressed=true", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, { selectedChildId: null });
      await page.goto("/dashboard");

      const childButton = page.getByRole("button", { name: "Bé Bình, lớp 2" });
      await expect(childButton).toBeVisible();
      await childButton.click();

      await expect(childButton).toHaveAttribute("aria-pressed", "true");
      tracker.assertCleanHealth("T1-FA2-2");
    });

    test("T1-FA2-3: selected child persists across page.reload()", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, { selectedChildId: null });
      await page.goto("/dashboard");

      const childButton = page.getByRole("button", { name: "Bé Bình, lớp 2" });
      await childButton.click();
      await expect(childButton).toHaveAttribute("aria-pressed", "true");

      await page.reload();
      await expect(
        page.getByRole("button", { name: "Bé Bình, lớp 2" }),
      ).toHaveAttribute("aria-pressed", "true");
      tracker.assertCleanHealth("T1-FA2-3");
    });

    test("T1-FA2-4: selected child persists across /dashboard -> /books -> /entertainment/picture-description and /reports?childId", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, { selectedChildId: null });
      await page.goto("/dashboard");

      const childButton = page.getByRole("button", { name: "Bé Bình, lớp 2" });
      await childButton.click();
      await expect(childButton).toHaveAttribute("aria-pressed", "true");

      await page.goto("/books");
      await expect(
        page.getByRole("heading", { name: "Tủ sách của Bé Bình" }),
      ).toBeVisible();

      await page.goto("/entertainment/picture-description");
      await expect(page.locator("h1:visible").first()).toBeVisible();

      await page.goto(`/reports?childId=${IDS.childB}`);
      await expect(
        page.getByRole("heading", { name: "Tiến bộ của Bé Bình" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA2-4");
    });

    test("T1-FA2-5: creating a child profile on /children/new submits POST /profiles/children", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/children/new");

      await expect(
        page.getByRole("heading", { name: "Tạo hồ sơ bé" }),
      ).toBeVisible();
      await page.getByLabel("Tên gọi của bé").fill("Bé Chi");
      await page.getByLabel("Lớp của bé").selectOption("3");
      await page.getByRole("button", { name: "Lưu hồ sơ" }).click();

      await expect(page).toHaveURL(/\/children\//);
      await expect
        .poll(() => tracker.getAttemptCount("POST", "/profiles/children"))
        .toBe(1);
      await expect(
        page.getByRole("heading", { name: "Hồ sơ của Bé Chi" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA2-5");
    });
  });

  // =========================================================================
  // FA3: Library, Book Covers & Private Book Media (5 tests)
  // =========================================================================
  test.describe("FA3: Library, Book Covers & Private Book Media", () => {
    test("T1-FA3-1: /books catalog loads and renders public CATALOG BookCover images cleanly", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/books");

      await expect(
        page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
      ).toBeVisible();

      const coverImg = page.locator("article.catalog-volume img").first();
      await expect(coverImg).toBeVisible();
      const loaded = await coverImg.evaluate(
        (el) =>
          el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0,
      );
      expect(loaded).toBe(true);
      expect(tracker.failedImages).toEqual([]);
      tracker.assertCleanHealth("T1-FA3-1");
    });

    test("T1-FA3-2: /books search input and grade filter (Lớp 1) filter catalog cleanly", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/books");

      const gradeOneBtn = page.getByRole("button", { name: "Lớp 1" });
      await gradeOneBtn.click();
      await expect(gradeOneBtn).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
      ).toBeVisible();

      await page
        .getByPlaceholder("Tìm theo tên sách hoặc tác giả")
        .fill("Mèo Nhỏ");
      await expect(
        page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA3-2");
    });

    test("T1-FA3-3: /books favorite and want-to-read collection buttons toggle aria-pressed", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/books");

      const favButton = page
        .getByRole("button", {
          name: /Chú Mèo Nhỏ Đi Học.*yêu thích|yêu thích/i,
        })
        .first();
      await favButton.click();
      await expect(favButton).toHaveAttribute("aria-pressed", "true");

      const wantButton = page
        .getByRole("button", { name: /muốn đọc/i })
        .first();
      await wantButton.click();
      await expect(wantButton).toHaveAttribute("aria-pressed", "true");
      tracker.assertCleanHealth("T1-FA3-3");
    });

    test("T1-FA3-4: /books/[bookId] loads book detail and verified page preview thumbnails", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/books/${IDS.book1}`);

      await expect(
        page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
      ).toBeVisible();
      const thumb = page.getByAltText("Ảnh xem trước trang 1");
      await expect(thumb).toBeVisible();
      const thumbOk = await thumb.evaluate(
        (el) =>
          el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0,
      );
      expect(thumbOk).toBe(true);
      tracker.assertCleanHealth("T1-FA3-4");
    });

    test("T1-FA3-5: /my-books and /my-books/[bookId] fetch private page images with Authorization and Cache-Control: private, no-store", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      let privateCacheControl = "";
      page.on("response", (res) => {
        if (
          res.request().method() === "GET" &&
          res.url().includes(`/books/my-books/${IDS.privateBook}/pages/`) &&
          res.url().endsWith("/image")
        ) {
          privateCacheControl = res.headers()["cache-control"] ?? "";
        }
      });

      await page.goto("/my-books");
      await expect(
        page.getByRole("heading", { name: "Truyện Gia Đình Bé An" }),
      ).toBeVisible();

      await page.goto(`/my-books/${IDS.privateBook}`);
      await expect(
        page.getByRole("heading", { name: "Truyện Gia Đình Bé An" }),
      ).toBeVisible();

      await expect
        .poll(() =>
          tracker.requests.find((r) =>
            /^\/books\/my-books\/[^/]+\/pages\/[^/]+\/image$/.test(r.path),
          ),
        )
        .toBeDefined();
      const imageReq = tracker.requests.find((r) =>
        /^\/books\/my-books\/[^/]+\/pages\/[^/]+\/image$/.test(r.path),
      );
      expect(imageReq?.headers.authorization).toMatch(/^Bearer /);
      await expect.poll(() => privateCacheControl).toContain("private");
      expect(privateCacheControl).toContain("no-store");
      tracker.assertCleanHealth("T1-FA3-5");
    });
  });

  // =========================================================================
  // FA4: Reading Session, Lazy Panels & Voice Health (5 tests)
  // =========================================================================
  test.describe("FA4: Reading Session, Lazy Panels & Voice Health", () => {
    test("T1-FA4-1: /reading/[sessionId]?state=ready transitions via 'Bắt đầu đọc' to active reading canvas", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reading/${IDS.session1}?state=ready`);

      await expect(
        page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Bắt đầu đọc" }).click();
      await expect(page.getByText("Mình đang nghe bé đọc")).toBeVisible({
        timeout: 10_000,
      });
      tracker.assertCleanHealth("T1-FA4-1");
    });

    test("T1-FA4-2: reading page-turn and page picker dialog update page cleanly", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reading/${IDS.session1}?state=page-turn`);

      await expect(page.getByLabel("Trang sách 2")).toHaveAttribute(
        "data-page-revision-id",
        IDS.revision2,
      );
      await page
        .getByRole("button", { name: "Chọn trang", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Bé đang đọc trang nào?" }),
      ).toBeVisible();
      await page
        .getByRole("dialog", { name: "Bé đang đọc trang nào?" })
        .getByRole("button", { name: "Hủy", exact: true })
        .click();
      tracker.assertCleanHealth("T1-FA4-2");
    });

    test("T1-FA4-3: 'Giọng đọc' lazily mounts ReadingVoiceSettings with voice-health-status-pills and controls", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reading/${IDS.session1}?state=reading`);

      await expect(
        page.getByRole("dialog", { name: "Giọng đọc mẫu" }),
      ).toHaveCount(0);

      await page.getByRole("button", { name: "Giọng đọc" }).click();
      const dialog = page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByTestId("voice-health-status-pills"),
      ).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Chậm" })).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Miền Bắc" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA4-3");
    });

    test("T1-FA4-4: 'Nghe đánh vần' lazily opens PhonicsLessonCard and closes cleanly", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reading/${IDS.session1}?state=reading`);

      await expect(page.getByTestId("phonics-lesson-card")).toHaveCount(0);
      await page.getByRole("button", { name: "Nghe đánh vần" }).click();

      const card = page
        .getByTestId("phonics-lesson-card")
        .or(page.getByTestId("phonics-lesson-unsupported"));
      await expect(card).toBeVisible();

      await page
        .getByRole("button", { name: "Đóng hướng dẫn đánh vần" })
        .click();
      await expect(card).toHaveCount(0);
      tracker.assertCleanHealth("T1-FA4-4");
    });

    test("T1-FA4-5: finishing reading ('Xong' -> 'Lưu và dừng') loads SessionComplete and toggles spoken words", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reading/${IDS.session1}?state=reading`);

      await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
      await expect(
        page.getByRole("dialog", { name: "Bé muốn nghỉ hôm nay?" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Lưu và dừng" }).click();

      await expect(
        page.getByRole("heading", { name: "Buổi đọc đã hoàn thành" }),
      ).toBeVisible();
      const toggleBtn = page.getByRole("button", { name: "Xem từ bé đọc" });
      await expect(toggleBtn).toBeVisible();
      await toggleBtn.click();
      await expect(page.getByTestId("spoken-words-container")).toBeVisible();
      tracker.assertCleanHealth("T1-FA4-5");
    });
  });

  // =========================================================================
  // FA5: Progress Reports & Parallel Fetch (5 tests)
  // =========================================================================
  test.describe("FA5: Progress Reports & Parallel Fetch", () => {
    test("T1-FA5-1: /reports loads periods and progress cleanly and renders metric cards", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(
        `/reports?childId=${IDS.childA}&period_start=2026-10-01&period_end=2026-10-30`,
      );

      await expect(
        page.getByRole("heading", { name: "Tiến bộ của Bé An" }),
      ).toBeVisible();
      await expect(page.getByText("Buổi đọc hoàn thành")).toBeVisible();
      await expect(page.getByText("Thời gian đọc")).toBeVisible();
      expect(
        tracker.getAttemptCount(
          "GET",
          `/system/progress/${IDS.childA}/periods`,
        ),
      ).toBe(1);
      expect(
        tracker.getAttemptCount("GET", `/system/progress/${IDS.childA}`),
      ).toBe(1);
      tracker.assertCleanHealth("T1-FA5-1");
    });

    test("T1-FA5-2: child switcher on /reports switches to Bé Bình and fetches updated report", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto(`/reports?childId=${IDS.childA}`);
      await expect(
        page.getByRole("heading", { name: "Tiến bộ của Bé An" }),
      ).toBeVisible();

      await page
        .getByLabel("Chọn hồ sơ bé để xem dữ liệu")
        .selectOption(IDS.childB);
      await expect(page).toHaveURL(new RegExp(`childId=${IDS.childB}`));
      await expect(
        page.getByRole("heading", { name: "Tiến bộ của Bé Bình" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA5-2");
    });

    test("T1-FA5-3: period switcher and 'Tải thêm kỳ' load additional saved periods", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, { periodsHasMore: true });
      await page.goto(`/reports?childId=${IDS.childA}`);
      await expect(
        page.getByRole("heading", { name: "Tiến bộ của Bé An" }),
      ).toBeVisible();

      const loadMoreBtn = page.getByRole("button", { name: "Tải thêm kỳ" });
      await expect(loadMoreBtn).toBeVisible();
      await loadMoreBtn.click();

      const periodSelect = page.getByLabel("Kỳ báo cáo đã lưu");
      await expect(
        periodSelect.locator('option[value="2026-09-01/2026-09-30"]'),
      ).toHaveCount(1);
      await periodSelect.selectOption("2026-09-01/2026-09-30");
      await expect(page).toHaveURL(/period_start=2026-09-01/);
      tracker.assertCleanHealth("T1-FA5-3");
    });

    test("T1-FA5-4: difficult words list on /reports expands with 'Xem tất cả' and collapses with 'Thu gọn'", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, { difficultWordCount: 10 });
      await page.goto(`/reports?childId=${IDS.childA}`);

      const viewAllBtn = page.getByRole("button", { name: "Xem tất cả (10)" });
      await expect(viewAllBtn).toBeVisible();
      await viewAllBtn.click();

      const collapseBtn = page.getByRole("button", { name: "Thu gọn" });
      await expect(collapseBtn).toBeVisible();
      await collapseBtn.click();
      await expect(viewAllBtn).toBeVisible();
      tracker.assertCleanHealth("T1-FA5-4");
    });

    test("T1-FA5-5: /reports/difficult-words drilldown loads child difficult words", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, { difficultWordCount: 3 });
      await page.goto(`/reports/difficult-words?childId=${IDS.childA}`);

      await expect(
        page.getByRole("heading", { name: /Từ cần luyện của Bé An/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^Luyện từ Nghiêng\b/ }),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA5-5");
    });
  });

  // =========================================================================
  // FA6: Account Settings, Email Prefs & Support (5 tests)
  // =========================================================================
  test.describe("FA6: Account Settings, Email Prefs & Support", () => {
    test("T1-FA6-1: /settings loads account info <dl> cleanly with single /profiles/me read", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/settings");

      await expect(
        page.getByRole("heading", { name: "Cài đặt tài khoản" }),
      ).toBeVisible();
      await expect(
        page.getByRole("main").getByText("parent@example.test"),
      ).toBeVisible();
      await expect(
        page.getByRole("main").getByText("Ba mẹ ViRead"),
      ).toBeVisible();
      expect(tracker.getAttemptCount("GET", "/profiles/me")).toBe(1);
      tracker.assertCleanHealth("T1-FA6-1");
    });

    test("T1-FA6-2: language selector on /settings announces locale switch via role=status", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/settings");
      await expect(
        page.getByRole("heading", { name: "Cài đặt tài khoản" }),
      ).toBeVisible();

      await page
        .locator("main")
        .getByRole("button", { name: /Chọn ngôn ngữ giao diện|Language/i })
        .click();
      await page.locator('[role="option"][data-locale-code="en"]').click();
      await expect(
        page
          .locator("main")
          .locator('div[role="status"]')
          .filter({ hasText: /English/i }),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA6-2");
    });

    test("T1-FA6-3: password editor toggles open and shows current/new/confirm password inputs", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/settings");

      await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
      await expect(page.locator("#current-password")).toBeVisible();
      await expect(page.locator("#new-password")).toBeVisible();
      await expect(page.locator("#confirm-new-password")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Lưu mật khẩu mới" }),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA6-3");
    });

    test("T1-FA6-4: ParentEmailPreferencesCard toggles, saves settings, and sends test email", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/settings");

      const weeklySwitch = page.getByRole("switch", {
        name: /Báo cáo tiến độ học hàng tuần/,
      });
      await expect(weeklySwitch).toBeVisible();
      await weeklySwitch.click();

      await page.getByRole("button", { name: "Lưu cài đặt email" }).click();
      await expect
        .poll(() =>
          tracker.getAttemptCount("PUT", "/parent-notifications/preferences"),
        )
        .toBe(1);

      await page.getByRole("button", { name: "Gửi email thử nghiệm" }).click();
      await expect
        .poll(() =>
          tracker.getAttemptCount("POST", "/parent-notifications/test-email"),
        )
        .toBe(1);
      await expect(
        page.getByText("Đã gửi email thử nghiệm tới hộp thư phụ huynh."),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA6-4");
    });

    test("T1-FA6-5: /help-support opens feedback form and submits POST /support/feedback", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/help-support");

      await expect(
        page.getByRole("heading", { name: "Trợ giúp & hỗ trợ" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Gửi phản hồi" }).click();

      await page.getByLabel("Tiêu đề").fill("Kiểm tra góp ý");
      await page
        .getByLabel("Nội dung")
        .fill("Giao diện hoạt động mượt mà trên máy tính.");
      await page.getByRole("button", { name: "Gửi phản hồi" }).click();

      await expect
        .poll(() => tracker.getAttemptCount("POST", "/support/feedback"))
        .toBe(1);
      await expect(
        page.getByText(/Máy chủ email đã tiếp nhận phản hồi/),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA6-5");
    });
  });

  // =========================================================================
  // FA7: Cold-Start Retry (520–530), Cron Auth, Preview CORS & Error Boundaries (6 tests)
  // =========================================================================
  test.describe("FA7: Cold-Start Retry (520-530), Cron Auth & Recovery", () => {
    test("T1-FA7-1: api-client GET cold-start recovery 502 -> 200 on /books/catalog succeeds cleanly", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/books/catalog",
            sequence: [
              {
                status: 502,
                contentType: "text/html",
                body: "<html>Bad Gateway</html>",
              },
            ],
          },
        ],
      });
      await page.goto("/books");

      await expect(
        page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
      ).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/books/catalog"))
        .toBe(2);
      tracker.assertCleanHealth("T1-FA7-1", { expectedHttpStatuses: [502] });
    });

    test("T1-FA7-2: api-client GET Cloudflare 520 -> 200 and 524 -> 200 recover without error banner", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/books/catalog",
            sequence: [
              {
                status: 520,
                contentType: "text/html",
                body: "<html>Cloudflare 520</html>",
              },
            ],
          },
          {
            method: "GET",
            path: "/reading-management/collections",
            sequence: [
              {
                status: 524,
                contentType: "text/html",
                body: "<html>Cloudflare 524 Origin Time-out</html>",
              },
            ],
          },
        ],
      });
      await page.goto("/books");

      await expect(
        page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
      ).toBeVisible();
      await expect(page.getByText("Chưa tải được thư viện sách")).toHaveCount(
        0,
      );
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/books/catalog"))
        .toBe(2);
      await expect
        .poll(() =>
          tracker.getAttemptCount("GET", "/reading-management/collections"),
        )
        .toBe(2);
      tracker.assertCleanHealth("T1-FA7-2", {
        expectedHttpStatuses: [520, 524],
      });
    });

    test("T1-FA7-3: child-service GET 530 -> 200 on /profiles/children recovers transparently", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/profiles/children",
            sequence: [
              {
                status: 530,
                contentType: "text/html",
                body: "<html>Cloudflare 530 Origin DNS Error</html>",
              },
            ],
          },
        ],
      });
      await page.goto("/children");

      await expect(
        page.getByRole("link", { name: "Bé An, lớp 1" }),
      ).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/profiles/children"))
        .toBe(2);
      tracker.assertCleanHealth("T1-FA7-3", { expectedHttpStatuses: [530] });
    });

    test("T1-FA7-4: profile-service GET 522 -> 200 on /profiles/me recovers cleanly on /settings", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: "/profiles/me",
            sequence: [
              {
                status: 522,
                contentType: "text/html",
                body: "<html>Cloudflare 522 Connection Timed Out</html>",
              },
            ],
          },
        ],
      });
      await page.goto("/settings");

      await expect(
        page.getByRole("heading", { name: "Cài đặt tài khoản" }),
      ).toBeVisible();
      await expect(
        page.getByRole("main").getByText("parent@example.test"),
      ).toBeVisible();
      await expect
        .poll(() => tracker.getAttemptCount("GET", "/profiles/me"))
        .toBe(2);
      tracker.assertCleanHealth("T1-FA7-4", { expectedHttpStatuses: [522] });
    });

    test("T1-FA7-5: adaptive-learning-service GET 520 -> 200 on recommendations recovers on /entertainment", async ({
      page,
    }) => {
      const tracker = await installMockApi(page, {
        faults: [
          {
            method: "GET",
            path: new RegExp("^/learning/children/[^/]+/recommendations$"),
            sequence: [
              {
                status: 520,
                contentType: "text/html",
                body: "<html>Cloudflare 520 Web Server Returned an Unknown Error</html>",
              },
            ],
          },
        ],
      });
      await page.goto("/entertainment");

      await expect(page.getByText("Kể chuyện qua tranh").first()).toBeVisible();
      await expect
        .poll(() =>
          tracker.getAttemptCount(
            "GET",
            `/learning/children/${IDS.childA}/recommendations`,
          ),
        )
        .toBe(2);
      tracker.assertCleanHealth("T1-FA7-5", { expectedHttpStatuses: [520] });
    });

    test("T1-FA7-6: /api/cron/parent-emails fails closed (401/503) without valid Bearer secret", async ({
      request,
    }) => {
      const res = await request.get("/api/cron/parent-emails");
      expect([401, 503]).toContain(res.status());
      const json = (await res.json()) as { ok?: boolean; error?: string };
      expect(json.ok).toBe(false);
      expect(["UNAUTHORIZED", "CRON_SECRET_NOT_CONFIGURED"]).toContain(
        json.error,
      );
    });
  });

  // =========================================================================
  // FA8: Asset Optimization, Security Headers & Responsive Parity (5 tests)
  // =========================================================================
  test.describe("FA8: Asset Optimization, Security Headers & Responsive Parity", () => {
    test("T1-FA8-1: /entertainment/picture-description loads all 3 sample images cleanly", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/entertainment/picture-description");

      for (const fileName of [
        "happy-classroom.jpg",
        "lakeside-picnic.jpg",
        "sunny-garden.jpg",
      ]) {
        const res = await page.request.get(
          `/images/picture-description/${fileName}`,
        );
        expect(res.status()).toBe(200);
        const body = await res.body();
        expect(body.byteLength).toBeGreaterThan(1000);
      }

      const imgs = page.locator("img");
      await expect(imgs.first()).toBeVisible();
      await expect(imgs).toHaveCount(3);
      const allLoaded = await imgs.evaluateAll((els) =>
        els.every(
          (el) =>
            el instanceof HTMLImageElement &&
            el.complete &&
            el.naturalWidth > 0,
        ),
      );
      expect(allLoaded).toBe(true);
      tracker.assertCleanHealth("T1-FA8-1");
    });

    test("T1-FA8-2: security response headers are enforced on App Router responses", async ({
      page,
    }) => {
      await seedParentSession(page.context());
      const response = await page.goto("/login?state=default");
      expect(response).not.toBeNull();
      const headers = response!.headers();

      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["content-security-policy"]).toContain(
        "default-src 'self'",
      );
      expect(headers["permissions-policy"]).toContain("camera=(self)");
      expect(headers["permissions-policy"]).toContain("microphone=(self)");
    });

    test("T1-FA8-3: unknown route renders /not-found fallback with Vietnamese title and recovery links", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      await page.goto("/nonexistent-viread-smoothness-route");

      await expect(
        page.getByRole("heading", { name: "Không tìm thấy trang" }),
      ).toBeVisible();
      await expect(
        page.locator('a[href="/dashboard"], a[href="/login"]').first(),
      ).toBeVisible();
      tracker.assertCleanHealth("T1-FA8-3", { expectedHttpStatuses: [404] });
    });

    test("T1-FA8-4: zero horizontal overflow and >=24px interactive targets on core routes", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      for (const route of ["/dashboard", "/books", "/reports", "/settings"]) {
        await page.goto(route);
        await expect(page.locator("h1:visible").first()).toBeVisible();
        await assertNoHorizontalOverflow(page, route);

        const smallTargets = await page.evaluate(() => {
          const elements = Array.from(
            document.querySelectorAll<HTMLElement>("main button, main a[href]"),
          );
          return elements
            .map((el) => {
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return {
                text: (
                  el.innerText ||
                  el.getAttribute("aria-label") ||
                  ""
                ).trim(),
                width: rect.width,
                height: rect.height,
                visible:
                  style.display !== "none" && style.visibility !== "hidden",
              };
            })
            .filter(
              (item) =>
                item.visible &&
                item.width > 0 &&
                item.height > 0 &&
                (item.width < 24 || item.height < 24),
            );
        });
        expect(smallTargets, `Touch target <24px on ${route}`).toEqual([]);
      }
      tracker.assertCleanHealth("T1-FA8-4");
    });

    test("T1-FA8-5: zero uncaught console errors, page errors, or 5xx responses during core navigation", async ({
      page,
    }) => {
      const tracker = await installMockApi(page);
      for (const route of [
        "/dashboard",
        "/children",
        "/books",
        "/reports",
        "/settings",
      ]) {
        await page.goto(route);
        await expect(page.locator("h1:visible").first()).toBeVisible();
      }
      tracker.assertCleanHealth("T1-FA8-5");
    });
  });
});
