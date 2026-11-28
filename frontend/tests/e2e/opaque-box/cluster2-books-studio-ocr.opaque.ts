import { expect, test, type Page } from "@playwright/test";

import {
  createCluster2ApiHandler,
  createCluster2ApiState,
  makeAdminRevisionDetail,
  makeFlow1ComparisonPayload,
  makePrivateBookCommittedPage,
  makePrivateBookDetail,
  makePrivateBookListItem,
  makePrivateBookSubmission,
  makeVireadDriveStatus,
  makeVireadTrainingOverview,
  OPAQUE_ASSET_ID,
  OPAQUE_SUBMISSION_ID,
} from "./fixtures/cluster1-2-data";
import {
  attachPageErrorCollector,
  createRoleContext,
  installApiMock,
  OPAQUE_ADMIN_ID,
} from "./fixtures/session";
import {
  makeCatalogBook,
  makeCatalogPagePreview,
  makeGlobalTaskList,
  makeMinimalPdfBuffer,
  makeMinimalPngBuffer,
  makeOpaqueUuid,
  makeOversizedBuffer,
  OPAQUE_BOOK_ID,
  OPAQUE_CHILD_ID,
  OPAQUE_NOW_ISO,
  OPAQUE_PAGE_ID,
  OPAQUE_REV_ID,
  OPAQUE_TASK_ID,
  OVERSIZED_SCAN_BYTES,
} from "./fixtures/test-data";

async function mockSupabaseStorageImages(page: Page): Promise<void> {
  await page.route("https://*.supabase.co/storage/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: makeMinimalPngBuffer(),
    });
  });
}

// ===========================================================================
// F-05: Catalog & Book Detail (5 Tier 1 + 6 Tier 2 = 11 tests)
// ===========================================================================

