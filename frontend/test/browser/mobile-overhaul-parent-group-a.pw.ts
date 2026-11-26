import { expect, test } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  assertNoRawBackendLeak,
  assertTouchTargetsMin44,
  assertZeroRuntimeErrors,
  installMobileOverhaulFixture,
  MOBILE_IDS,
  normalizeProjectBucket,
  selectChildViaUi,
} from "./mobile-overhaul-fixture";

const TINY_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.describe("E2E-F2: Parent Group A Routes", () => {
  test.describe("Tier 1: Mobile vs Desktop Functional Parity", () => {
    test("/dashboard selects child, exposes resumable/choose-book CTA, and renders mobile quick shortcuts (<768px)", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page, {
        resumableSession: true,
      });
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { level: 1, name: "Góc đọc gia đình" }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Bé An, lớp 2" }).click();
      await expect(page.getByRole("link", { name: /Đọc tiếp/ })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Chọn sách", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Quản lý hồ sơ" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Tạo hồ sơ bé" }),
      ).toBeVisible();

      const progressShortcut = page.getByRole("link", {
        name: "Xem tiến bộ",
        exact: true,
      });
      const difficultShortcut = page.getByRole("link", {
        name: "Từ cần luyện",
        exact: true,
      });
      if (bucket === "mobile-390x844") {
        await expect(progressShortcut).toBeVisible();
        await expect(difficultShortcut).toBeVisible();
      } else {
        await expect(progressShortcut).toBeHidden();
      }

      // Switching to Bé Bình (no resumable session) updates desk to Chọn sách
      await page.getByRole("button", { name: "Bé Bình, lớp 1" }).click();
      await expect(
        page.getByRole("button", { name: /Chọn sách/ }),
      ).toBeVisible();

      assertZeroRuntimeErrors(state);
    });

    test("/books filters by grade & search, toggles favorites/want-to-read, and opens book details", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      await page.goto("/books");
      await expect(
        page.getByRole("heading", { level: 1, name: "Tủ sách của Bé An" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Sách của tôi" }),
      ).toBeVisible();

      // Grade pills & search
      await page.getByRole("button", { name: "Tất cả", exact: true }).click();
      await expect(
        page.getByRole("link", { name: /Đọc sách Chào ngày mới cùng Bé An/ }),
      ).toBeVisible();

      const searchInput = page.getByRole("searchbox", {
        name: "Tìm theo tên sách hoặc tác giả",
      });
      await searchInput.fill("Khu vườn");
      await expect(
        page.getByRole("link", { name: /Đọc sách Khu vườn mùa thu/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: /Đọc sách Chào ngày mới/ }),
      ).toHaveCount(0);
      await searchInput.fill("");

      // Collection toggles (Yêu thích / Muốn đọc)
      const favBtn = page.getByRole("button", {
        name: "Thêm Chào ngày mới cùng Bé An yêu thích",
      });
      await favBtn.click();
      await expect(
        page.getByRole("button", {
          name: "Bỏ Chào ngày mới cùng Bé An yêu thích",
        }),
      ).toHaveAttribute("aria-pressed", "true");

      await page
        .getByRole("link", { name: "Đọc sách Chào ngày mới cùng Bé An" })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/books/${MOBILE_IDS.bookPrimary}$`),
      );

      assertZeroRuntimeErrors(state);
    });

    test("/books/[bookId] adjusts page range, opens BookContentReportDialog, and navigates to /book-reports", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      await page.goto(`/books/${MOBILE_IDS.bookPrimary}`);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Chào ngày mới cùng Bé An",
        }),
      ).toBeVisible();

      const endPageSelect = page.locator("#reading-end-page");
      await expect(endPageSelect).toBeVisible();
      const optionValues = await endPageSelect
        .locator("option")
        .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
      expect(optionValues.length).toBeGreaterThanOrEqual(2);
      await endPageSelect.selectOption(optionValues[1]);
      await expect(
        page.getByRole("heading", { level: 2, name: /Phạm vi đọc: Trang 1–2/ }),
      ).toBeVisible();

      // Submit page error report
      await page.getByRole("button", { name: "Báo lỗi trang này" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog
        .locator("#book-report-description")
        .fill("Thiếu dấu sắc ở chữ nắng trên trang 1.");
      await dialog.getByRole("button", { name: "Gửi báo cáo" }).click();
      await expect(
        dialog.getByText("Báo cáo đã được lưu thành công."),
      ).toBeVisible();
      await dialog.getByRole("link", { name: "Xem báo cáo của tôi" }).click();
      await expect(page).toHaveURL(/\/book-reports$/);

      assertZeroRuntimeErrors(state);
    });

    test("/book-reports expands and collapses admin feedback detail and supports reload", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/book-reports");
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Báo cáo chất lượng sách",
        }),
      ).toBeVisible();

      const expandBtn = page
        .getByRole("button", { name: "Xem chi tiết & phản hồi Admin" })
        .first();
      await expandBtn.click();
      const detail = page.getByTestId("parent-report-detail");
      await expect(detail).toBeVisible();
      await expect(detail).toContainText("Admin đã ghi nhận góp ý");

      await page.getByRole("button", { name: "Ẩn phản hồi Admin" }).click();
      await expect(detail).toHaveCount(0);

      await page.getByRole("button", { name: "Tải lại" }).click();
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Báo cáo chất lượng sách",
        }),
      ).toBeVisible();

      assertZeroRuntimeErrors(state);
    });

    test("/my-books and /my-books/[bookId] support privacy collapsible, CRUD, and page upload + add-page", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/my-books");
      await expect(
        page.getByRole("heading", { level: 1, name: "Sách của tôi" }),
      ).toBeVisible();

      if (bucket === "mobile-390x844") {
        const privacyToggle = page.getByRole("button", {
          name: /Tìm hiểu thêm/,
        });
        await expect(privacyToggle).toBeVisible();
        await privacyToggle.click();
        await expect(
          page.getByRole("button", { name: /Thu gọn/ }),
        ).toBeVisible();
      }

      // Create private book
      await page.getByRole("button", { name: "Tạo sách riêng" }).click();
      const form = page.getByRole("form", { name: "Tạo sách riêng mới" });
      await form.getByLabel("Tên sách *").fill("Sách riêng kiểm thử mới");
      await form.getByRole("button", { name: "Lưu và thêm trang" }).click();

      await expect(page).toHaveURL(/\/my-books\/.+/);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Sách riêng kiểm thử mới",
        }),
      ).toBeVisible();

      // Upload page image & add to book
      const uploadInput = page.getByLabel("Chọn tệp trang sách hoặc tài liệu");
      await uploadInput.setInputFiles({
        name: "trang-1.png",
        mimeType: "image/png",
        buffer: TINY_PNG_BYTES,
      });
      await page.getByRole("button", { name: "Tải lên & kiểm tra" }).click();
      const addPageBtn = page.getByRole("button", {
        name: "Thêm trang vào sách",
      });
      await expect(addPageBtn).toBeVisible();
      await addPageBtn.click();
      await expect(
        page.getByRole("link", { name: "Mở đọc cùng bé" }),
      ).toBeVisible();

      // Back to /my-books and delete book
      await page.getByRole("link", { name: "Quay lại Sách của tôi" }).click();
      await expect(page).toHaveURL(/\/my-books$/);
      await page
        .getByRole("button", { name: "Xóa sách Sách riêng kiểm thử mới" })
        .click();
      await page.getByRole("button", { name: /Xác nhận xóa/ }).click();
      await expect(
        page.getByRole("heading", {
          level: 2,
          name: "Sách riêng kiểm thử mới",
        }),
      ).toHaveCount(0);

      assertZeroRuntimeErrors(state);
    });

    test("/book-scanner renders idle controls, OCR upload result, and offline worker banner", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page, {
        ocrWorkerOnline: false,
      });
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      await page.goto("/book-scanner");
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Đưa trang sách vào khung camera",
        }),
      ).toBeVisible();
      await expect(page.getByTestId("ocr-worker-offline-banner")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Bật camera để quét" }),
      ).toBeVisible();

      // Upload image via local OCR input
      await page.getByTestId("local-ocr-file-input").setInputFiles({
        name: "scan-page.png",
        mimeType: "image/png",
        buffer: TINY_PNG_BYTES,
      });
      await expect(page.getByTestId("local-ocr-text")).toContainText(
        "Buổi sáng trên khu vườn",
      );
      await expect(
        page.getByRole("button", { name: "Mở Trang 1 để bắt đầu đọc" }),
      ).toBeVisible();

      assertZeroRuntimeErrors(state);
    });
  });

  test.describe("Tier 2: 8-Viewport Layout, Touch Targets, Pagination & Error Resilience", () => {
    test("All Group A routes render with selected child and zero horizontal overflow across all 8 viewports", async ({
      page,
    }) => {
      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      const routes = [
        "/dashboard",
        "/books",
        `/books/${MOBILE_IDS.bookPrimary}`,
        "/book-reports",
        "/my-books",
        `/my-books/${MOBILE_IDS.privateBook1}`,
        "/book-scanner",
      ];

      for (const route of routes) {
        await page.goto(route);
        await expect(page.locator("main h1").first()).toBeVisible();
        await expect(page).not.toHaveURL(/focus=child-selection/);
        await assertNoHorizontalOverflow(page);
      }

      assertZeroRuntimeErrors(state);
    });

    test("Group A interactive controls including PaginationBar meet >= 44x44px touch targets on <1024px", async ({
      page,
    }) => {
      const width = page.viewportSize()?.width ?? 1440;
      test.skip(
        width >= 1024,
        "Touch target audit applies to <1024px viewports",
      );

      const state = await installMobileOverhaulFixture(page, {
        catalogCount: 15,
        previewPagesCount: 26,
        myBooksCount: 12,
      });
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      for (const route of [
        "/books",
        `/books/${MOBILE_IDS.bookPrimary}`,
        "/my-books",
        "/book-scanner",
      ]) {
        await page.goto(route);
        await expect(page.locator("main h1").first()).toBeVisible();
        await assertTouchTargetsMin44(page, { scopeSelector: "main" });
      }

      assertZeroRuntimeErrors(state);
    });

    test("Long Vietnamese book titles (200+ chars) and long report details do not overflow on 360x800 and 640x960", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-360x800" && bucket !== "gap-640x960",
        "Stress-tests narrowest and 640px gap viewports",
      );

      const state = await installMobileOverhaulFixture(page, {
        longBookTitles: true,
      });
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      for (const route of [
        "/books",
        `/books/${MOBILE_IDS.bookPrimary}`,
        "/book-reports",
        "/my-books",
      ]) {
        await page.goto(route);
        await expect(page.locator("main h1").first()).toBeVisible();
        await assertNoHorizontalOverflow(page);
      }

      assertZeroRuntimeErrors(state);
    });

    test("Multi-page pagination (>12 books, >24 thumbnails, >20 reports, >9 my-books with fromPage return)", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "gap-720x900",
        "Pagination checks on representative mobile and gap viewports",
      );

      const state = await installMobileOverhaulFixture(page, {
        catalogCount: 15,
        previewPagesCount: 26,
        reportsCount: 22,
        myBooksCount: 12,
      });
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      // /books pagination (>12 books)
      await page.goto("/books");
      const booksPag = page.getByRole("navigation", {
        name: "Phân trang thư viện sách",
      });
      await expect(booksPag).toBeVisible();
      await booksPag.getByRole("button", { name: "Tiếp" }).click();
      await expect(
        page.getByRole("link", { name: /Truyện đọc thiếu nhi tập 13/ }),
      ).toBeVisible();

      // /books/[bookId] thumbnail pagination (>24 pages)
      await page.goto(`/books/${MOBILE_IDS.bookPrimary}`);
      const thumbPag = page.getByRole("navigation", {
        name: "Phân trang danh sách trang xem trước",
      });
      await expect(thumbPag).toBeVisible();
      await thumbPag.getByRole("button", { name: "Tiếp" }).click();
      await expect(
        page.getByRole("button", { name: /Trang 25/ }),
      ).toBeVisible();

      // /book-reports pagination (>20 reports)
      await page.goto("/book-reports");
      const reportsPag = page.getByRole("navigation", {
        name: "Phân trang báo cáo chất lượng sách",
      });
      await expect(reportsPag).toBeVisible();
      await reportsPag.getByRole("button", { name: "Tiếp" }).click();
      await expect(
        page.getByText("Báo cáo lỗi chính tả mẫu số 21"),
      ).toBeVisible();

      // /my-books pagination (>9 books) & preserving ?page=2 on return
      await page.goto("/my-books");
      const myBooksPag = page
        .getByRole("navigation", { name: /Phân trang Sách của tôi/ })
        .first();
      await myBooksPag.getByRole("button", { name: "Tiếp" }).click();
      await expect(page).toHaveURL(/\/my-books\?page=2/);
      await page
        .getByRole("link", { name: "Quản lý & thêm trang" })
        .first()
        .click();
      await expect(page).toHaveURL(/fromPage=2/);
      await page.getByRole("link", { name: "Quay lại Sách của tôi" }).click();
      await expect(page).toHaveURL(/\/my-books\?page=2/);

      assertZeroRuntimeErrors(state);
    });

    test("503 & API error resilience on Group A routes retries cleanly without raw backend error leaks", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844",
        "Error resilience verified on mobile-390x844",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      // /books 503 -> retry -> 200
      state.catalogStatus = 503;
      await page.goto("/books");
      await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
      await assertNoRawBackendLeak(page);
      state.catalogStatus = 200;
      await page.getByRole("button", { name: "Thử lại" }).click();
      await expect(
        page.getByRole("link", { name: /Đọc sách Chào ngày mới/ }),
      ).toBeVisible();

      // /books/[bookId] preview 503 -> retry -> 200
      state.previewStatus = 503;
      await page.goto(`/books/${MOBILE_IDS.bookPrimary}`);
      await expect(page.getByText("Ảnh xem trước chưa sẵn sàng")).toBeVisible();
      await assertNoRawBackendLeak(page);
      state.previewStatus = 200;
      await page.getByRole("button", { name: "Thử tải ảnh lại" }).click();
      await expect(page.locator("#reading-end-page")).toBeEnabled();

      // /book-reports 500 -> reload -> 200
      state.reportsStatus = 500;
      await page.goto("/book-reports");
      await expect(page.getByText("Không thể tải báo cáo")).toBeVisible();
      await assertNoRawBackendLeak(page);
      state.reportsStatus = 200;
      await page.getByRole("button", { name: "Tải lại" }).click();
      await expect(
        page.getByText("Báo cáo lỗi chính tả mẫu số 1"),
      ).toBeVisible();

      // /my-books 503 -> retry -> 200
      state.myBooksStatus = 503;
      await page.goto("/my-books");
      await expect(page.getByText("Chưa tải được Sách của tôi")).toBeVisible();
      await assertNoRawBackendLeak(page);
      state.myBooksStatus = 200;
      await page.getByRole("button", { name: "Thử lại" }).click();
      await expect(page.getByText("Sách Gia Đình #01")).toBeVisible();

      assertZeroRuntimeErrors(state);
    });
  });

  test.describe("Tier 3: Cross-Feature Pairwise Interactions", () => {
    test("Toggling favorite on /books appears in /reading-management saved books tab", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "gap-640x960",
        "Pairwise /books -> /reading-management flow",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      await page.goto("/books");
      await page
        .getByRole("button", {
          name: "Thêm Chào ngày mới cùng Bé An yêu thích",
        })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Bỏ Chào ngày mới cùng Bé An yêu thích",
        }),
      ).toHaveAttribute("aria-pressed", "true");

      await page.goto("/reading-management");
      await page.getByRole("tab", { name: /Sách lưu/ }).click();
      await expect(page.getByText("Chào ngày mới cùng Bé An")).toBeVisible();

      assertZeroRuntimeErrors(state);
    });

    test("/book-scanner OCR match navigates to /books/[bookId]?pageId=... and enables Chuẩn bị đọc", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Pairwise /book-scanner -> /books/[bookId] flow",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      await page.goto("/book-scanner");
      await page.getByTestId("local-ocr-file-input").setInputFiles({
        name: "match.png",
        mimeType: "image/png",
        buffer: TINY_PNG_BYTES,
      });
      await page
        .getByRole("button", { name: "Mở Trang 1 để bắt đầu đọc" })
        .click();

      await expect(page).toHaveURL(
        new RegExp(
          `/books/${MOBILE_IDS.bookPrimary}\\?pageId=${MOBILE_IDS.pagePrimary}`,
        ),
      );
      await expect(page.getByText("Độ tin cậy 94%")).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Chuẩn bị đọc/ }),
      ).toBeEnabled();

      assertZeroRuntimeErrors(state);
    });
  });

  test.describe("Tier 4: Real-World Application Journey J1 (390x844)", () => {
    test("J1: Parent selects child -> /books filters & saves favorite -> /books/[bookId] submits report -> /book-reports verifies -> /my-books creates book -> /book-scanner matches page", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(bucket !== "mobile-390x844", "Journey J1 runs at 390x844");

      const state = await installMobileOverhaulFixture(page);

      // 1. Dashboard -> Select Bé An
      await page.goto("/dashboard");
      await page.getByRole("button", { name: "Bé An, lớp 2" }).click();
      await page.getByRole("button", { name: /Chọn sách/ }).click();
      await expect(page).toHaveURL(/\/books$/);

      // 2. Filter & save favorite on /books
      await page.getByRole("button", { name: "Tất cả", exact: true }).click();
      await page
        .getByRole("button", {
          name: "Thêm Chào ngày mới cùng Bé An yêu thích",
        })
        .click();
      await page
        .getByRole("link", { name: "Đọc sách Chào ngày mới cùng Bé An" })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/books/${MOBILE_IDS.bookPrimary}$`),
      );

      // 3. Submit content report on /books/[bookId]
      await page.getByRole("button", { name: "Báo lỗi sách" }).click();
      const dialog = page.getByRole("dialog");
      await dialog
        .locator("#book-report-description")
        .fill("Cần kiểm tra lại chính tả tiêu đề chương 1.");
      await dialog.getByRole("button", { name: "Gửi báo cáo" }).click();
      await expect(
        dialog.getByText("Báo cáo đã được lưu thành công."),
      ).toBeVisible();
      await dialog.getByRole("link", { name: "Xem báo cáo của tôi" }).click();

      // 4. Verify report on /book-reports
      await expect(page).toHaveURL(/\/book-reports$/);
      await expect(
        page.getByText("Cần kiểm tra lại chính tả tiêu đề chương 1."),
      ).toBeVisible();

      // 5. Navigate via bottom nav Thêm -> Sách của tôi & create private book
      await page
        .getByTestId("mobile-bottom-nav")
        .getByRole("button", { name: /Thêm/ })
        .click();
      await page
        .getByRole("dialog", { name: "Tính năng khác" })
        .getByRole("link", { name: /Sách của tôi/ })
        .click();
      await expect(page).toHaveURL(/\/my-books$/);
      await page.getByRole("button", { name: "Tạo sách riêng" }).click();
      const createForm = page.getByRole("form", { name: "Tạo sách riêng mới" });
      await createForm.getByLabel("Tên sách *").fill("Nhật ký đọc của Bé An");
      await createForm
        .getByRole("button", { name: "Lưu và thêm trang" })
        .click();
      await expect(
        page.getByRole("heading", { level: 1, name: "Nhật ký đọc của Bé An" }),
      ).toBeVisible();

      // 6. Navigate via bottom nav Quét -> /book-scanner & match page
      await page
        .getByTestId("mobile-bottom-nav")
        .getByRole("link", { name: "Quét", exact: true })
        .click();
      await expect(page).toHaveURL(/\/book-scanner$/);
      await page.getByTestId("local-ocr-file-input").setInputFiles({
        name: "journey-j1.png",
        mimeType: "image/png",
        buffer: TINY_PNG_BYTES,
      });
      await page
        .getByRole("button", { name: "Mở Trang 1 để bắt đầu đọc" })
        .click();
      await expect(page).toHaveURL(
        new RegExp(
          `/books/${MOBILE_IDS.bookPrimary}\\?pageId=${MOBILE_IDS.pagePrimary}`,
        ),
      );
      await assertNoHorizontalOverflow(page);

      assertZeroRuntimeErrors(state);
    });
  });
});
