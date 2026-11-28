import { expect, test } from "@playwright/test";

import { IDS, installMockApi } from "./fixtures/mock-api";

/**
 * Tier 3 Pairwise Combinatorial Coverage Matrix — All C(8,2) = 28 pairs of FA1..FA8:
 *
 * - T3-01 (FA1, FA2, FA3, FA4): (1,2), (1,3), (1,4), (2,3), (2,4), (3,4)
 * - T3-02 (FA1, FA5, FA6, FA7): (1,5), (1,6), (1,7), (5,6), (5,7), (6,7)
 * - T3-03 (FA2, FA4, FA5, FA8): (2,4), (2,5), (2,8), (4,5), (4,8), (5,8)
 * - T3-04 (FA3, FA6, FA7, FA8): (3,6), (3,7), (3,8), (6,7), (6,8), (7,8)
 * - T3-05 (FA1, FA3, FA5, FA8): (1,3), (1,5), (1,8), (3,5), (3,8), (5,8)
 * - T3-06 (FA2, FA3, FA6, FA7): (2,3), (2,6), (2,7), (3,6), (3,7), (6,7)
 * - T3-07 (FA4, FA6, FA7, FA8): (4,6), (4,7), (4,8), (6,7), (6,8), (7,8)
 * - T3-08 (FA1, FA2, FA6, FA8): (1,2), (1,6), (1,8), (2,6), (2,8), (6,8)
 * - T3-09 (FA2, FA5, FA7):      (2,5), (2,7), (5,7)
 * - T3-10 (FA3, FA4, FA7):      (3,4), (3,7), (4,7)
 *
 * Union covers all 28 pairs: (1,2..8)=7, (2,3..8)=6, (3,4..8)=5, (4,5..8)=4, (5,6..8)=3, (6,7..8)=2, (7,8)=1 -> 28/28.
 */
