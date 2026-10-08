import { expect, test, type Page } from "@playwright/test";
import {
  book,
  child,
  ids,
  installApiFixture,
  setRole,
} from "./real-data-fixture";

async function assertLayout(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
}

test("Parent dashboard → catalog → real book metadata with unavailable preview", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await page.goto("/dashboard");
  await page.getByRole("link", { name: `${child.alias}, lớp 2` }).click();
  await expect(page).toHaveURL(new RegExp(`/books\\?childId=${ids.child}`));
  await page.getByRole("link", { name: `Đọc sách ${book.title}` }).click();
  await expect(
    page.getByRole("heading", { name: book.title, exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Ảnh xem trước chưa sẵn sàng")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Bắt đầu đọc" }),
  ).toBeDisabled();
  expect(api.unexpected).toEqual([]);
});

test("Parent search, no result, keyboard clear and API retry", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await page.goto("/books?state=empty");
  await expect(
    page.getByRole("link", { name: `Đọc sách ${book.title}` }),
  ).toBeVisible();
  await page.getByLabel("Tìm theo tên sách hoặc tác giả").fill("không có");
  await expect(
    page.getByRole("heading", { name: "Không tìm thấy cuốn sách phù hợp" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Xóa bộ lọc" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("link", { name: `Đọc sách ${book.title}` }),
  ).toBeVisible();
  api.catalogStatus = 503;
  await page.reload();
  await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
  await expect(page.getByText("private sql token")).toHaveCount(0);
  api.catalogStatus = 200;
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(
    page.getByRole("link", { name: `Đọc sách ${book.title}` }),
  ).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Parent actual empty catalog and foreign book not found", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  api.emptyCatalog = true;
  await page.goto("/books");
  await expect(
    page.getByRole("heading", { name: "Thư viện đang được cập nhật" }),
  ).toBeVisible();
  await page.goto(`/books/${ids.page}`);
  await expect(
    page.getByRole("heading", { name: "Không tìm thấy sách" }),
  ).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Parent stored history → detail, report counts and words", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await page.goto(`/sessions?childId=${ids.child}`);
  await expect(page.getByText(book.title).first()).toBeVisible();
  await page.locator(`a[href="/sessions/${ids.session}"]`).click();
  await expect(
    page.getByRole("heading", { name: "Buổi đọc chưa hoàn tất" }),
  ).toBeVisible();
  await expect(page.getByText("Chưa đánh giá")).toBeVisible();
  await page.goto(`/reports?childId=${ids.child}`);
  await expect(page.getByText("2 buổi", { exact: true })).toBeVisible();
  await page.goto(`/reports/difficult-words?childId=${ids.child}`);
  await expect(page.getByRole("heading", { name: "Mèo API" })).toBeVisible();
  await page.getByRole("button", { name: "Luyện từ" }).click();
  await expect(
    page.getByText(/Chức năng luyện từ chưa sẵn sàng/),
  ).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Parent unavailable reports/history do not manufacture zero data and can retry", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  api.reportStatus = 501;
  api.historyStatus = 501;
  for (const path of [
    "/reports",
    "/reports/difficult-words",
    "/sessions",
    `/sessions/${ids.session}`,
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Dữ liệu đang chờ bổ sung" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Thử lại" })).toBeVisible();
    await assertLayout(page);
  }
  api.historyStatus = 200;
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(
    page.getByRole("heading", { name: "Buổi đọc chưa hoàn tất" }),
  ).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Admin catalog → metadata, unavailable pages retry, audit and health", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await setRole(page, "admin");
  api.adminPagesStatus = 501;
  await page.goto("/admin/books?state=empty");
  await page.getByRole("link", { name: new RegExp(book.title) }).click();
  await expect(page.getByRole("heading", { name: book.title })).toBeVisible();
  await expect(page.getByText("Dữ liệu trang đang chờ bổ sung")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sửa thông tin" }),
  ).toBeDisabled();
  api.adminPagesStatus = 200;
  await page.getByRole("button", { name: "Tải lại" }).click();
  await expect(page.getByRole("heading", { name: "Trang 2" })).toBeVisible();
  await page.goto("/admin/audit-logs");
  await expect(page.getByText("book.read", { exact: true })).toBeVisible();
  await expect(page.getByText("Hệ thống", { exact: true })).toBeVisible();
  await page.goto("/admin/health");
  await expect(page.getByRole("heading", { name: "Database" })).toBeVisible();
  await page.getByRole("button", { name: "Kiểm tra lại" }).click();
  await expect(
    page.getByText("Database đã phản hồi truy vấn đọc."),
  ).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Admin OCR is read-only, switches stored revision and cannot create books", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await setRole(page, "admin");
  await page.goto(`/admin/books/${ids.book}/pages/${ids.page}`);
  await expect(
    page.getByRole("heading", { name: "Kiểm tra OCR · R2" }),
  ).toBeVisible();
  await expect(page.getByLabel("Nội dung đã hiệu chỉnh")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Chạy lại OCR" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: /^R1/ }).click();
  await expect(page.getByLabel("Nội dung đã hiệu chỉnh")).toHaveValue(
    "Văn bản revision cũ",
  );
  await page.goto("/admin/books/new");
  await expect(
    page.getByText(/API tạo sách chưa được triển khai/),
  ).toBeVisible();
  await expect(page.locator("form")).toHaveCount(0);
  expect(api.unexpected).toEqual([]);
});

for (const width of [1440, 1024, 768, 390]) {
  test(`read-route matrix, headings, console and overflow at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "Matrix itself covers all four widths.",
    );
    test.setTimeout(240_000);
    const api = await installApiFixture(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().includes("503 (Service Unavailable)")
      )
        consoleErrors.push(message.text());
    });
    const paths = [
      "/dashboard",
      "/profile",
      "/children",
      "/books",
      `/books/${ids.book}`,
      "/sessions",
      `/sessions/${ids.session}`,
      "/reports",
      "/reports/difficult-words",
      "/admin/books",
      `/admin/books/${ids.book}`,
      `/admin/books/${ids.book}/pages/${ids.page}`,
      "/admin/audit-logs",
      "/admin/health",
      "/admin/books/new",
    ];
    for (const [index, path] of paths.entries()) {
      await setRole(page, path.startsWith("/admin/") ? "admin" : "parent");
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await expect(page.locator("h1").first(), path).toBeVisible();
      // Wait for the intended content, not a transient skeleton or hidden heading.
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      if (path === "/admin/books")
        await expect(
          page.getByRole("link", { name: new RegExp(book.title) }),
        ).toBeVisible();
      if (path === `/admin/books/${ids.book}`)
        await expect(
          page.getByRole("heading", { name: "Trang 2" }),
        ).toBeVisible();
      if (path === `/admin/books/${ids.book}/pages/${ids.page}`)
        await expect(page.getByLabel("Nội dung đã hiệu chỉnh")).toHaveValue(
          "Văn bản đã lưu",
        );
      if (path === "/admin/audit-logs")
        await expect(
          page.getByText("book.read", { exact: true }),
        ).toBeVisible();
      if (path === "/admin/health")
        await expect(
          page.getByRole("heading", { name: "Database" }),
        ).toBeVisible();
      await assertLayout(page);
      if (width === 1440 || width === 390)
        await page.screenshot({
          path: testInfo.outputPath(`route-${index}-${width}.png`),
          fullPage: true,
          // Do not mutate input styles while React is hydrating the page.
          caret: "initial",
        });
    }
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });
}
