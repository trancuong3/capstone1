import { expect, test } from "@playwright/test";

const currentChildId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const catBookId = "20000000-0000-4000-8000-000000000001";

test.describe("Group 3 verified book catalog UI", () => {
  test("dashboard opens the catalog for the selected owned child", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Bé An, lớp 2" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/books\\?childId=${currentChildId}`),
    );
    await expect(
      page.getByRole("heading", { name: "Bé An muốn đọc gì hôm nay?" }),
    ).toBeVisible();
    await expect(page.getByText("Sách đã ngừng phát hành")).toHaveCount(0);
    await expect(page.getByText("Bản thảo đang duyệt")).toHaveCount(0);
  });

  test("owned child profile opens its book catalog", async ({ page }) => {
    await page.goto(`/children/${currentChildId}`);
    await page.getByRole("link", { name: "Chọn sách cho Bé An" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/books\\?childId=${currentChildId}`),
    );
    await expect(page.getByText("Chú Mèo Nhỏ")).toBeVisible();
  });

  test("searches, filters, clears no-result state, and opens detail", async ({
    page,
  }) => {
    await page.goto(`/books?childId=${currentChildId}`);
    await expect(page.getByText("Chú Mèo Nhỏ")).toBeVisible();

    await page.getByLabel("Tìm theo tên sách hoặc tác giả").fill("không có");
    await expect(
      page.getByRole("heading", { name: "Không tìm thấy cuốn sách phù hợp" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Xóa bộ lọc" }).click();
    await expect(page.getByText("Chú Mèo Nhỏ")).toBeVisible();

    await page.getByRole("link", { name: "Đọc sách Chú Mèo Nhỏ" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/books/${catBookId}\\?childId=${currentChildId}`),
    );
    await expect(
      page.getByRole("heading", { name: "Chú Mèo Nhỏ" }),
    ).toBeVisible();
  });

  test("previews a verified page and opens the typed reading session mock", async ({
    page,
  }) => {
    await page.goto(`/books/${catBookId}?childId=${currentChildId}`);
    await page.getByRole("button", { name: "Chọn trang 5" }).click();
    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();

    await expect(page).toHaveURL(
      /\/reading\/mock-session-001\?state=ready&pageId=30000000-0000-4000-8000-000000000015/,
    );
    await expect(
      page.getByRole("heading", { name: "Sẵn sàng đọc chưa nào?" }),
    ).toBeVisible();
  });

  test("supports loading, empty, safe-error, not-found, and unavailable states", async ({
    page,
  }) => {
    await page.goto(`/books?childId=${currentChildId}&state=loading`);
    await expect(page.getByRole("status")).toContainText("Đang tải sách");

    await page.goto(`/books?childId=${currentChildId}&state=empty`);
    await expect(
      page.getByRole("heading", { name: "Thư viện đang được cập nhật" }),
    ).toBeVisible();

    await page.goto(`/books?childId=${currentChildId}&state=error`);
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Chưa tải được thư viện sách" }),
    ).toContainText("Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.");

    await page.goto(`/books/${catBookId}?state=not-found`);
    await expect(
      page.getByRole("heading", { name: "Không tìm thấy sách" }),
    ).toBeVisible();

    await page.goto(`/books/${catBookId}?state=unavailable`);
    await expect(
      page.getByRole("heading", { name: "Sách hiện chưa sẵn sàng" }),
    ).toBeVisible();
  });

  for (const route of [
    `/books?childId=${currentChildId}`,
    `/books/${catBookId}?childId=${currentChildId}`,
  ]) {
    test(`${route} has no horizontal overflow`, async ({ page }, testInfo) => {
      await page.goto(route);
      await expect(page.locator("h1")).toBeVisible();
      if (route.startsWith("/books?")) {
        await expect(
          page.getByRole("link", { name: "Đọc sách Chú Mèo Nhỏ" }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByRole("button", { name: "Chọn trang 4" }),
        ).toBeVisible();
      }
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(
        dimensions.clientWidth,
      );
      await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath("group3-visual.png"),
      });
    });
  }

  test("has no horizontal overflow at 1024px and 768px", async ({ page }) => {
    for (const width of [1024, 768]) {
      await page.setViewportSize({ height: 1000, width });

      for (const route of [
        `/books?childId=${currentChildId}`,
        `/books/${catBookId}?childId=${currentChildId}`,
      ]) {
        await page.goto(route);
        await expect(page.locator("h1")).toBeVisible();
        const dimensions = await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(
          dimensions.scrollWidth,
          `${route} at ${width}px`,
        ).toBeLessThanOrEqual(dimensions.clientWidth);
      }
    }
  });
});