test.describe("Tier 3: Pairwise Feature Combinations (All 28 FA Pairs)", () => {
  test("T3-01 [FA1+FA2+FA3+FA4]: authenticated child selection -> catalog cover -> reading ready & finish", async ({
    browser,
    page,
  }) => {
    const anonContext = await browser.newContext({ extraHTTPHeaders: {} });
    const anonPage = await anonContext.newPage();
    await anonPage.goto("/dashboard");
    await expect(anonPage).toHaveURL(/\/login\?next=%2Fdashboard/);
    await anonContext.close();

    const tracker = await installMockApi(page, { selectedChildId: null });

    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Góc đọc gia đình" }),
    ).toBeVisible();
    await expect
      .poll(() => tracker.getAttemptCount("GET", "/profiles/dashboard-summary"))
      .toBe(1);
    const childBtn = page.getByRole("button", { name: "Bé Bình, lớp 2" });
    await childBtn.click();
    await expect(childBtn).toHaveAttribute("aria-pressed", "true");

    await page.goto("/books");
    await expect(
      page.getByRole("heading", { name: "Tủ sách của Bé Bình" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Khu Vườn Mùa Xuân" }),
    ).toBeVisible();

    await page.goto(`/reading/${IDS.session1}?state=ready`);
    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();
    await expect(page.getByText("Mình đang nghe bé đọc")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
    await page.getByRole("button", { name: "Lưu và dừng" }).click();
    await expect(
      page.getByRole("heading", { name: "Buổi đọc đã hoàn thành" }),
    ).toBeVisible();
    tracker.assertCleanHealth("T3-01");
  });

  test("T3-02 [FA1+FA5+FA6+FA7]: unauthenticated /settings guard -> transient 520 on /settings & 502 on /reports recover cleanly", async ({
    browser,
    page,
  }) => {
    const anonContext = await browser.newContext({ extraHTTPHeaders: {} });
    const anonPage = await anonContext.newPage();
    await anonPage.goto("/settings");
    await expect(anonPage).toHaveURL(/\/login\?next=%2Fsettings/);
    await anonContext.close();

    const tracker = await installMockApi(page, {
      faults: [
        {
          method: "GET",
          path: "/profiles/me",
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
          path: `/system/progress/${IDS.childA}`,
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

    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Cài đặt tài khoản" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Lưu cài đặt email" }).click();

    await page.goto(`/reports?childId=${IDS.childA}`);
    await expect(page.getByText("Buổi đọc hoàn thành")).toBeVisible();
    await expect
      .poll(() => tracker.getAttemptCount("GET", "/profiles/me"))
      .toBe(2);
    await expect
      .poll(() =>
        tracker.getAttemptCount("GET", `/system/progress/${IDS.childA}`),
      )
      .toBe(2);
    tracker.assertCleanHealth("T3-02", { expectedHttpStatuses: [520, 502] });
  });

  test("T3-03 [FA2+FA4+FA5+FA8]: child switch propagates to /reports and reading screen with zero overflow", async ({
    page,
  }) => {
    const tracker = await installMockApi(page, { selectedChildId: null });

    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Bé Bình, lớp 2" }).click();

    await page.goto("/books");
    await expect(
      page.getByRole("heading", { name: "Tủ sách của Bé Bình" }),
    ).toBeVisible();

    await page.goto(`/reports?childId=${IDS.childB}`);
    await expect(
      page.getByRole("heading", { name: "Tiến bộ của Bé Bình" }),
    ).toBeVisible();

    await page.goto(`/reading/${IDS.session1}?state=reading`);
    await expect(page.getByText("Mình đang chờ bé")).toBeVisible();
    await page
      .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
      .click();
    await expect(page.getByText("Mình đang nghe bé đọc")).toBeVisible();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
    tracker.assertCleanHealth("T3-03");
  });

  test("T3-04 [FA3+FA6+FA7+FA8]: private book media (no-store) + 524 retry + feedback + picture assets", async ({
    page,
  }) => {
    const tracker = await installMockApi(page, {
      faults: [
        {
          method: "GET",
          path: "/books/my-books/paged",
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

    await page.goto("/my-books");
    await expect(
      page.getByRole("heading", { name: "Truyện Gia Đình Bé An" }),
    ).toBeVisible();
    await expect
      .poll(() => tracker.getAttemptCount("GET", "/books/my-books/paged"))
      .toBe(2);

    await page.goto("/help-support");
    await page.getByRole("button", { name: "Gửi phản hồi" }).click();
    await page.getByLabel("Tiêu đề").fill("Sách riêng rất tốt");
    await page.getByLabel("Nội dung").fill("Tải trang nhanh và rõ chữ.");
    await page.getByRole("button", { name: "Gửi phản hồi" }).click();
    await expect(
      page.getByText(/Máy chủ email đã tiếp nhận phản hồi/),
    ).toBeVisible();

    await page.goto("/entertainment/picture-description");
    const imgRes = await page.request.get(
      "/images/picture-description/sunny-garden.jpg",
    );
    expect(imgRes.status()).toBe(200);
    tracker.assertCleanHealth("T3-04", { expectedHttpStatuses: [524] });
  });

  test("T3-05 [FA1+FA3+FA5+FA8]: auth guard check -> catalog favorite -> difficult words -> 404 fallback", async ({
    browser,
    page,
  }) => {
    const anonContext = await browser.newContext({ extraHTTPHeaders: {} });
    const anonPage = await anonContext.newPage();
    await anonPage.goto("/books");
    await expect(anonPage).toHaveURL(/\/login\?next=%2Fbooks/);
    await anonContext.close();

    const tracker = await installMockApi(page);

    await page.goto("/books");
    const favBtn = page.getByRole("button", { name: /yêu thích/i }).first();
    await favBtn.click();
    await expect(favBtn).toHaveAttribute("aria-pressed", "true");

    await page.goto(`/reports/difficult-words?childId=${IDS.childA}`);
    await expect(
      page.getByRole("heading", { name: /Từ cần luyện của Bé An/ }),
    ).toBeVisible();

    const notFoundRes = await page.goto("/nonexistent-tier3-check");
    expect(notFoundRes?.headers()["x-content-type-options"]).toBe("nosniff");
    await expect(
      page.getByRole("heading", { name: "Không tìm thấy trang" }),
    ).toBeVisible();
    tracker.assertCleanHealth("T3-05", { expectedHttpStatuses: [404] });
  });

  test("T3-06 [FA2+FA3+FA6+FA7]: create child + 530 retry + catalog grade filter + settings language switch", async ({
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

    await page.goto("/children/new");
    await page.getByLabel("Tên gọi của bé").fill("Bé Minh");
    await page.getByLabel("Lớp của bé").selectOption("2");
    await page.getByRole("button", { name: "Lưu hồ sơ" }).click();
    await expect
      .poll(() => tracker.getAttemptCount("POST", "/profiles/children"))
      .toBe(1);
    await expect(
      page.getByRole("heading", { name: "Hồ sơ của Bé Minh" }),
    ).toBeVisible();

    await page.goto("/books");
    await page.getByRole("button", { name: "Lớp 1" }).click();
    await expect(
      page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
    ).toBeVisible();

    await page.goto("/settings");
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
    tracker.assertCleanHealth("T3-06", { expectedHttpStatuses: [530] });
  });

  test("T3-07 [FA4+FA6+FA7+FA8]: lazy reading modals + picture assets + settings email prefs + POST 520 non-retry", async ({
    page,
  }) => {
    const tracker = await installMockApi(page, {
      faults: [
        {
          method: "POST",
          path: "/parent-notifications/test-email",
          sequence: [
            {
              status: 520,
              contentType: "text/html",
              body: "<html>Cloudflare 520</html>",
            },
          ],
        },
      ],
    });

    await page.goto(`/reading/${IDS.session1}?state=reading`);
    await page.getByRole("button", { name: "Giọng đọc" }).click();
    await expect(page.getByTestId("voice-health-status-pills")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Nghe đánh vần" }).click();
    await expect(
      page
        .getByTestId("phonics-lesson-card")
        .or(page.getByTestId("phonics-lesson-unsupported")),
    ).toBeVisible();

    await page.goto("/settings");
    await page.getByRole("button", { name: "Gửi email thử nghiệm" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await expect
      .poll(() =>
        tracker.getAttemptCount("POST", "/parent-notifications/test-email"),
      )
      .toBe(1);

    await page.goto("/entertainment/picture-description");
    const picRes = await page.request.get(
      "/images/picture-description/lakeside-picnic.jpg",
    );
    expect(picRes.status()).toBe(200);
    tracker.assertCleanHealth("T3-07", { expectedHttpStatuses: [520] });
  });

  test("T3-08 [FA1+FA2+FA6+FA8]: child selection + /settings inspection + responsive AccountAvatarMenu sign-out", async ({
    page,
  }) => {
    const tracker = await installMockApi(page, { selectedChildId: null });

    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Bé Bình, lớp 2" }).click();

    await page.goto("/settings");
    await expect(
      page.getByRole("main").getByText("parent@example.test"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Mở menu tài khoản" }).click();
    await page.getByRole("menuitem", { name: "Đăng xuất" }).click();
    await expect(page).toHaveURL(/\/login/);
    tracker.assertCleanHealth("T3-08");
  });

  test("T3-09 [FA2+FA5+FA7]: child switch on /reports during transient 522 & period pagination", async ({
    page,
  }) => {
    const tracker = await installMockApi(page, {
      periodsHasMore: true,
      faults: [
        {
          method: "GET",
          path: `/system/progress/${IDS.childB}/periods`,
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

    await page.goto(`/reports?childId=${IDS.childA}`);
    await page
      .getByLabel("Chọn hồ sơ bé để xem dữ liệu")
      .selectOption(IDS.childB);

    await expect(
      page.getByRole("heading", { name: "Tiến bộ của Bé Bình" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Tải thêm kỳ" }).click();
    await expect
      .poll(() =>
        tracker.getAttemptCount(
          "GET",
          `/system/progress/${IDS.childB}/periods`,
        ),
      )
      .toBe(3);
    tracker.assertCleanHealth("T3-09", { expectedHttpStatuses: [522] });
  });

  test("T3-10 [FA3+FA4+FA7]: book detail preview with 502 recovery -> reading session voice/phonics panels", async ({
    page,
  }) => {
    const tracker = await installMockApi(page, {
      faults: [
        {
          method: "GET",
          path: `/books/catalog/${IDS.book1}/preview`,
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

    await page.goto(`/books/${IDS.book1}`);
    await expect(page.getByAltText("Ảnh xem trước trang 1")).toBeVisible();
    await expect
      .poll(() =>
        tracker.getAttemptCount("GET", `/books/catalog/${IDS.book1}/preview`),
      )
      .toBe(2);

    await page.goto(`/reading/${IDS.session1}?state=ready`);
    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();
    await page.getByRole("button", { name: "Giọng đọc" }).click();
    await expect(
      page.getByRole("dialog", { name: "Giọng đọc mẫu" }),
    ).toBeVisible();
    tracker.assertCleanHealth("T3-10", { expectedHttpStatuses: [502] });
  });
});
