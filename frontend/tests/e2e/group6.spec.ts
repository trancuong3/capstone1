import { expect, test } from "@playwright/test";

const bookPath = "/admin/books/82000000-0000-4000-8000-000000000001";
const ocrPath = `${bookPath}/pages/83000000-0000-4000-8000-000000000001`;

test("admin login reaches the book catalog and logout returns safely", async ({
  page,
}) => {
  await page.goto("/admin/login");
  await page.getByLabel("Mật khẩu").fill("matkhau123");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL(/\/admin\/books$/);
  await expect(page.getByRole("heading", { name: "Kho sách" })).toBeVisible();
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(
    page.getByRole("heading", { name: "Đăng nhập quản trị" }),
  ).toBeVisible();
});

test("admin creates a book and reaches its detail", async ({ page }) => {
  await page.goto("/admin/books/new");
  await page.getByLabel("Tên sách").fill("Cuốn sách kiểm thử");
  await page.getByRole("button", { name: "Tạo sách" }).click();
  await expect(page).toHaveURL(/\/admin\/books\/82000000-/);
  await expect(
    page.getByRole("heading", { name: "Cuốn sách kiểm thử" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Tải trang sách" }),
  ).toBeVisible();
});

test("admin reprocesses, edits and verifies R2 while retaining R1", async ({
  page,
}) => {
  await page.goto(ocrPath);
  await expect(
    page.getByRole("heading", { name: /Kiểm tra OCR · R1/ }),
  ).toBeVisible();
  await expect(
    page.getByText(/Revision đã xác minh là bất biến/),
  ).toBeVisible();
  await expect(page.getByLabel(/Bounding box từ/).first()).toBeVisible();
  await page.getByRole("button", { name: /Chạy lại OCR/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Chạy lại OCR" })
    .click();
  await expect(page.getByText(/Đã tạo R2/)).toBeVisible();
  const editor = page.getByLabel("Nội dung đã hiệu chỉnh");
  await editor.fill("Chú mèo nhỏ vui vẻ");
  await page.getByRole("button", { name: "Lưu nháp" }).click();
  await expect(page.getByText("Đã lưu bản nháp OCR.")).toBeVisible();
  await page.getByRole("button", { name: "Xác minh", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Xác minh" })
    .click();
  await expect(page.getByText(/Đã xác minh R2/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /R2.*Hiện hành/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^R1/ })).toBeVisible();
});

test("operational review routes expose safe mock states", async ({ page }) => {
  await page.goto("/admin/audit-logs");
  await expect(
    page.getByRole("heading", { name: "Nhật ký kiểm toán" }),
  ).toBeVisible();
  await expect(page.getByText("PAGE_REVISION_VERIFIED")).toBeVisible();
  await expect(page.getByText(/password|credential/i)).toHaveCount(0);
  await page.goto("/admin/health?state=degraded");
  await expect(
    page.getByRole("heading", { name: "Tình trạng vận hành" }),
  ).toBeVisible();
  await expect(page.getByText("Hạn chế").first()).toBeVisible();
});

test("catalog exposes loading, empty, safe error and forbidden states", async ({
  page,
}) => {
  await page.goto("/admin/books?state=loading");
  await expect(page.getByText("Đang tải dữ liệu quản trị…")).toBeVisible();
  await page.goto("/admin/books?state=empty");
  await expect(
    page.getByRole("heading", { name: "Không tìm thấy sách" }),
  ).toBeVisible();
  await page.goto("/admin/books?state=error");
  await expect(
    page.getByRole("alert").filter({ hasText: "Không thể tải kho sách" }),
  ).toContainText("Không thể tải kho sách");
  await page.goto("/admin/books?state=forbidden");
  await expect(
    page.getByRole("alert").filter({ hasText: "Không có quyền truy cập" }),
  ).toContainText("Không có quyền truy cập");
});

test("admin validates upload then reloads PROCESSING into NEEDS_REVIEW", async ({
  page,
}) => {
  await page.goto(bookPath);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "not-an-image.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(
    page.getByRole("region", { name: "Tải trang sách" }).getByRole("alert"),
  ).toContainText("chỉ chấp nhận JPEG");
  await input.setInputFiles({
    name: "page-6.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n+UAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(
    page.getByRole("img", { name: "Xem trước page-6.png" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Tải lên 1 trang/ }).click();
  await expect(page.getByText(/Đã tải trang lên/)).toBeVisible();
  await expect(page.getByText("Trang 6")).toBeVisible();
  await page.getByRole("button", { name: "Tải lại" }).click();
  await expect(
    page.getByText(/Đã tải lại trạng thái xử lý trang/),
  ).toBeVisible();
  await expect(page.getByText("Cần kiểm tra").first()).toBeVisible();
});

test("admin retires a book without deleting its pages", async ({ page }) => {
  await page.goto(bookPath);
  await page.getByRole("button", { name: "Ngừng phát hành" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Xác nhận ngừng" })
    .click();
  await expect(page.getByText("Đã ngừng")).toBeVisible();
  await expect(page.getByText("Trang 4")).toBeVisible();
});
