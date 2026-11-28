import { expect, test } from "@playwright/test";
import {
  assertCleanHarness,
  attachPageErrorCollector,
  defaultBooks,
  ids,
  installE2eSuiteFixture,
} from "./fixtures";
import {
  assert200PercentZoomReachable,
  assertLoadedImages,
  assertTouchTargetsAndNoOverlap,
  assertUnobstructedReadingCanvas,
  assertZeroHorizontalOverflow,
  waitForRouteSettled,
} from "./geometry-audit";

test.describe("Tier 2: Geometry, Touch Targets, Zoom & Error Boundaries", () => {
  test("Zero horizontal overflow and valid images: Auth, Family, Books & Reading routes", async ({
    page,
  }, testInfo) => {
    test.slow();
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      populatedSessionReports: true,
    });
    const errors = attachPageErrorCollector(page);

    const routes = [
      "/login",
      "/register",
      "/forgot-password",
      "/reset-password",
      "/dashboard",
      "/children",
      "/children/new",
      `/children/${ids.child1}`,
      "/profile",
      "/settings",
      "/help-support",
      "/books",
      `/books/${ids.book1}`,
      `/reading-preparation?bookId=${ids.book1}&pageId=${ids.page1}&endPageId=${ids.page2}`,
      `/reading/${ids.session1}?state=reading`,
    ];

    for (const routePath of routes) {
      await page.goto(routePath);
      await waitForRouteSettled(page);
      await assertZeroHorizontalOverflow(
        page,
        `${testInfo.project.name}:${routePath}`,
      );
      await assertLoadedImages(page, `${testInfo.project.name}:${routePath}`);
    }

    assertCleanHarness(state, errors);
  });

  test("Zero horizontal overflow and valid images: Reports, Management, Entertainment & Karaoke routes", async ({
    page,
  }, testInfo) => {
    test.slow();
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      populatedSessionReports: true,
    });
    const errors = attachPageErrorCollector(page);

    const routes = [
      "/reports",
      "/reports/difficult-words",
      "/book-reports",
      "/sessions",
      `/sessions/${ids.session1}`,
      `/sessions/${ids.session1}/report`,
      "/my-books",
      `/my-books/${ids.privateBook1}`,
      "/book-scanner",
      "/studio/tasks",
      "/reading-management",
      "/entertainment",
      "/entertainment/memory-game",
      "/entertainment/picture-description",
      "/entertainment/sentence-shooter",
      "/karaoke",
      `/karaoke/${ids.song1}`,
    ];

    for (const routePath of routes) {
      await page.goto(routePath);
      await waitForRouteSettled(page);
      await assertZeroHorizontalOverflow(
        page,
        `${testInfo.project.name}:${routePath}`,
      );
      await assertLoadedImages(page, `${testInfo.project.name}:${routePath}`);
    }

    assertCleanHarness(state, errors);
  });

  test("Touch targets >= 44px & no overlap: /dashboard", async ({
    page,
  }, testInfo) => {
    const touchMinSize = testInfo.project.name === "mobile" ? 44 : 36;
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto("/dashboard");
    await assertTouchTargetsAndNoOverlap(
      page,
      [
        page.getByRole("button", { name: "Bé An, lớp 2" }),
        page.getByRole("link", { name: "Quản lý hồ sơ" }),
      ],
      `${testInfo.project.name}:/dashboard`,
      touchMinSize,
    );

    assertCleanHarness(state, errors);
  });

  test("Touch targets >= 44px & no overlap: /books (grade pills & card actions)", async ({
    page,
  }, testInfo) => {
    const touchMinSize = testInfo.project.name === "mobile" ? 44 : 36;
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto("/books");
    await assertTouchTargetsAndNoOverlap(
      page,
      [
        page.getByRole("button", { name: "Tất cả", exact: true }),
        page.getByRole("button", { name: "Lớp 1", exact: true }),
        page.getByRole("link", { name: `Đọc sách ${defaultBooks[0].title}` }),
        page.getByRole("button", {
          name: `Bỏ ${defaultBooks[0].title} yêu thích`,
        }),
      ],
      `${testInfo.project.name}:/books`,
      touchMinSize,
    );

    assertCleanHarness(state, errors);
  });

  test("Touch targets >= 44px & no overlap: /entertainment (hub-child-selector & preference toggles)", async ({
    page,
  }, testInfo) => {
    const touchMinSize = testInfo.project.name === "mobile" ? 44 : 36;
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto("/entertainment");
    await assertTouchTargetsAndNoOverlap(
      page,
      [
        page.getByTestId("hub-child-selector"),
        page.getByRole("button", { name: /Âm thanh dịu/ }),
        page.getByRole("button", { name: /Giảm chuyển động/ }),
        page.getByRole("button", { name: /Hướng dẫn/ }),
      ],
      `${testInfo.project.name}:/entertainment`,
      touchMinSize,
    );

    assertCleanHarness(state, errors);
  });

  test("Touch targets >= 44px & no overlap: /karaoke (Về Tổng quan & song link)", async ({
    page,
  }, testInfo) => {
    const touchMinSize = testInfo.project.name === "mobile" ? 44 : 36;
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto("/karaoke");
    await assertTouchTargetsAndNoOverlap(
      page,
      [
        page.getByRole("link", { name: "Về Tổng quan", exact: true }),
        page.getByRole("link", { name: "Hát bài Ngôi sao nhỏ" }),
      ],
      `${testInfo.project.name}:/karaoke`,
      touchMinSize,
    );

    assertCleanHarness(state, errors);
  });

  test("Touch targets >= 44px & cross-container overlap check: /reading-preparation", async ({
    page,
  }, testInfo) => {
    const touchMinSize = testInfo.project.name === "mobile" ? 44 : 36;
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(
      `/reading-preparation?bookId=${ids.book1}&pageId=${ids.page1}&endPageId=${ids.page2}`,
    );
    await expect(
      page.getByRole("heading", { name: "Chuẩn bị đọc sách" }),
    ).toBeVisible();
    await assertTouchTargetsAndNoOverlap(
      page,
      [
        page.getByRole("button", { name: /Kiểm tra và cấp quyền microphone/ }),
        page.getByRole("button", { name: "Bắt đầu đọc" }),
        page.getByRole("link", { name: "Quay lại chi tiết sách" }),
      ],
      `${testInfo.project.name}:/reading-preparation`,
      touchMinSize,
    );

    assertCleanHarness(state, errors);
  });

  test("Touch targets >= 44px & no overlap: /reading/[sessionId]", async ({
    page,
  }, testInfo) => {
    const touchMinSize = testInfo.project.name === "mobile" ? 44 : 36;
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=reading`);
    await expect(
      page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    ).toBeVisible();
    await assertTouchTargetsAndNoOverlap(
      page,
      [
        page.getByRole("button", { name: "Nghe đánh vần" }),
        page.getByRole("button", { name: "Nhờ gia sư giúp đọc" }),
        page.getByRole("button", { name: "Tạm dừng buổi đọc" }),
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
        page.getByRole("button", { name: "Giọng đọc", exact: true }),
        page.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
        page.getByRole("button", { name: "Kết thúc buổi đọc" }),
      ],
      `${testInfo.project.name}:/reading`,
      touchMinSize,
    );

    assertCleanHarness(state, errors);
  });

  test("Touch targets >= 44px & no overlap: /my-books/[bookId]", async ({
    page,
  }, testInfo) => {
    const touchMinSize = testInfo.project.name === "mobile" ? 44 : 36;
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/my-books/${ids.privateBook1}`);
    await expect(
      page.getByRole("heading", { name: "Truyện cổ tích gia đình" }),
    ).toBeVisible();
    await assertTouchTargetsAndNoOverlap(
      page,
      [
        page.getByRole("link", { name: "Quay lại Sách của tôi" }),
        page.getByRole("button", { name: "Làm mới trạng thái" }),
        page.getByRole("link", { name: "Mở đọc cùng bé" }),
        page.getByRole("button", { name: "Sửa sách" }),
        page.getByRole("button", { name: "Xóa sách" }),
      ],
      `${testInfo.project.name}:/my-books/${ids.privateBook1}`,
      touchMinSize,
    );

    assertCleanHarness(state, errors);
  });

  test("F6: Unobstructed child reading canvas & compact mobile top header footprint", async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      readingImageMode: "missing",
      readingLineCount: 40,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=reading`);
    await expect(
      page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    ).toBeVisible();

    await assertZeroHorizontalOverflow(
      page,
      `${testInfo.project.name}:reading`,
    );
    await assertUnobstructedReadingCanvas(
      page,
      `${testInfo.project.name}:reading`,
      { isMobile },
    );

    assertCleanHarness(state, errors);
  });

  test("F6 active state: PhonicsLessonCard open does not obscure visible reading words", async ({
    page,
  }, testInfo) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      readingImageMode: "missing",
      readingLineCount: 40,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=reading`);
    await page.getByRole("button", { name: "Nghe đánh vần" }).click();
    await expect(page.getByTestId("phonics-lesson-card")).toBeVisible();

    await assertUnobstructedReadingCanvas(
      page,
      `${testInfo.project.name}:reading-phonics`,
      { skipMobileTopChromeCheck: true },
    );

    assertCleanHarness(state, errors);
  });

  test("F6 active state: ?state=tts-error banner does not obscure visible reading words", async ({
    page,
  }, testInfo) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      readingImageMode: "missing",
      readingLineCount: 40,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=tts-error`);
    await expect(page.getByTestId("tts-error-banner")).toBeVisible();

    await assertUnobstructedReadingCanvas(
      page,
      `${testInfo.project.name}:reading-tts-error`,
      { skipMobileTopChromeCheck: true },
    );

    assertCleanHarness(state, errors);
  });

  test("F6 active state: scrolled resume-auto-follow-btn does not obscure visible reading words", async ({
    page,
  }, testInfo) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      readingImageMode: "missing",
      readingLineCount: 40,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=reading`);
    const scrollContainer = page.locator(
      '[data-reading-scroll-container="true"]',
    );
    await expect(scrollContainer).toBeVisible();
    // Wait past PROGRAMMATIC_INSTANT_GUARD_MS (160ms) before manual scroll
    await page.waitForTimeout(220);
    await scrollContainer.hover();
    await page.mouse.wheel(0, 320);
    await scrollContainer.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(scrollContainer).toHaveAttribute("data-auto-follow", "paused");
    await expect(page.getByTestId("resume-auto-follow-btn")).toBeVisible();

    await assertUnobstructedReadingCanvas(
      page,
      `${testInfo.project.name}:reading-scrolled`,
      { skipMobileTopChromeCheck: true },
    );

    assertCleanHarness(state, errors);
  });

  test("F9: 200% zoom reachability without ellipsis truncation", async ({
    page,
  }, testInfo) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      readingImageMode: "broken",
      readingLineCount: 25,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=reading`);
    await expect(
      page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    ).toBeVisible();

    await assert200PercentZoomReachable(
      page,
      `${testInfo.project.name}:zoom200`,
    );

    assertCleanHarness(state, errors);
  });

  test("F9: Reference page disclosure (<summary>Xem ảnh trang sách</summary>) reachable during 200% zoom", async ({
    page,
  }, testInfo) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      readingImageMode: "valid",
      readingLineCount: 40,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=reading`);
    await expect(
      page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    ).toBeVisible();

    const viewport = page.viewportSize()!;
    const refSummary = page.getByText("Xem ảnh trang sách");
    const controls = page.locator("[data-reading-controls]");

    // 1. At 100% zoom, expanding reference disclosure must keep controls inside viewport
    await expect(
      refSummary,
      `[${testInfo.project.name}] Reference summary should be visible at 100% zoom`,
    ).toBeVisible();
    await refSummary.click();
    const controlsAt100 = await controls.boundingBox();
    expect(controlsAt100).not.toBeNull();
    expect(controlsAt100!.y + controlsAt100!.height).toBeLessThanOrEqual(
      viewport.height + 2,
    );
    await refSummary.click();

    // 2. At 200% zoom, disclosure remains visible & clickable and controls stay reachable without horizontal overflow
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await expect(
      refSummary,
      `[${testInfo.project.name}] Reference summary should be visible during 200% zoom`,
    ).toBeVisible();
    await refSummary.click();
    await controls.scrollIntoViewIfNeeded();
    await expect(controls).toBeVisible();
    await assertZeroHorizontalOverflow(
      page,
      `${testInfo.project.name}:zoom200-ref-image`,
      2,
    );
    const controlsAt200 = await controls.boundingBox();
    expect(controlsAt200).not.toBeNull();
    expect(controlsAt200!.x).toBeGreaterThanOrEqual(0);
    expect(controlsAt200!.x + controlsAt200!.width).toBeLessThanOrEqual(
      viewport.width + 2,
    );

    assertCleanHarness(state, errors);
  });

  test("Negative & boundary states: missing child redirect, invalid karaoke UUID 404, reports 503, denied mic", async ({
    page,
  }) => {
    // 1. Missing child redirects to /dashboard?focus=child-selection&reason=missing
    const state = await installE2eSuiteFixture(page, {
      seedChildId: null,
      reportStatus: 503,
      denyMicrophone: true,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto("/books");
    await expect(page).toHaveURL(
      /\/dashboard\?focus=child-selection&reason=missing/,
    );
    await expect(
      page.getByText(
        "Vui lòng chọn hồ sơ trẻ trước khi bắt đầu đọc hoặc chơi.",
      ),
    ).toBeVisible();

    // 2. Reports 503 degrades gracefully without leaking raw detail
    await page.goto("/reports");
    await expect(
      page.getByRole("heading", { name: /Tiến bộ của Bé An/ }),
    ).toBeVisible();
    await expect(page.getByText("Unavailable")).toHaveCount(0);

    // 3. Invalid karaoke songId UUID -> Next.js NotFound UI
    await page.goto("/karaoke/not-a-uuid");
    await expect(
      page.getByRole("heading", { name: "Không tìm thấy trang" }),
    ).toBeVisible();

    // 4. Denied microphone -> safe dialog, zero reading events
    await page.goto(`/reading/${ids.session1}?state=reading`);
    await page
      .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Mình chưa nghe thấy giọng bé" }),
    ).toBeVisible();
    expect(state.readingEvents).toEqual([]);
    expect(state.sttRequests).toBe(0);

    assertCleanHarness(state, errors);
  });
});
