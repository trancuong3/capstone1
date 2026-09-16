import { expect, test } from "@playwright/test";

import {
  createCalendarWindow,
  currentDateInReportTimezone,
  REPORT_DEFAULT_DAYS,
} from "@/lib/utils/report-state";

const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const foreignChildId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "mock-session-001";

test.describe("Group 5 parent history and reports", () => {
  test("history paginates and opens a session detail", async ({ page }) => {
    await page.goto(`/sessions?childId=${childId}`);
    await expect(
      page.getByRole("heading", { name: "Lịch sử buổi đọc" }),
    ).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.getByRole("link", { name: "Trang sau" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByRole("link", { name: "Trang trước" })).toBeVisible();
  });

  test("session detail preserves historical revision and nullable score", async ({
    page,
  }) => {
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByText("Chưa đánh giá")).toBeVisible();
    await expect(
      page.getByText("40000000-0000-4000-8000-900000000014").first(),
    ).toBeVisible();
    await expect(page.getByText("Sự kiện trong buổi đọc")).toBeVisible();
  });

  test("report uses a 30-day calendar period and handles no prior period", async ({
    page,
  }) => {
    const period = createCalendarWindow(
      currentDateInReportTimezone(),
      REPORT_DEFAULT_DAYS,
    );

    await page.goto(`/reports?childId=${childId}&state=no-prior-period`);
    await expect(
      page.getByText(`${period.period_start} → ${period.period_end}`),
    ).toBeVisible();
    await expect(page.getByText("Chưa đủ kỳ so sánh")).toBeVisible();
    await expect(
      page.getByRole("table", {
        name: "Tóm tắt dạng bảng của biểu đồ bằng chứng đọc",
      }),
    ).toBeAttached();
  });

  test("difficult words provide mock-only practice", async ({ page }) => {
    await page.goto(`/reports/difficult-words?childId=${childId}`);
    await expect(
      page.getByRole("heading", { name: /Từ cần luyện của/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Luyện từ" }).first().click();
    await expect(
      page.getByText(/không phát TTS thật và không thêm bằng chứng/),
    ).toBeVisible();
  });

  test("foreign resources return a safe not-found state", async ({ page }) => {
    await page.goto(`/reports?childId=${foreignChildId}`);
    await expect(page.getByText("Không tìm thấy báo cáo")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Hồ sơ riêng tư");
  });

  test("complete reading links to the parent session summary", async ({
    page,
  }) => {
    await page.goto(`/reading/${sessionId}?state=complete`);
    await page.getByRole("link", { name: "Xem cùng ba mẹ" }).click();
    await expect(page).toHaveURL(`/sessions/${sessionId}`);
    await expect(page.getByText("Chi tiết buổi đọc")).toBeVisible();
  });

  for (const route of [
    `/sessions?childId=${childId}`,
    `/sessions/${sessionId}`,
    `/reports?childId=${childId}`,
    `/reports/difficult-words?childId=${childId}`,
  ]) {
    test(`${route} has no horizontal overflow`, async ({ page }, testInfo) => {
      await page.goto(route);
      await expect(page.locator("h1:visible").first()).toBeVisible();
      const size = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth);
      if (route.startsWith("/reports?")) {
        await page.screenshot({
          fullPage: true,
          path: testInfo.outputPath("group5-report-visual.png"),
        });
      }
    });
  }

  test("report surfaces reflow at 1024px and 768px", async ({ page }) => {
    for (const width of [1024, 768]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of [
        `/sessions?childId=${childId}`,
        `/reports?childId=${childId}`,
        `/reports/difficult-words?childId=${childId}`,
      ]) {
        await page.goto(route);
        await expect(page.locator("h1:visible").first()).toBeVisible();
        const hasOverflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
        expect(hasOverflow).toBe(false);
      }
    }
  });
});