test.describe("F-05: Catalog & Book Detail", () => {
  test("[T1-F05-01] /books loads catalog for selected child grade and renders book card", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      const api = await installApiMock(
        parent.page,
        createCluster2ApiHandler(state),
      );
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto("/books", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByRole("heading", { level: 1, name: "Thư viện sách" }),
      ).toBeVisible();
      await expect(parent.page.getByText("Chú Mèo Đi Hia")).toBeVisible();
      await expect(
        parent.page.getByRole("link", { name: /Chú Mèo Đi Hia|Xem sách/i }),
      ).toBeVisible();

      await expect
        .poll(() =>
          api
            .getRequests()
            .some(
              (r) =>
                r.path === "/books/catalog" &&
                r.url.includes("grade=2") &&
                r.url.includes("include_private=true"),
            ),
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F05-02] /books grade filter, search query, and clear filter update catalog requests", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      state.catalogBooks.push(
        makeCatalogBook({
          id: makeOpaqueUuid(21, "82000000"),
          title: "Dế Mèn Phiêu Lưu Ký",
          min_grade: 4,
          max_grade: 5,
        }),
      );
      const api = await installApiMock(
        parent.page,
        createCluster2ApiHandler(state),
      );
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto("/books", { waitUntil: "domcontentloaded" });
      await parent.page.getByRole("button", { name: "Lớp 1" }).click();
      await parent.page
        .getByLabel("Tìm cuốn sách bé thích…")
        .fill("Không Tồn Tại");

      await expect(
        parent.page.getByText("Không tìm thấy cuốn sách phù hợp"),
      ).toBeVisible();
      await expect
        .poll(() =>
          api
            .getRequests()
            .some(
              (r) =>
                r.path === "/books/catalog" &&
                r.url.includes("grade=1") &&
                r.url.includes("search="),
            ),
        )
        .toBe(true);

      await parent.page.getByRole("button", { name: "Xóa bộ lọc" }).click();
      await expect(parent.page.getByText("Chú Mèo Đi Hia")).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F05-03] /books/[bookId] renders signed cover & preview images and navigates to /reading-preparation", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByRole("heading", { level: 1, name: "Chú Mèo Đi Hia" }),
      ).toBeVisible();

      const previewImg = parent.page
        .locator('img[src*="example.supabase.co/storage"]')
        .first();
      await expect(previewImg).toBeVisible();
      const loadedWidth = await previewImg.evaluate(
        (img) => (img as HTMLImageElement).naturalWidth,
      );
      expect(loadedWidth).toBeGreaterThan(0);

      const startBtn = parent.page.locator("#start-reading-button");
      await expect(startBtn).toBeEnabled();
      await startBtn.click();
      await expect(parent.page).toHaveURL(/\/reading-preparation/);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F05-04] /books/[bookId] thumbnail selection and non-contiguous page gap warning", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      const page3Id = makeOpaqueUuid(30, "83000000");
      state.previewsByBook[OPAQUE_BOOK_ID] = [
        makeCatalogPagePreview({ page_id: OPAQUE_PAGE_ID, page_number: 1 }),
        makeCatalogPagePreview({
          page_id: page3Id,
          page_number: 3,
          current_verified_revision_id: makeOpaqueUuid(30, "84000000"),
        }),
      ];
      await installApiMock(parent.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByLabel("Trang bắt đầu")
        .selectOption(OPAQUE_PAGE_ID);
      await parent.page.getByLabel("Trang kết thúc").selectOption(page3Id);

      await expect(
        parent.page.getByText("Khoảng trang chưa liên tục"),
      ).toBeVisible();
      await expect(parent.page.locator("#start-reading-button")).toBeDisabled();

      await parent.page.getByRole("button", { name: "Chọn trang 3" }).click();
      await expect(parent.page.locator("#start-reading-button")).toBeEnabled();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F05-05] Mobile 390x844 /books and /books/[bookId] render without horizontal overflow @mobile", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
      viewport: { width: 390, height: 844 },
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(parent.page);

      for (const path of ["/books", `/books/${OPAQUE_BOOK_ID}`]) {
        await parent.page.goto(path, { waitUntil: "domcontentloaded" });
        const noOverflow = await parent.page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        );
        expect(noOverflow).toBe(true);
      }
      await expect(parent.page.locator("#start-reading-button")).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F05-01] Unauthenticated /books SSR request redirects 307 to /login?next=%2Fbooks", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const res = await guest.context.request.get("/books", {
        maxRedirects: 0,
      });
      expect(res.status()).toBe(307);
      const loc = new URL(res.headers().location ?? "", guest.baseURL);
      expect(loc.pathname).toBe("/login");
      expect(loc.searchParams.get("next")).toBe("/books");
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F05-02] /books/[bookId] 409 BOOK_BLOCKED_BY_CHILD_SAFETY renders unavailable state", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const state = createCluster2ApiState({ role: "parent" });
      state.faults[`GET /books/catalog/${OPAQUE_BOOK_ID}`] = {
        status: 409,
        body: { detail: "BOOK_BLOCKED_BY_CHILD_SAFETY" },
      };
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText("Sách hiện chưa sẵn sàng"),
      ).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F05-03] /books/[bookId] 404 renders not-found state with back-to-library link", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const missingId = makeOpaqueUuid(99, "82000000");
      const state = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto(`/books/${missingId}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("Không tìm thấy sách")).toBeVisible();
      await expect(
        parent.page.getByRole("link", { name: "Về thư viện sách" }),
      ).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F05-04] /books/[bookId] Zod schema rejects RETIRED book returned with HTTP 200", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const state = createCluster2ApiState({ role: "parent" });
      state.catalogBooks[0] = makeCatalogBook({
        id: OPAQUE_BOOK_ID,
        lifecycle_status: "RETIRED",
      });
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText("Chưa tải được chi tiết sách"),
      ).toBeVisible();
      await expect(
        parent.page.getByRole("button", { name: "Thử lại" }),
      ).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F05-05] /books/[bookId] empty preview array renders pending preview fallback", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const state = createCluster2ApiState({ role: "parent" });
      state.previewsByBook[OPAQUE_BOOK_ID] = [];
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText("Ảnh xem trước chưa sẵn sàng"),
      ).toBeVisible();
      await expect(
        parent.page.getByRole("button", { name: "Thử tải ảnh lại" }),
      ).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F05-06] /books catalog error renders retry state and recovers when fault clears", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const state = createCluster2ApiState({ role: "parent" });
      state.faults["GET /books/catalog"] = {
        status: 500,
        body: { detail: "CATALOG_UNAVAILABLE" },
      };
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto("/books", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByText("Chưa tải được thư viện sách"),
      ).toBeVisible();

      delete state.faults["GET /books/catalog"];
      await parent.page.getByRole("button", { name: "Thử lại" }).click();
      await expect(parent.page.getByText("Chú Mèo Đi Hia")).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });
});

// ===========================================================================
// F-06: Parent Private Books (6 Tier 1 + 6 Tier 2 = 12 tests)
// ===========================================================================

test.describe("F-06: Parent Private Books", () => {
  test("[T1-F06-01] /my-books lists paged private books and creates a new private book", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto("/my-books", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByRole("heading", { level: 1, name: "Sách của tôi" }),
      ).toBeVisible();
      await expect(parent.page.getByText("Sách gia đình bé An")).toBeVisible();

      await parent.page.getByRole("button", { name: "Tạo sách riêng" }).click();
      const form = parent.page.getByRole("form", {
        name: "Tạo sách riêng mới",
      });
      await form.getByLabel("Tên sách *").fill("Truyện Cổ Tích Nhà Mình");
      await form.getByLabel("Tác giả (không bắt buộc)").fill("Ba mẹ bé An");
      await form.getByRole("button", { name: "Lưu và thêm trang" }).click();

      await expect(parent.page).toHaveURL(/\/my-books\/[^/?]+/);
      await expect(
        parent.page.getByText("Truyện Cổ Tích Nhà Mình"),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F06-02] /my-books/[bookId] uploads valid minimal PNG submission", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto(`/my-books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByLabel("Chọn tệp trang sách hoặc tài liệu")
        .setInputFiles({
          name: "trang-1.png",
          mimeType: "image/png",
          buffer: makeMinimalPngBuffer(),
        });
      await parent.page
        .getByRole("button", { name: "Tải lên & kiểm tra" })
        .click();

      await expect(
        parent.page.getByText(/Đã nhận 1 trang từ tệp \(PNG\)/),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F06-03] /my-books/[bookId] uploads valid minimal PDF document", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto(`/my-books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByLabel("Chọn tệp trang sách hoặc tài liệu")
        .setInputFiles({
          name: "sach-mau.pdf",
          mimeType: "application/pdf",
          buffer: makeMinimalPdfBuffer("Chu meo nho"),
        });
      await parent.page
        .getByRole("button", { name: "Tải lên & kiểm tra" })
        .click();

      await expect(
        parent.page.getByText(/Đã nhận 1 trang từ tệp \(PDF\)/),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F06-04] /my-books/[bookId] accepts spelling suggestion then commits page to book", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      state.privateBooks[0] = makePrivateBookDetail({
        book: makePrivateBookListItem({
          id: OPAQUE_BOOK_ID,
          ready_to_add_count: 1,
        }),
        submissions: [
          makePrivateBookSubmission({
            id: OPAQUE_SUBMISSION_ID,
            book_id: OPAQUE_BOOK_ID,
            spelling_accepted: false,
            can_add_to_book: false,
            proofread_suggestions: [
              {
                word_index: 1,
                original: "meo",
                suggested: "mèo",
                uncertain: false,
              },
            ],
          }),
        ],
      });
      await installApiMock(parent.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto(`/my-books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByRole("button", { name: "Chấp nhận đề xuất chính tả" })
        .click();

      const addPageBtn = parent.page.getByRole("button", {
        name: "Thêm trang vào sách",
      });
      await expect(addPageBtn).toBeVisible();
      await addPageBtn.click();

      await expect(
        parent.page.getByText("Các trang đã thêm vào sách đọc (1)"),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F06-05] /my-books/[bookId] Flow 2 OCR contribution opt-in and opt-out persistence", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto(`/my-books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText("Đóng góp mẫu cải thiện nhận diện chữ ViRead"),
      ).toBeVisible();

      await parent.page
        .getByLabel(
          "Tôi xác nhận có quyền cho phép ViRead sử dụng ảnh cắt từng dòng chữ và nội dung tương ứng của cuốn sách này để cải thiện nhận diện chữ.",
        )
        .check();
      await parent.page
        .getByRole("button", { name: "Bật đóng góp mẫu nhận diện" })
        .click();

      const disableBtn = parent.page.getByRole("button", {
        name: "Ngừng đóng góp",
      });
      await expect(disableBtn).toBeVisible();
      await disableBtn.click();

      await expect(
        parent.page.getByRole("button", {
          name: "Bật đóng góp mẫu nhận diện",
        }),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F06-06] Mobile 390x844 /my-books/[bookId] renders upload, filters, and committed pages without overflow @mobile", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      viewport: { width: 390, height: 844 },
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      state.privateBooks[0] = makePrivateBookDetail({
        book: makePrivateBookListItem({
          id: OPAQUE_BOOK_ID,
          committed_page_count: 1,
          readable_for_children: true,
        }),
        pages: [makePrivateBookCommittedPage()],
        submissions: [makePrivateBookSubmission()],
      });
      await installApiMock(parent.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto(`/my-books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByRole("button", { name: "Tất cả (1)" }),
      ).toBeVisible();
      await expect(
        parent.page.getByText("Các trang đã thêm vào sách đọc (1)"),
      ).toBeVisible();

      const noOverflow = await parent.page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
      expect(noOverflow).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F06-01] /my-books create form validates empty title, inverted grade order, and server 422", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const state = createCluster2ApiState({ role: "parent" });
      state.faults["POST /books/my-books"] = {
        status: 422,
        body: { detail: "INVALID_BOOK_METADATA" },
      };
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto("/my-books", { waitUntil: "domcontentloaded" });
      await parent.page.getByRole("button", { name: "Tạo sách riêng" }).click();
      const form = parent.page.getByRole("form", {
        name: "Tạo sách riêng mới",
      });

      await form.getByRole("button", { name: "Lưu và thêm trang" }).click();
      await expect(
        parent.page.getByText("Vui lòng nhập tên sách riêng."),
      ).toBeVisible();

      await form.getByLabel("Tên sách *").fill("Sách Hợp Lệ");
      await form.getByLabel("Phù hợp từ lớp").selectOption("4");
      await form.getByLabel("Đến lớp").selectOption("2");
      await form.getByRole("button", { name: "Lưu và thêm trang" }).click();
      await expect(
        parent.page.getByText("Lớp tối thiểu không được lớn hơn lớp tối đa."),
      ).toBeVisible();

      await form.getByLabel("Đến lớp").selectOption("5");
      await form.getByLabel("Tên sách *").fill("A".repeat(205));
      await form.getByRole("button", { name: "Lưu và thêm trang" }).click();
      await expect(
        parent.page.getByText(
          "Thông tin mô tả sách chưa hợp lệ. Vui lòng kiểm tra lại và thử lưu lại.",
        ),
      ).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F06-02] /my-books/[bookId] oversized 12.5MB image 413 displays localized 12 MB error", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const state = createCluster2ApiState({ role: "parent" });
      state.faults[`POST /books/my-books/${OPAQUE_BOOK_ID}/submissions`] = {
        status: 413,
        body: { detail: "Image exceeds the 12 MB limit" },
      };
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto(`/my-books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByLabel("Chọn tệp trang sách hoặc tài liệu")
        .setInputFiles({
          name: "too-big.png",
          mimeType: "image/png",
          buffer: makeOversizedBuffer(OVERSIZED_SCAN_BYTES),
        });
      await parent.page
        .getByRole("button", { name: "Tải lên & kiểm tra" })
        .click();

      await expect(
        parent.page.getByText(
          "Ảnh tải lên vượt quá giới hạn dung lượng 12 MB.",
        ),
      ).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F06-03] /my-books/[bookId] corrupt or oversized PDF 422 displays allowlisted Vietnamese error", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const state = createCluster2ApiState({ role: "parent" });
      state.faults[`POST /books/my-books/${OPAQUE_BOOK_ID}/submissions`] = {
        status: 422,
        body: { detail: "The uploaded document is empty or corrupted" },
      };
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto(`/my-books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByLabel("Chọn tệp trang sách hoặc tài liệu")
        .setInputFiles({
          name: "corrupt.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("not-a-pdf"),
        });
      await parent.page
        .getByRole("button", { name: "Tải lên & kiểm tra" })
        .click();

      await expect(
        parent.page.getByText(
          "Tệp tải lên bị rỗng hoặc bị hỏng không thể đọc được.",
        ),
      ).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F06-04] Cross-family private book 404 renders Không tìm thấy sách riêng", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const foreignBookId = makeOpaqueUuid(99, "82000000");
      const state = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto(`/my-books/${foreignBookId}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText("Không tìm thấy sách riêng"),
      ).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F06-05] SUSPENDED private book shows suspension banner and disables upload controls", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const state = createCluster2ApiState({ role: "parent" });
      state.privateBooks[0] = makePrivateBookDetail({
        book: makePrivateBookListItem({
          id: OPAQUE_BOOK_ID,
          moderation_status: "SUSPENDED",
          suspended_reason: "Vi phạm bản quyền",
          readable_for_children: false,
        }),
      });
      await installApiMock(parent.page, createCluster2ApiHandler(state));

      await parent.page.goto(`/my-books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText("Sách riêng đang bị đình chỉ"),
      ).toBeVisible();
      await expect(
        parent.page.getByLabel("Chọn tệp trang sách hoặc tài liệu"),
      ).toBeDisabled();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F06-06] Unauthenticated /my-books SSR request redirects 307 to /login?next=%2Fmy-books", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const res = await guest.context.request.get("/my-books", {
        maxRedirects: 0,
      });
      expect(res.status()).toBe(307);
      const loc = new URL(res.headers().location ?? "", guest.baseURL);
      expect(loc.pathname).toBe("/login");
      expect(loc.searchParams.get("next")).toBe("/my-books");
    } finally {
      await guest.dispose();
    }
  });
});

// ===========================================================================
// F-18: Admin Books, OCR, Quality Hub & Parent Reports (6 T1 + 6 T2 = 12 tests)
// ===========================================================================

test.describe("F-18: Admin Books, OCR Review, Quality Hub & Parent Reports", () => {
  test("[T1-F18-01] /admin/books lists catalog and /admin/books/new creates book", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/books", { waitUntil: "domcontentloaded" });
      await expect(
        admin.page.getByRole("heading", { level: 1, name: "Kho sách" }),
      ).toBeVisible();
      await expect(admin.page.getByText("Chú Mèo Đi Hia")).toBeVisible();

      await admin.page.goto("/admin/books/new", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByLabel(/Tên hệ thống|Mã định danh/i)
        .fill("tho-va-rua");
      await admin.page.getByLabel(/Tiêu đề|Tên sách/i).fill("Thỏ Và Rùa");
      await admin.page.getByLabel(/Tác giả/i).fill("ViRead");
      await admin.page.getByRole("button", { name: /Tạo sách|Lưu/i }).click();

      await expect(admin.page).toHaveURL(/\/admin\/books\/[^/?]+$/);

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F18-02] /admin/books/[bookId] uploads valid PNG and PDF via AdminPageUploader", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      state.adminPagesByBook[OPAQUE_BOOK_ID] = [];
      const api = await installApiMock(
        admin.page,
        createCluster2ApiHandler(state),
      );

      await admin.page.goto(`/admin/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });

      const fileInput = admin.page.locator('input[type="file"]').first();
      await fileInput.setInputFiles([
        {
          name: "page1.png",
          mimeType: "image/png",
          buffer: makeMinimalPngBuffer(),
        },
        {
          name: "doc.pdf",
          mimeType: "application/pdf",
          buffer: makeMinimalPdfBuffer("Trang PDF"),
        },
      ]);
      await admin.page
        .getByRole("button", { name: /Tải lên|Upload/i })
        .first()
        .click();

      await expect
        .poll(() =>
          api
            .getRequests()
            .some(
              (r) =>
                r.method === "POST" &&
                r.path.includes(`/books/admin/catalog/${OPAQUE_BOOK_ID}/`),
            ),
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F18-03] /admin/books/[bookId]/pages/[pageId] saves draft and verifies final OCR revision", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      const api = await installApiMock(
        admin.page,
        createCluster2ApiHandler(state),
      );
      await mockSupabaseStorageImages(admin.page);

      await admin.page.goto(
        `/admin/books/${OPAQUE_BOOK_ID}/pages/${OPAQUE_PAGE_ID}`,
        { waitUntil: "domcontentloaded" },
      );

      await admin.page.locator("#ocr-text").fill("Chú mèo đi hia mới");
      await admin.page.getByRole("button", { name: "Lưu bản nháp" }).click();

      await expect
        .poll(() =>
          api
            .getRequests()
            .some(
              (r) =>
                r.method === "PUT" &&
                r.path.endsWith("/revisions/" + OPAQUE_REV_ID + "/draft"),
            ),
        )
        .toBe(true);

      await admin.page
        .getByRole("button", { name: "XÁC NHẬN VÀ LƯU NỘI DUNG CUỐI CÙNG" })
        .click();

      await expect
        .poll(() =>
          api
            .getRequests()
            .some(
              (r) =>
                r.method === "POST" &&
                r.path === `/books/admin/pages/${OPAQUE_PAGE_ID}/verify`,
            ),
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F18-04] /admin/metadata-quality renders 4 tabs, saves rights evidence, and approves book", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/metadata-quality?tab=approval", {
        waitUntil: "domcontentloaded",
      });
      const tablist = admin.page.getByRole("tablist", {
        name: "Phân khu quản lý chất lượng sách",
      });
      await expect(tablist).toBeVisible();
      await expect(
        tablist.getByRole("tab", { name: "Metadata sách" }),
      ).toBeVisible();
      await expect(
        tablist.getByRole("tab", { name: "Báo cáo người dùng" }),
      ).toBeVisible();
      await expect(
        tablist.getByRole("tab", { name: "Duyệt & An toàn sách" }),
      ).toBeVisible();
      await expect(
        tablist.getByRole("tab", {
          name: "Sách người dùng & Đóng góp dữ liệu",
        }),
      ).toBeVisible();

      await admin.page
        .getByRole("button", { name: "Xem kết quả" })
        .first()
        .click();

      const rightsPanel = admin.page.getByTestId("book-rights-panel");
      await expect(rightsPanel).toBeVisible();
      await rightsPanel.locator("select").selectOption("RIGHTS_REVIEWED");
      const inputs = rightsPanel.locator("input");
      await inputs.nth(0).fill("PUBLIC_DOMAIN");
      await inputs.nth(1).fill("Tác phẩm dân gian");
      await inputs.nth(3).fill("https://viread.local/rights/1");
      await rightsPanel
        .getByRole("button", { name: "Lưu hồ sơ quyền sử dụng" })
        .click();

      await expect(rightsPanel.getByRole("status")).toBeVisible();

      await admin.page
        .locator("textarea")
        .last()
        .fill("Đã rà soát đầy đủ nội dung và quyền sử dụng.");
      await admin.page
        .getByRole("button", { name: "Phê duyệt toàn bộ sách" })
        .click();

      await expect
        .poll(() => state.qualityBooks[0]?.assessment.status)
        .toBe("APPROVED_BY_ADMIN");

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F18-05] Parent submits book content report on /books/[bookId] and views it in /book-reports", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Báo lỗi sách" }).click();

      const dialog = parent.page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog
        .locator("#book-report-description")
        .fill("Trang 1 bị thiếu dấu câu cuối dòng.");
      await dialog.getByRole("button", { name: "Gửi báo cáo" }).click();

      await expect(
        dialog.getByText("Báo cáo đã được lưu thành công."),
      ).toBeVisible();
      await dialog.getByRole("link", { name: "Xem báo cáo của tôi" }).click();

      await expect(parent.page).toHaveURL(/\/book-reports$/);
      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Báo cáo chất lượng sách",
        }),
      ).toBeVisible();
      await expect(
        parent.page.getByText("Trang 1 bị thiếu dấu câu cuối dòng."),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F18-06] Mobile 390x844 Quality Hub reports tab and /book-reports render without horizontal overflow @mobile", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin", {
      viewport: { width: 390, height: 844 },
    });
    const parent = await createRoleContext(browser, "parent", {
      viewport: { width: 390, height: 844 },
    });
    try {
      const adminState = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(adminState));
      await admin.page.goto("/admin/metadata-quality?tab=reports", {
        waitUntil: "domcontentloaded",
      });
      await expect(
        admin.page.getByText("Thiếu dấu hỏi ở chữ nhỏ."),
      ).toBeVisible();
      const adminOverflow = await admin.page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
      expect(adminOverflow).toBe(true);

      const parentState = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(parentState));
      await parent.page.goto("/book-reports", {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText("Thiếu dấu hỏi ở chữ nhỏ."),
      ).toBeVisible();
      const parentOverflow = await parent.page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
      expect(parentOverflow).toBe(true);
    } finally {
      await Promise.all([admin.dispose(), parent.dispose()]);
    }
  });

  test("[T2-F18-01] AdminPageUploader rejects .docm and .doc client-side and surfaces server 413 errors", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.adminPagesByBook[OPAQUE_BOOK_ID] = [];
      state.faults[`POST /books/admin/catalog/${OPAQUE_BOOK_ID}/pages/jobs`] = {
        status: 413,
        body: { detail: "Image exceeds the 12 MB limit" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto(`/admin/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const fileInput = admin.page.locator('input[type="file"]').first();

      await fileInput.setInputFiles({
        name: "macro.docm",
        mimeType: "application/vnd.ms-word.document.macroEnabled.12",
        buffer: Buffer.from("PK"),
      });
      await admin.page
        .getByRole("button", { name: /Tải lên|Upload/i })
        .first()
        .click();
      await expect(
        admin.page.getByText("Không cho phép tệp Word chứa macro (.docm)."),
      ).toBeVisible();

      await fileInput.setInputFiles({
        name: "legacy.doc",
        mimeType: "application/msword",
        buffer: Buffer.from("DOC"),
      });
      await admin.page
        .getByRole("button", { name: /Tải lên|Upload/i })
        .first()
        .click();
      await expect(
        admin.page.getByText(
          "Chưa hỗ trợ tệp .doc cũ; hãy lưu sang .docx hoặc .pdf.",
        ),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F18-02] OCR verify blocked by RIGHTS_EVIDENCE_REQUIRED and createEditDraft 409 conflict handled cleanly", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.faults[`POST /books/admin/pages/${OPAQUE_PAGE_ID}/verify`] = {
        status: 409,
        body: { detail: "RIGHTS_EVIDENCE_REQUIRED" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(admin.page);

      await admin.page.goto(
        `/admin/books/${OPAQUE_BOOK_ID}/pages/${OPAQUE_PAGE_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await admin.page
        .getByRole("button", { name: "XÁC NHẬN VÀ LƯU NỘI DUNG CUỐI CÙNG" })
        .click();
      await expect(admin.page.getByText(/quyền sử dụng|RIGHTS/i)).toBeVisible();

      // Verified revision createEditDraft 409 conflict
      state.adminRevisionsByPage[OPAQUE_PAGE_ID] = makeAdminRevisionDetail({
        verification_status: "VERIFIED",
        verified_at: OPAQUE_NOW_ISO,
        verified_by: OPAQUE_ADMIN_ID,
      });
      state.faults[
        `POST /books/admin/pages/${OPAQUE_PAGE_ID}/revisions/draft`
      ] = {
        status: 409,
        body: { detail: "REVISION_CONFLICT" },
      };
      await admin.page.reload({ waitUntil: "domcontentloaded" });
      await admin.page
        .getByRole("button", { name: "Tạo bản nháp để sửa nội dung" })
        .click();
      await expect(
        admin.page.getByText(/Không thể tạo bản nháp/),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F18-03] Quality Hub approval 409 RIGHTS_EVIDENCE_REQUIRED renders localized rights error", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.faults[
        `POST /books/admin/quality/books/${OPAQUE_BOOK_ID}/decision`
      ] = {
        status: 409,
        body: { detail: "RIGHTS_EVIDENCE_REQUIRED" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/metadata-quality?tab=approval", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("button", { name: "Xem & quyết định" })
        .first()
        .click();

      await admin.page
        .locator("textarea")
        .last()
        .fill("Kiểm tra phê duyệt khi thiếu quyền.");
      await admin.page
        .getByRole("button", { name: "Phê duyệt toàn bộ sách" })
        .click();

      await expect(
        admin.page.getByText(
          "Chưa có hồ sơ bằng chứng quyền sử dụng đầy đủ cho sách hoặc trang này. Hãy hoàn tất rà soát quyền sử dụng trước khi tiếp tục.",
        ),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F18-04] Quality Hub user-books 409 decision renders conflict banner and reload CTA", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.faults[
        `POST /books/admin/quality/user-books/submissions/${OPAQUE_SUBMISSION_ID}/decision`
      ] = {
        status: 409,
        body: { detail: "REVISION_CONFLICT" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/metadata-quality?tab=user-books", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("button", { name: /Xem|Kiểm tra|Chi tiết/i })
        .first()
        .click();

      const drawer = admin.page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      await drawer.locator("textarea").fill("Phê duyệt trang.");
      await drawer.getByRole("button", { name: /Phê duyệt/i }).click();

      await expect(
        admin.page.getByText("Xung đột phiên bản (409)"),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F18-05] Parent book report 429 rate-limit renders safe saveUnconfirmedError without crash", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const state = createCluster2ApiState({ role: "parent" });
      state.faults[`POST /books/catalog/${OPAQUE_BOOK_ID}/reports`] = {
        status: 429,
        body: {
          detail:
            "Bạn đã gửi nhiều báo cáo trong thời gian ngắn. Vui lòng thử lại sau.",
        },
      };
      await installApiMock(parent.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Báo lỗi sách" }).click();

      const dialog = parent.page.getByRole("dialog");
      await dialog
        .locator("#book-report-description")
        .fill("Kiểm tra giới hạn tốc độ gửi báo cáo.");
      await dialog.getByRole("button", { name: "Gửi báo cáo" }).click();

      await expect(
        dialog.getByText(
          "Chưa thể gửi báo cáo. Dữ liệu chưa được xác nhận lưu thành công; vui lòng thử lại.",
        ),
      ).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F18-06] Parent visiting /admin/metadata-quality is SSR-redirected 307 to /dashboard", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const res = await parent.context.request.get(
        "/admin/metadata-quality?tab=approval",
        { maxRedirects: 0 },
      );
      expect(res.status()).toBe(307);
      expect(
        new URL(res.headers().location ?? "", parent.baseURL).pathname,
      ).toBe("/dashboard");
    } finally {
      await parent.dispose();
    }
  });
});

// ===========================================================================
// F-19: Cover Studio, Illustration Studio, OCR Blocks & Studio Tasks (5 T1 + 6 T2 = 11 tests)
// ===========================================================================

test.describe("F-19: Smart Book Studio V2", () => {
  test("[T1-F19-01] Admin Cover Studio stages PNG, applies CENTER crop and 90deg rotation, and uploads cover", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      let uploadedPayloadText: string | null = null;
      const baseHandler = createCluster2ApiHandler(state);
      await installApiMock(admin.page, (ctx) => {
        if (
          ctx.method === "POST" &&
          ctx.pathname === `/studio/books/${OPAQUE_BOOK_ID}/cover/upload`
        ) {
          uploadedPayloadText = ctx.postDataText;
        }
        return typeof baseHandler === "function" ? baseHandler(ctx) : undefined;
      });

      await admin.page.goto(`/admin/books/${OPAQUE_BOOK_ID}/edit`, {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("button", { name: "Mở Cover Studio" }).click();
      await expect(admin.page.getByTestId("book-cover-studio")).toBeVisible();

      await admin.page.getByTestId("cover-gallery-input").setInputFiles({
        name: "cover.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });
      await expect(
        admin.page.getByTestId("cover-crop-rotate-panel"),
      ).toBeVisible();

      await admin.page.getByRole("button", { name: "Cắt giữa 80%" }).click();
      await admin.page.getByRole("button", { name: /Xoay 90°/ }).click();
      await admin.page.getByRole("button", { name: "Lưu ảnh bìa" }).click();

      await expect(admin.page.getByText("Đã lưu ảnh bìa mới")).toBeVisible();
      expect(uploadedPayloadText ?? "").toContain("0.8");
      expect(uploadedPayloadText ?? "").toContain("90");

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F19-02] Cover Studio custom crop sliders and AI cover generation work cleanly", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto(`/admin/books/${OPAQUE_BOOK_ID}/edit`, {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("button", { name: "Mở Cover Studio" }).click();

      await admin.page.getByTestId("cover-gallery-input").setInputFiles({
        name: "cover.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });
      await admin.page.getByRole("button", { name: "Tùy chỉnh" }).click();

      const sizeSlider = admin.page.getByLabel("Kích thước khung cắt");
      await expect(sizeSlider).toHaveAttribute("min", "30");
      await expect(sizeSlider).toHaveAttribute("max", "100");
      await sizeSlider.fill("70");

      await admin.page
        .getByLabel("Gợi ý cảnh cho bìa AI")
        .fill("Mèo con dưới nắng mai");
      await admin.page.getByRole("button", { name: "Tạo bìa bằng AI" }).click();
      await expect(admin.page.getByText("Đã tạo bìa bằng AI")).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F19-03] Smart OCR Block Review loads extraction, excludes/edits blocks, and applies to draft", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      const api = await installApiMock(
        admin.page,
        createCluster2ApiHandler(state),
      );
      await mockSupabaseStorageImages(admin.page);

      await admin.page.goto(
        `/admin/books/${OPAQUE_BOOK_ID}/pages/${OPAQUE_PAGE_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await admin.page
        .getByRole("tab", { name: /Khối thông minh V2/i })
        .click();
      await admin.page
        .getByRole("button", { name: "Mở phân loại khối chữ thông minh" })
        .click();

      await expect(
        admin.page.getByText("Rà soát nội dung trích xuất thông minh"),
      ).toBeVisible();

      await admin.page.getByRole("button", { name: "Loại bỏ" }).first().click();
      await admin.page
        .getByRole("button", { name: "Áp dụng văn bản sạch vào bản nháp" })
        .click();

      await expect
        .poll(() =>
          api
            .getRequests()
            .some(
              (r) =>
                r.method === "POST" &&
                r.path ===
                  `/studio/pages/${OPAQUE_PAGE_ID}/ocr-extraction/apply-to-draft`,
            ),
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F19-04] Page Illustration Studio extracts illustration, approves it, and loads /studio/assets/{id}/media", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(admin.page);

      await admin.page.goto(
        `/admin/books/${OPAQUE_BOOK_ID}/pages/${OPAQUE_PAGE_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await admin.page
        .getByRole("tab", { name: /Khối thông minh V2/i })
        .click();
      await admin.page.getByText("Studio tranh minh họa sạch chữ (V2)").click();

      await expect(
        admin.page.getByTestId("page-illustration-studio"),
      ).toBeVisible();
      await admin.page.getByTestId("extract-illustration-btn").click();

      await expect(admin.page.getByTestId("text-free-badge")).toContainText(
        "Đã xác minh sạch chữ",
      );
      await expect(
        admin.page.getByTestId("page-illustration-preview-img"),
      ).toBeVisible();

      await admin.page.getByTestId("approve-illustration-btn").click();
      await expect(
        admin.page.getByTestId("illustration-moderation-badge"),
      ).toContainText("Đã duyệt hiển thị cho bé");

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F19-05] Studio Tasks Center renders on mobile 390x844 and retries/cancels tasks for parent and admin @mobile", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      viewport: { width: 390, height: 844 },
    });
    const admin = await createRoleContext(browser, "admin", {
      viewport: { width: 390, height: 844 },
    });
    try {
      const parentState = createCluster2ApiState({ role: "parent" });
      await installApiMock(parent.page, createCluster2ApiHandler(parentState));
      await parent.page.goto("/studio/tasks", {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByTestId("studio-tasks-page")).toBeVisible();
      await expect(
        parent.page.getByTestId(`studio-task-row-${OPAQUE_TASK_ID}`),
      ).toBeVisible();
      const parentOverflow = await parent.page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
      expect(parentOverflow).toBe(true);

      const adminState = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(adminState));
      await admin.page.goto("/admin/tasks", {
        waitUntil: "domcontentloaded",
      });
      await expect(admin.page.getByTestId("studio-tasks-page")).toBeVisible();
      await admin.page.getByRole("button", { name: "Thử lại" }).click();
      await expect(
        admin.page.getByRole("button", { name: "Hủy" }),
      ).toBeVisible();
      await admin.page.getByRole("button", { name: "Hủy" }).click();
    } finally {
      await Promise.all([parent.dispose(), admin.dispose()]);
    }
  });

  test("[T2-F19-01] Cover upload 413 error renders localized 10 MB size error inside Cover Studio", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.faults[`POST /studio/books/${OPAQUE_BOOK_ID}/cover/upload`] = {
        status: 413,
        body: { detail: "PAYLOAD_TOO_LARGE" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto(`/admin/books/${OPAQUE_BOOK_ID}/edit`, {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("button", { name: "Mở Cover Studio" }).click();
      await admin.page.getByTestId("cover-gallery-input").setInputFiles({
        name: "cover.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });
      await admin.page.getByRole("button", { name: "Lưu ảnh bìa" }).click();

      await expect(admin.page.getByRole("alert")).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F19-02] Cover crop 422 validation error preserves staged cover state", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.faults[`POST /studio/books/${OPAQUE_BOOK_ID}/cover/upload`] = {
        status: 422,
        body: { detail: "INVALID_CROP_RECT" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto(`/admin/books/${OPAQUE_BOOK_ID}/edit`, {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("button", { name: "Mở Cover Studio" }).click();
      await admin.page.getByTestId("cover-gallery-input").setInputFiles({
        name: "cover.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });
      await admin.page.getByRole("button", { name: "Lưu ảnh bìa" }).click();

      await expect(admin.page.getByRole("alert")).toBeVisible();
      await expect(
        admin.page.getByTestId("cover-crop-rotate-panel"),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F19-03] /studio/assets/{id}/media 403/404 renders AuthenticatedImage fallback without uncaught error", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      state.faults[`GET /studio/assets/${OPAQUE_ASSET_ID}/media`] = {
        status: 403,
        body: { detail: "FORBIDDEN" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/metadata-quality?tab=user-books", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("button", { name: /Xem|Kiểm tra|Chi tiết/i })
        .first()
        .click();

      await expect(
        admin.page.getByText("Không tải được ảnh trang"),
      ).toBeVisible();
      expect(errors.pageErrors).toHaveLength(0);
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F19-04] apply-to-draft 409 on VERIFIED revision displays exact conflict notice", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.faults[
        `POST /studio/pages/${OPAQUE_PAGE_ID}/ocr-extraction/apply-to-draft`
      ] = {
        status: 409,
        body: { detail: "REVISION_VERIFIED" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(admin.page);

      await admin.page.goto(
        `/admin/books/${OPAQUE_BOOK_ID}/pages/${OPAQUE_PAGE_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await admin.page
        .getByRole("tab", { name: /Khối thông minh V2/i })
        .click();
      await admin.page
        .getByRole("button", { name: "Mở phân loại khối chữ thông minh" })
        .click();
      await admin.page
        .getByRole("button", { name: "Áp dụng văn bản sạch vào bản nháp" })
        .click();

      await expect(
        admin.page.getByText(
          "Revision hiện tại đã ở trạng thái VERIFIED nên không thể ghi đè bản nháp.",
        ),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F19-05] Smart OCR block extraction 500 displays loaderError safely", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.faults[`GET /studio/ocr/pages/${OPAQUE_PAGE_ID}/extraction`] = {
        status: 500,
        body: { detail: "EXTRACTION_FAILED" },
      };
      state.faults[`POST /studio/ocr/pages/${OPAQUE_PAGE_ID}/extract`] = {
        status: 500,
        body: { detail: "EXTRACTION_FAILED" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));
      await mockSupabaseStorageImages(admin.page);

      await admin.page.goto(
        `/admin/books/${OPAQUE_BOOK_ID}/pages/${OPAQUE_PAGE_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await admin.page
        .getByRole("tab", { name: /Khối thông minh V2/i })
        .click();
      await admin.page
        .getByRole("button", { name: "Mở phân loại khối chữ thông minh" })
        .click();

      await expect(
        admin.page.getByText(
          "Chưa thể phân loại khối chữ thông minh cho trang này.",
        ),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F19-06] Studio Tasks Center retry 409 error and actor mismatch isolation", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.faults[`POST /studio/tasks/${OPAQUE_TASK_ID}/retry`] = {
        status: 409,
        body: { detail: "TASK_NOT_RETRYABLE" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/tasks", {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("button", { name: "Thử lại" }).click();
      await expect(admin.page.getByRole("alert")).toBeVisible();

      // Actor mismatch: parent task snapshot should never populate admin task list
      state.globalTasks = makeGlobalTaskList({
        actor_id: makeOpaqueUuid(77, "11111111"),
        actor_role: "parent",
        tasks: [],
      });
      expect(OPAQUE_ADMIN_ID).not.toBe(state.globalTasks.actor_id);
    } finally {
      await admin.dispose();
    }
  });
});

// ===========================================================================
// F-20: ViRead OCR Training (5 Tier 1 + 5 Tier 2 = 10 tests)
// ===========================================================================

test.describe("F-20: ViRead OCR Training", () => {
  test("[T1-F20-01] /admin/viread-training overview renders active model, dataset readiness, jobs, runs, and Drive status", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      await expect(
        admin.page.getByRole("heading", {
          level: 1,
          name: "Huấn luyện mô hình nhận diện chữ",
        }),
      ).toBeVisible();
      await expect(
        admin.page.getByRole("tab", { name: "Tổng quan & Runtime" }),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F20-02] Flow 2 trigger creates dataset batch and queues training job", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("tab", { name: /Huấn luyện & Đánh giá/ })
        .click();
      await admin.page
        .getByRole("button", { name: "Tạo đợt dữ liệu & Xếp hàng huấn luyện" })
        .click();

      await expect(admin.page.getByText(/Đã tạo đợt dữ liệu/)).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F20-03] Pilot/Production evaluation, job delete confirm modal, and model approval decision", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("tab", { name: /Huấn luyện & Đánh giá/ })
        .click();

      await admin.page
        .getByRole("button", { name: "Chạy kiểm thử nhanh trên ứng viên" })
        .click();
      await expect(admin.page.getByText(/Pilot/)).toBeVisible();

      await admin.page
        .getByRole("button", { name: "Phê duyệt model" })
        .first()
        .click();
      await expect(admin.page.getByText(/Đã phê duyệt/i)).toBeVisible();

      await admin.page
        .getByRole("button", { name: "Xóa tác vụ cũ" })
        .first()
        .click();
      const modal = admin.page.getByRole("alertdialog");
      await expect(modal).toBeVisible();
      await modal.getByRole("button", { name: "Xóa tác vụ cũ" }).click();

      expect(state.trainingOverview.jobs).toHaveLength(0);
      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F20-04] Drive storage tab displays CONNECTED account/quota and runs health check & self-test", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("tab", { name: "Kho lưu trữ" }).click();

      await expect(
        admin.page.getByText("admin-ocr@viread.local"),
      ).toBeVisible();
      await admin.page
        .getByRole("button", { name: "Kiểm tra kết nối & dung lượng" })
        .click();
      await expect(admin.page.getByText(/Kết nối ổn định/)).toBeVisible();

      await admin.page
        .getByRole("button", { name: "Kiểm thử Upload / Đọc / Xóa" })
        .click();
      await expect(
        admin.page.getByText(/Kiểm thử tải lên \/ xác minh \/ đọc lại \/ xóa/),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F20-05] Flow 1 model replacement uploads weights + comparison JSON on mobile 390x844 @mobile", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin", {
      viewport: { width: 390, height: 844 },
    });
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("tab", { name: "Cập nhật mô hình" }).click();

      await admin.page.locator("#viread-weights-file").setInputFiles({
        name: "viread-v2.pth",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("WEIGHTS_V2_BINARY"),
      });
      await admin.page.locator("#viread-comparison-file").setInputFiles({
        name: "comparison.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(makeFlow1ComparisonPayload(true))),
      });
      await admin.page
        .getByRole("button", { name: "Tải lên & Thay thế Model" })
        .click();

      await expect(admin.page.getByText(/viread-v2-pipeline/)).toBeVisible();

      const noOverflow = await admin.page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
      expect(noOverflow).toBe(true);

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F20-01] Flow 2 trigger 409 UNRESOLVED_TRAINING_JOB_EXISTS renders safe queued notice", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.faults["POST /books/admin/viread-training/flow2/trigger"] = {
        status: 409,
        body: { detail: "UNRESOLVED_TRAINING_JOB_EXISTS" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("tab", { name: /Huấn luyện & Đánh giá/ })
        .click();
      await admin.page
        .getByRole("button", { name: "Tạo đợt dữ liệu & Xếp hàng huấn luyện" })
        .click();

      await expect(
        admin.page.getByText(
          "Đang có một lượt cập nhật mô hình chưa hoàn tất. Vui lòng đợi hoàn tất trước khi tạo lượt mới.",
        ),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F20-02] Flow 1 invalid weights extension and degraded CER/WER comparison JSON block submission", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("tab", { name: "Cập nhật mô hình" }).click();

      await admin.page.locator("#viread-weights-file").setInputFiles({
        name: "bad.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("not-weights"),
      });
      await expect(
        admin.page.getByText(
          "Tệp trọng số mô hình không đúng định dạng quy định.",
        ),
      ).toBeVisible();

      await admin.page.locator("#viread-comparison-file").setInputFiles({
        name: "regressed.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(makeFlow1ComparisonPayload(false))),
      });
      await expect(
        admin.page.getByText(
          "Model fine-tuned không vượt trội hơn baseline (chỉ số CER hoặc WER bị giảm sút trên tập kiểm thử).",
        ),
      ).toBeVisible();
      await expect(
        admin.page.getByRole("button", { name: "Tải lên & Thay thế Model" }),
      ).toBeDisabled();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F20-03] Drive TOKEN_REVOKED displays recovery guide and empty Apps Script URL shows validation error", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.trainingOverview = makeVireadTrainingOverview({
        google_drive: makeVireadDriveStatus({
          status: "TOKEN_REVOKED",
          connected: false,
          last_error_code: "DRIVE_TOKEN_REVOKED",
          google_token_revoked: true,
        }),
      });
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("tab", { name: "Kho lưu trữ" }).click();

      await expect(
        admin.page.getByText(
          "Quyền truy cập kho lưu trữ đã hết hạn hoặc bị thu hồi. Hãy bấm Kết nối lại kho lưu trữ để cấp quyền.",
        ),
      ).toBeVisible();

      await admin.page
        .getByRole("button", { name: /Kết nối không cần thẻ|Apps Script/i })
        .click();
      await expect(
        admin.page.getByRole("button", { name: /Xác minh|Lưu/i }).first(),
      ).toBeDisabled();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F20-04] Non-admin SSR guard blocks parent/anon from /admin/viread-training and API 403 renders error", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    const guest = await createRoleContext(browser, "guest");
    const admin = await createRoleContext(browser, "admin");
    try {
      const parentRes = await parent.context.request.get(
        "/admin/viread-training",
        { maxRedirects: 0 },
      );
      expect(parentRes.status()).toBe(307);
      expect(
        new URL(parentRes.headers().location ?? "", parent.baseURL).pathname,
      ).toBe("/dashboard");

      const guestRes = await guest.context.request.get(
        "/admin/viread-training",
        { maxRedirects: 0 },
      );
      expect(guestRes.status()).toBe(307);
      expect(
        new URL(guestRes.headers().location ?? "", guest.baseURL).pathname,
      ).toBe("/admin/login");

      const state = createCluster2ApiState({ role: "admin" });
      state.faults["GET /books/admin/viread-training/overview"] = {
        status: 403,
        body: { detail: "FORBIDDEN" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));
      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      await expect(admin.page.getByRole("alert")).toBeVisible();
    } finally {
      await Promise.all([parent.dispose(), guest.dispose(), admin.dispose()]);
    }
  });

  test("[T2-F20-05] Overview 503 renders error state cleanly and recovers on Làm mới", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createCluster2ApiState({ role: "admin" });
      state.faults["GET /books/admin/viread-training/overview"] = {
        status: 503,
        body: { detail: "SERVICE_UNAVAILABLE" },
      };
      await installApiMock(admin.page, createCluster2ApiHandler(state));

      await admin.page.goto("/admin/viread-training", {
        waitUntil: "domcontentloaded",
      });
      await expect(admin.page.getByRole("alert")).toBeVisible();

      delete state.faults["GET /books/admin/viread-training/overview"];
      await admin.page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        admin.page.getByRole("tab", { name: "Tổng quan & Runtime" }),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });
});
