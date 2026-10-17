import { expect, test, type Page, type Route } from "@playwright/test";
import { installApiFixture, ids, child, book } from "./real-data-fixture";

const secondChildId = "22222222-2222-4222-8222-222222222223";
const olderSessionId = "44444444-4444-4444-8444-444444444446";
const summaries = [
  {
    id: ids.session,
    child_id: ids.child,
    book_id: ids.book,
    state: "IN_PROGRESS",
    started_at: "2026-10-08T03:00:00Z",
    ended_at: null,
    duration_ms: null,
  },
  {
    id: "44444444-4444-4444-8444-444444444445",
    child_id: ids.child,
    book_id: ids.book,
    state: "PAUSED",
    started_at: "2026-10-08T02:00:00Z",
    ended_at: null,
    duration_ms: null,
  },
  {
    id: olderSessionId,
    child_id: ids.child,
    book_id: ids.book,
    state: "FINISHED",
    started_at: "2026-10-07T18:30:00Z",
    ended_at: null,
    duration_ms: null,
  },
];

async function historyFixture(page: Page) {
  const base = await installApiFixture(page);
  const state = { status: 200, unsupported: false, requests: [] as string[] };
  async function respond(route: Route, data: unknown, status = 200) {
    await route.fulfill({
      status,
      headers: {
        "access-control-allow-origin": "http://127.0.0.1:3106",
        "access-control-allow-headers": "authorization,content-type,accept",
        "access-control-allow-methods": "GET,OPTIONS",
      },
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  }
  await page
    .context()
    .route("http://127.0.0.1:8000/profiles/children**", async (route) => {
      if (route.request().method() === "OPTIONS")
        return respond(route, null, 204);
      const path = new URL(route.request().url()).pathname;
      if (path === "/profiles/children")
        return respond(route, [
          child,
          { ...child, id: secondChildId, alias: "Bé khác" },
        ]);
      if (path === `/profiles/children/${secondChildId}`)
        return respond(route, {
          ...child,
          id: secondChildId,
          alias: "Bé khác",
        });
      return route.fallback();
    });
  await page
    .context()
    .route("http://127.0.0.1:8000/reading/history**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") return respond(route, null, 204);
      expect(request.method()).toBe("GET");
      expect(request.headers().authorization).toMatch(/^Bearer /);
      const url = new URL(request.url());
      state.requests.push(url.pathname + url.search);
      if (state.status !== 200)
        return respond(route, { detail: "private sql token" }, state.status);
      if (url.pathname === "/reading/history") {
        const secondChild = url.searchParams.get("child_id") === secondChildId;
        const pageTwo = url.searchParams.get("cursor") === "page-2";
        return respond(route, {
          sessions: secondChild
            ? []
            : pageTwo
              ? summaries.slice(2)
              : summaries.slice(0, 2),
          next_cursor: secondChild || pageTwo ? null : "page-2",
        });
      }
      const session = summaries.find(
        (item) =>
          url.pathname === `/reading/history/${item.id}` ||
          url.pathname === `/reading/history/${item.id}/book`,
      );
      if (!session) return respond(route, {}, 404);
      if (url.pathname.endsWith("/book"))
        return respond(route, { ...book, lifecycle_status: "RETIRED" });
      return respond(route, {
        ...session,
        selected_page_revision_ids: [ids.revision],
        reference_page_revision_ids: [ids.oldRevision],
        events: state.unsupported
          ? []
          : [
              {
                id: ids.page,
                session_id: session.id,
                page_id: ids.page,
                page_revision_id: ids.oldRevision,
                page_revision_word_id: null,
                type: "MISPRONUNCIATION",
                status: "DETECTED",
                start_ms: 1000,
                end_ms: null,
                confidence: null,
                metadata: {},
              },
            ],
        fluency_assessment: null,
        comprehension: state.unsupported
          ? []
          : [
              {
                question: {
                  id: ids.revision,
                  type: "FACTUAL",
                  prompt: "Câu hỏi đã lưu",
                  page_revision_id: ids.oldRevision,
                  source_span: null,
                  difficulty: "EASY",
                  answered: true,
                },
                answer: {
                  answer_id: ids.page,
                  question_id: ids.revision,
                  submitted_answer: "Câu trả lời đã lưu",
                  is_correct: null,
                  score: null,
                  feedback_code: null,
                },
              },
            ],
        availability: {
          events: state.unsupported ? "unsupported" : "available",
          fluency: "unsupported",
          comprehension: state.unsupported ? "unsupported" : "partial",
        },
        report_id: null,
      });
    });
  return { state, base };
}

