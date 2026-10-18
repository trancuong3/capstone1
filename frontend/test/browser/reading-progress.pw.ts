import { expect, test, type Page, type Route } from "@playwright/test";
import { installApiFixture, ids, child } from "./real-data-fixture";

const secondChild = "22222222-2222-4222-8222-222222222223";
const period = {
  id: ids.session,
  child_id: ids.child,
  period_start: "2026-09-09",
  period_end: "2026-10-08",
  generated_at: "2026-10-08T01:00:00Z",
};
const older = {
  ...period,
  period_start: "2026-08-01",
  period_end: "2026-08-31",
};
const report = {
  ...period,
  completed_sessions: 3,
  reading_duration_ms: 900000,
  omission_count: 2,
  repetition_count: 1,
  long_pause_count: 0,
  omission_rate: 2,
  repetition_rate: null,
  long_pause_rate: null,
  comprehension_accuracy: null,
  difficult_words: [],
  previous_period: null,
  trend_deltas: null,
  legacy: null,
  data_status: "complete",
  availability: {
    metrics: "available",
    difficult_words: "available",
    comparison: "absent",
  },
};

async function progressFixture(page: Page) {
  const base = await installApiFixture(page);
  const state = { error: false, unsupported: false, requests: [] as string[] };
  async function respond(route: Route, json: unknown, status = 200) {
    await route.fulfill({
      status,
      headers: {
        "access-control-allow-origin": "http://127.0.0.1:3106",
        "access-control-allow-headers": "authorization,content-type,accept",
        "access-control-allow-methods": "GET,OPTIONS",
      },
      contentType: "application/json",
      body: status === 204 ? undefined : JSON.stringify(json),
    });
  }
  await page
    .context()
    .route("http://127.0.0.1:8000/profiles/children**", async (route) => {
      if (route.request().method() === "OPTIONS")
        return respond(route, null, 204);
      expect(route.request().method()).toBe("GET");
      const path = new URL(route.request().url()).pathname;
      if (path === "/profiles/children")
        return respond(route, [
          child,
          { ...child, id: secondChild, alias: "Bé khác" },
        ]);
      if (path === `/profiles/children/${secondChild}`)
        return respond(route, { ...child, id: secondChild, alias: "Bé khác" });
      return route.fallback();
    });
  await page
    .context()
    .route("http://127.0.0.1:8000/system/progress/**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") return respond(route, null, 204);
      expect(request.method()).toBe("GET");
      expect(request.headers().authorization).toMatch(/^Bearer /);
      const url = new URL(request.url());
      state.requests.push(url.pathname + url.search);
      if (state.error)
        return respond(route, { detail: "private sql token" }, 503);
      if (url.pathname.includes(secondChild))
        return respond(
          route,
          url.pathname.endsWith("/periods")
            ? { items: [], next_cursor: null }
            : {},
          url.pathname.endsWith("/periods") ? 200 : 404,
        );
      if (url.pathname.endsWith("/periods"))
        return respond(route, {
          items: url.searchParams.get("cursor") ? [older] : [period],
          next_cursor: url.searchParams.get("cursor") ? null : "page-2",
        });
      const start = url.searchParams.get("period_start");
      if (start === older.period_start)
        return respond(route, {
          ...report,
          ...older,
          completed_sessions: null,
          reading_duration_ms: null,
          omission_count: null,
          difficult_words: null,
          legacy: { avg_fluency: 80, total_books: 2 },
          data_status: "partial",
          availability: {
            metrics: "partial",
            difficult_words: "absent",
            comparison: "absent",
          },
        });
      if (start !== null && start !== period.period_start)
        return respond(route, {}, 404);
      if (state.unsupported)
        return respond(route, {
          ...report,
          completed_sessions: null,
          reading_duration_ms: null,
          omission_count: null,
          repetition_count: null,
          long_pause_count: null,
          omission_rate: null,
          difficult_words: null,
          data_status: "unsupported",
          availability: {
            metrics: "unsupported",
            difficult_words: "unsupported",
            comparison: "absent",
          },
        });
      return respond(route, report);
    });
  return { base, state };
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

test("Progress latest → load periods → old snapshot → reload → child resets period", async ({
  page,
}, info) => {
  const { base, state } = await progressFixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/reports?childId=${ids.child}`);
  await expect(page.getByText("3 buổi", { exact: true })).toBeVisible();
  expect(
    state.requests.some((url) => url === `/system/progress/${ids.child}`),
  ).toBe(true);
  await expect(page.getByText(/Kỳ: 2026-09-09 → 2026-10-08/)).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("progress-latest.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Tải thêm kỳ" }).click();
  await expect(page.getByRole("button", { name: "Tải thêm kỳ" })).toHaveCount(
    0,
  );
  await page
    .getByLabel("Kỳ báo cáo đã lưu")
    .selectOption("2026-08-01/2026-08-31");
  await expect(page).toHaveURL(/period_start=2026-08-01&period_end=2026-08-31/);
  await expect(
    page.getByRole("heading", { name: "Chỉ số định dạng cũ" }),
  ).toBeVisible();
  await expect(page.getByText("0 buổi", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Chỉ số định dạng cũ" }),
  ).toBeVisible();
  await expect(page.getByLabel("Kỳ báo cáo đã lưu")).toHaveValue(
    "2026-08-01/2026-08-31",
  );
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("progress-legacy.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Chọn hồ sơ bé để xem dữ liệu")
    .selectOption(secondChild);
  await expect(page).toHaveURL(
    new RegExp(`/reports\\?childId=${secondChild}$`),
  );
  await expect(
    page.getByRole("heading", { name: "Chưa có báo cáo đã lưu" }),
  ).toBeVisible();
  await expect(page.getByLabel("Kỳ báo cáo đã lưu")).toHaveValue("latest");
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Chỉ số định dạng cũ" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Progress invalid, missing period, retry and unsupported are distinct", async ({
  page,
}) => {
  const { base, state } = await progressFixture(page);
  await page.goto(
    `/reports?childId=${ids.child}&period_start=2026-02-30&period_end=2026-03-01`,
  );
  await expect(
    page.getByText("Kỳ báo cáo không hợp lệ", { exact: true }),
  ).toBeVisible();
  expect(state.requests).toEqual([]);
  await page.goto(
    `/reports?childId=${ids.child}&period_start=2026-01-01&period_end=2026-01-31`,
  );
  await expect(
    page.getByRole("heading", { name: "Chưa có báo cáo cho kỳ đã chọn" }),
  ).toBeVisible();
  await expect(page.getByText("3 buổi", { exact: true })).toHaveCount(0);
  state.error = true;
  await page.goto(`/reports?childId=${ids.child}`);
  await expect(
    page.getByText("Dữ liệu đang chờ bổ sung", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("private sql token")).toHaveCount(0);
  state.error = false;
  state.unsupported = true;
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(
    page.getByText("Định dạng báo cáo chưa được hỗ trợ", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("0 buổi", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Kỳ báo cáo đã lưu")).toBeEnabled();
  await noOverflow(page);
  expect(base.unexpected).toEqual([]);
});
