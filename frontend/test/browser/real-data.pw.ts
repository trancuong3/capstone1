import { expect, test, type Page } from "@playwright/test";
import {
  book,
  child,
  ids,
  installApiFixture,
  setRole,
} from "./real-data-fixture";

async function assertLayout(page: Page) {
  const dimensions = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const overflowingElements = Array.from(
      document.body.querySelectorAll("*"),
    )
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const htmlElement = element as HTMLElement;
        return {
          tag: element.tagName.toLowerCase(),
          className:
            typeof htmlElement.className === "string"
              ? htmlElement.className
              : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          overflowX: window.getComputedStyle(element).overflowX,
          text: element.textContent?.trim().slice(0, 70),
        };
      })
      .filter((element) => element.width > 0 && element.right > width + 1)
      .sort((left, right) => right.right - left.right)
      .slice(0, 20);

    return {
      width,
      scroll: document.documentElement.scrollWidth,
      overflowingElements,
    };
  });
  expect(
    dimensions.scroll,
    `Horizontal overflow: ${JSON.stringify(dimensions.overflowingElements)}`,
  ).toBeLessThanOrEqual(dimensions.width);
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
  await page.getByRole("link", { name: "Xem chi tiết", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Buổi đọc đã dừng" }),
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
    page.getByRole("heading", { name: "Buổi đọc đã dừng" }),
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
    page.getByRole("link", { name: "Chỉnh sửa metadata / vòng đời" }),
  ).toBeVisible();
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

test("Admin OCR is read-only and can switch to a stored revision", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await setRole(page, "admin");
  await page.goto(`/admin/books/${ids.book}/pages/${ids.page}`);
  await expect(
    page.getByRole("heading", { name: "Kiểm tra OCR · R2" }),
  ).toBeVisible();
  await expect(page.getByLabel("Nội dung trang")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Chạy lại OCR" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: /Revision R1/ }).click();
  await expect(page.getByLabel("Nội dung trang")).toHaveValue(
    "Văn bản revision cũ",
  );
  expect(api.unexpected).toEqual([]);
});

test("Admin book creation requires separate name and title and sends normalized metadata", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await setRole(page, "admin");
  await page.goto("/admin/books/new");

  const name = page.getByRole("textbox", { name: "Tên sách *" });
  const title = page.getByRole("textbox", { name: "Tiêu đề sách *" });
  await page.getByRole("button", { name: "Tạo sách" }).click();
  await expect(
    page.getByText("Vui lòng nhập tên sách.", { exact: true }),
  ).toBeVisible();
  expect(api.createBookRequest).toBeNull();

  await name.fill("  Tên hiển thị mới  ");
  await page.getByRole("button", { name: "Tạo sách" }).click();
  await expect(
    page.getByText("Vui lòng nhập tiêu đề sách.", { exact: true }),
  ).toBeVisible();
  expect(api.createBookRequest).toBeNull();

  await title.fill("  Cuốn sách mới  ");
  await page.getByLabel(/Tác giả/).fill("  Tác giả A  ");
  await page.getByRole("button", { name: "Tạo sách" }).click();

  await expect(page).toHaveURL(
    /\/admin\/books\/88888888-8888-4888-8888-888888888888$/,
  );
  await expect(
    page.getByRole("heading", { name: "Cuốn sách mới", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sách chưa có trang" }),
  ).toBeVisible();
  expect(api.createBookRequest).toEqual({
    name: "Tên hiển thị mới",
    title: "Cuốn sách mới",
    author: "Tác giả A",
    min_grade: 1,
    max_grade: 5,
  });
  expect(api.unexpected).toEqual([]);
});

for (const width of [320, 375, 430, 768, 1366, 1920]) {
  test(`read-route matrix, headings, console and overflow at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "Matrix itself covers all four widths.",
    );
    test.setTimeout(360_000);
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
        await expect(page.getByLabel("Nội dung trang")).toHaveValue(
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
      if (width === 1366 || width === 375)
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