async function assertFits(page: Page) {
  const size = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.width);
}

test("History: paging → completed detail with missing end → return to the same child/page", async ({
  page,
}) => {
  const { state, base } = await historyFixture(page);
  await page.goto(`/sessions?childId=${ids.child}`);
  await expect(page.getByText("Đang thực hiện", { exact: true })).toBeVisible();
  await expect(page.getByText("Đang tạm dừng", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Trang sau", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`childId=${ids.child}&page=2$`));
  await expect(page.getByText("Đã hoàn thành", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Trang sau", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Xem chi tiết", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/sessions/${olderSessionId}\\?childId=${ids.child}&page=2$`),
  );
  await expect(
    page.getByRole("heading", { name: "Buổi đọc đã hoàn thành" }),
  ).toBeVisible();
  await expect(
    page.getByText("Chưa có dữ liệu thời lượng", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Đã phát hiện, chưa xác nhận", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Bằng chứng lỗi đã xác nhận.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Trả lời: Câu trả lời đã lưu · Chưa chấm", { exact: true }),
  ).toBeVisible();
  await assertFits(page);
  await page.screenshot({
    path: test.info().outputPath("history-detail.png"),
    fullPage: true,
  });
  await page
    .getByRole("main")
    .getByRole("link", { name: "Lịch sử", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/sessions\\?childId=${ids.child}&page=2$`),
  );
  await expect(page.getByText("Đã hoàn thành", { exact: true })).toBeVisible();
  expect(state.requests.some((url) => url.includes("cursor=page-2"))).toBe(
    true,
  );
  expect(base.unexpected).toEqual([]);
  await assertFits(page);
});

test("History: selecting another child resets page and shows a genuine empty list", async ({
  page,
}) => {
  const { state, base } = await historyFixture(page);
  await page.goto(`/sessions?childId=${ids.child}&page=2`);
  await page.getByRole("combobox").selectOption(secondChildId);
  await expect(page).toHaveURL(
    new RegExp(`/sessions\\?childId=${secondChildId}$`),
  );
  await expect(
    page.getByRole("heading", { name: "Chưa có buổi đọc", exact: true }),
  ).toBeVisible();
  expect(
    state.requests
      .filter((url) => url.includes(`child_id=${secondChildId}`))
      .every((url) => !url.includes("cursor=")),
  ).toBe(true);
  expect(base.unexpected).toEqual([]);
  await assertFits(page);
});

test("History: unsupported optional data and retry remain distinct from no data", async ({
  page,
}) => {
  const { state, base } = await historyFixture(page);
  state.unsupported = true;
  await page.goto(`/sessions/${olderSessionId}?childId=${ids.child}&page=2`);
  await expect(
    page.getByRole("heading", { name: "Buổi đọc đã hoàn thành" }),
  ).toBeVisible();
  await expect(page.getByText(/Có sự kiện đã lưu/)).toBeVisible();
  await expect(
    page.getByText("Buổi đọc này chưa có sự kiện để hiển thị."),
  ).toHaveCount(0);
  await expect(
    page.getByText("Buổi đọc này không có câu hỏi đọc hiểu."),
  ).toHaveCount(0);
  state.status = 503;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Dữ liệu đang chờ bổ sung" }),
  ).toBeVisible();
  await expect(page.getByText("private sql token")).toHaveCount(0);
  state.status = 200;
  await page.getByRole("button", { name: "Thử lại", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Buổi đọc đã hoàn thành" }),
  ).toBeVisible();
  expect(base.unexpected).toEqual([]);
  await assertFits(page);
});
