import { expect, test, type Page, type Route } from "@playwright/test";
import { installApiFixture, ids, child } from "./real-data-fixture";

const NOW = "2026-11-22T10:00:00Z";
const CHILD_2_ID = "22222222-2222-4222-8222-222222222229";
function respond(route: Route, data: unknown, status = 200) {
  const origin = route.request().headers()["origin"] ?? "http://127.0.0.1:3106";
  return route.fulfill({
    status,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization,content-type,accept",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    },
    contentType: "application/json",
    body: JSON.stringify(data),
  });
}

function makePrivateBook(
  index: number,
  overrides: Record<string, unknown> = {},
) {
  const id = `aa000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    title:
      index === 1
        ? "Cuốn sách có tiêu đề cực kỳ dài về chuyến phiêu lưu kỳ thú của chú mèo mướp qua khu rừng mùa thu đầy lá vàng"
        : `Sách Gia Đình #${String(index).padStart(3, "0")}`,
    author: `Gia đình Bé An (${index})`,
    min_grade: 1,
    max_grade: 3,
    lifecycle_status: "ACTIVE",
    visibility_scope: "PARENT_PRIVATE",
    moderation_status: "ACTIVE",
    suspended_reason: null,
    source_declaration: "[OWNED_PHYSICAL_BOOK] Sách giấy tại nhà",
    committed_page_count: index % 4,
    pending_submission_count: 0,
    flagged_submission_count: 0,
    failed_submission_count: 0,
    ready_to_add_count: 0,
    readable_for_children: index % 2 === 0,
    has_held_multipage_batch: false,
    privacy_notice: "Chỉ bạn và các hồ sơ trẻ của bạn có thể đọc sách này.",
    created_at: NOW,
    ...overrides,
  };
}

async function assertNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function installBaseRoutes(page: Page) {
  await installApiFixture(page);
  await page
    .context()
    .route("http://127.0.0.1:8000/profiles/me", async (route) => {
      if (route.request().method() === "OPTIONS")
        return respond(route, null, 204);
      return respond(route, {
        id: ids.parent,
        role: "parent",
        display_name: "Ba mẹ API",
        email: "parent@example.test",
        phone: null,
        avatar_url: null,
        active: true,
        created_at: NOW,
      });
    });
  await page
    .context()
    .route("http://127.0.0.1:8000/books/catalog**", async (route) => {
      if (route.request().method() === "OPTIONS")
        return respond(route, null, 204);
      return respond(route, []);
    });
}

async function setupMyBooksFixture(page: Page, initialCount: number) {
  await installBaseRoutes(page);
  let books = Array.from({ length: initialCount }, (_, idx) =>
    makePrivateBook(idx + 1),
  );

  await page
    .context()
    .route("http://127.0.0.1:8000/books/my-books**", async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return respond(route, null, 204);
      const url = new URL(req.url());
      const method = req.method().toUpperCase();

      if (url.pathname === "/books/my-books/paged" && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? "9");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        return respond(route, {
          items: books.slice(offset, offset + limit),
          total: books.length,
          limit,
          offset,
        });
      }
      if (url.pathname === "/books/my-books" && method === "GET") {
        return respond(route, books);
      }
      const detailMatch = url.pathname.match(/^\/books\/my-books\/([^/]+)$/);
      if (detailMatch && method === "GET") {
        const found = books.find((b) => b.id === detailMatch[1]);
        if (!found) return respond(route, { detail: "Not found" }, 404);
        return respond(route, {
          book: found,
          pages: [],
          submissions: [],
        });
      }
      if (detailMatch && method === "DELETE") {
        books = books.filter((b) => b.id !== detailMatch[1]);
        return respond(route, {
          status: "deleted",
          book_id: detailMatch[1],
          retired_pages_count: 0,
          cancelled_submissions_count: 0,
        });
      }
      return route.fallback();
    });

  return {
    setCount(count: number) {
      books = Array.from({ length: count }, (_, idx) =>
        makePrivateBook(idx + 1),
      );
    },
  };
}

async function setupReadingManagementFixture(page: Page) {
  await installBaseRoutes(page);
  const child2 = {
    ...child,
    id: CHILD_2_ID,
    alias: "Bé Bình",
    grade: 3,
  };
  let child1Reminders = Array.from({ length: 20 }, (_, i) => ({
    id: `55555555-5555-4555-8555-${String(i + 1).padStart(12, "0")}`,
    child_id: ids.child,
    remind_at: `${String(6 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 === 0 ? "00" : "30"}:00`,
    weekdays: [0, 1, 2, 3, 4],
    timezone: "Asia/Ho_Chi_Minh",
    is_active: true,
    email_enabled: i % 2 === 0,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  }));
  const child1Plans = Array.from({ length: 12 }, (_, i) => ({
    id: `66666666-6666-4666-8666-${String(i + 1).padStart(12, "0")}`,
    child_id: ids.child,
    book_id: null,
    book_title: null,
    title: `Kế hoạch tuần #${i + 1}`,
    target_minutes: 20,
    weekdays: [0, 2, 4],
    starts_on: "2026-11-01",
    ends_on: null,
    timezone: "Asia/Ho_Chi_Minh",
    status: "ACTIVE",
    scheduled_days_this_week: 3,
    completed_days_this_week: 1,
    progress_percent: 33,
    completed_at: null,
    created_at: NOW,
    updated_at: NOW,
    phase: "RUNNING",
    next_scheduled_date: "2026-11-23",
    is_scheduled_today: true,
    minutes_today: 10,
  }));
  const child1Goals = Array.from({ length: 10 }, (_, i) => ({
    id: `77777777-7777-4777-8777-${String(i + 1).padStart(12, "0")}`,
    child_id: ids.child,
    metric: i % 2 === 0 ? "MINUTES" : "SESSIONS",
    target_value: 15 + i,
    period: i % 2 === 0 ? "DAILY" : "WEEKLY",
    starts_on: "2026-11-01",
    ends_on: null,
    timezone: "Asia/Ho_Chi_Minh",
    status: "ACTIVE",
    current_value: 5,
    progress_percent: 25,
    created_at: NOW,
    updated_at: NOW,
    phase: "RUNNING",
    streak_cycles: 2,
    cycle_starts_on: "2026-11-22",
    cycle_ends_on: "2026-11-22",
  }));
  const child1Collections = Array.from({ length: 12 }, (_, i) => ({
    id: `88888888-8888-4888-8888-${String(i + 1).padStart(12, "0")}`,
    child_id: ids.child,
    book_id: `99999999-9999-4999-8999-${String(i + 1).padStart(12, "0")}`,
    collection_type: i % 2 === 0 ? "FAVORITE" : "WANT_TO_READ",
    created_at: NOW,
    book: {
      id: `99999999-9999-4999-8999-${String(i + 1).padStart(12, "0")}`,
      title: `Sách đã lưu số ${i + 1}`,
      author: "Tác giả",
      min_grade: 1,
      max_grade: 3,
      lifecycle_status: "ACTIVE",
      available_to_read: true,
    },
  }));
  const child1Due = [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      reminder_id: child1Reminders[0].id,
      scheduled_local_date: "2026-11-22",
      scheduled_for: NOW,
      status: "PENDING",
      acknowledged_at: null,
      email_status: "NOT_REQUESTED",
      email_attempts: 0,
      email_sent_at: null,
      email_error_code: null,
      reminder: child1Reminders[0],
    },
  ];
  const mutated: Array<{ method: string; id: string }> = [];

  await page
    .context()
    .route("http://127.0.0.1:8000/profiles/children**", async (route) => {
      if (route.request().method() === "OPTIONS")
        return respond(route, null, 204);
      const url = new URL(route.request().url());
      if (url.pathname === "/profiles/children") {
        return respond(route, [child, child2]);
      }
      return route.fallback();
    });

  await page
    .context()
    .route("http://127.0.0.1:8000/reading-management/**", async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return respond(route, null, 204);
      const url = new URL(req.url());
      const method = req.method().toUpperCase();
      const reqChild = url.searchParams.get("child_id");

      if (url.pathname === "/reading-management/goals" && method === "GET") {
        return respond(route, reqChild === ids.child ? child1Goals : []);
      }
      if (url.pathname === "/reading-management/plans" && method === "GET") {
        return respond(route, reqChild === ids.child ? child1Plans : []);
      }
      if (
        url.pathname === "/reading-management/collections" &&
        method === "GET"
      ) {
        return respond(route, reqChild === ids.child ? child1Collections : []);
      }
      if (
        url.pathname === "/reading-management/reminders/due" &&
        method === "GET"
      ) {
        return respond(route, reqChild === ids.child ? child1Due : []);
      }
      if (
        url.pathname === "/reading-management/reminders" &&
        method === "GET"
      ) {
        return respond(route, reqChild === ids.child ? child1Reminders : []);
      }
      const remMatch = url.pathname.match(
        /^\/reading-management\/reminders\/([^/]+)$/,
      );
      if (remMatch && method === "PATCH") {
        const id = remMatch[1];
        const body = req.postDataJSON() as Record<string, unknown>;
        mutated.push({ method: "PATCH", id });
        child1Reminders = child1Reminders.map((r) =>
          r.id === id ? { ...r, ...body } : r,
        );
        return respond(
          route,
          child1Reminders.find((r) => r.id === id),
        );
      }
      if (remMatch && method === "DELETE") {
        const id = remMatch[1];
        mutated.push({ method: "DELETE", id });
        child1Reminders = child1Reminders.filter((r) => r.id !== id);
        return respond(route, { deleted: true });
      }
      return route.fallback();
    });

  return { mutated, child1Reminders };
}

test.describe("My Books pagination & layout verification", () => {
  test("handles 0, 1, 9, 10, and 100 books, opens 100th book and returns to page 12, and rolls back when deleting last item on last page", async ({
    page,
  }) => {
    const fixture = await setupMyBooksFixture(page, 0);

    // 0 books -> empty state, no pagination
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/my-books");
    await expect(page.getByText("Bạn chưa có sách riêng nào")).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: /Phân trang Sách của tôi/ }),
    ).toHaveCount(0);
    await assertNoHorizontalOverflow(page);

    // 1 book -> 1 card, no pagination
    fixture.setCount(1);
    await page.reload();
    await expect(page.locator("article[data-private-book-id]")).toHaveCount(1);
    await expect(
      page.getByRole("navigation", { name: /Phân trang Sách của tôi/ }),
    ).toHaveCount(0);

    // 9 books -> 9 cards, no pagination
    fixture.setCount(9);
    await page.reload();
    await expect(page.locator("article[data-private-book-id]")).toHaveCount(9);
    await expect(
      page.getByRole("navigation", { name: /Phân trang Sách của tôi/ }),
    ).toHaveCount(0);

    // 10 books -> page 1 has 9, page 2 has 1, delete last item rolls back to page 1
    fixture.setCount(10);
    await page.reload();
    await expect(page.locator("article[data-private-book-id]")).toHaveCount(9);
    await expect(
      page.getByRole("navigation", {
        name: "Phân trang Sách của tôi",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("navigation", {
        name: "Phân trang Sách của tôi",
        exact: true,
      })
      .getByRole("button", { name: /Tiếp/ })
      .click();
    await expect(page).toHaveURL(/\/my-books\?page=2$/);
    await expect(page.locator("article[data-private-book-id]")).toHaveCount(1);
    await expect(page.getByText("Sách Gia Đình #010")).toBeVisible();

    await page
      .getByRole("button", { name: "Xóa sách Sách Gia Đình #010" })
      .click();
    await page.getByRole("button", { name: "Xác nhận xóa" }).click();
    await expect(page).toHaveURL(/\/my-books$/);
    await expect(page.locator("article[data-private-book-id]")).toHaveCount(9);

    // 100 books -> page 12 has the 100th book; open detail & return to exact page 12
    fixture.setCount(100);
    await page.goto("/my-books?page=12");
    await expect(page.locator("article[data-private-book-id]")).toHaveCount(1);
    await expect(page.getByText("Sách Gia Đình #100")).toBeVisible();
    await page.getByRole("link", { name: /Quản lý & thêm trang/ }).click();
    await expect(page).toHaveURL(/\/my-books\/.+\?fromPage=12$/);
    await expect(
      page.getByRole("heading", { name: "Sách Gia Đình #100" }),
    ).toBeVisible();
    await page.getByRole("link", { name: /Quay lại Sách của tôi/ }).click();
    await expect(page).toHaveURL(/\/my-books\?page=12$/);
    await expect(page.getByText("Sách Gia Đình #100")).toBeVisible();

    // Responsive check across 390x844, 360x640, and 200% zoom (683x384 CSS px)
    for (const vp of [
      { width: 390, height: 844 },
      { width: 360, height: 640 },
      { width: 683, height: 384 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto("/my-books");
      await expect(page.locator("article[data-private-book-id]")).toHaveCount(
        9,
      );
      await assertNoHorizontalOverflow(page);
    }
  });
});

test.describe("Reading Management compact reminders, independent pagination & child switching", () => {
  test("renders compact 5/page reminders with inline buttons, independent list pagination, true KPI totals, and clean child switch across desktop & mobile", async ({
    page,
  }) => {
    const { mutated } = await setupReadingManagementFixture(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/reading-management");

    const overview = page.getByRole("region", {
      name: "Tổng quan thói quen đọc",
    });
    await expect(overview).toContainText("20");
    await expect(overview).toContainText("12");
    await expect(overview).toContainText("10");

    // Reminders: 5 per page, compact single-line height (<= 85px on desktop), inline action buttons
    const reminderCards = page.locator("article[data-reminder-id]");
    await expect(reminderCards).toHaveCount(5);
    const firstCardMetrics = await reminderCards.first().evaluate((card) => {
      const cardRect = card.getBoundingClientRect();
      const buttons = Array.from(card.querySelectorAll("button")).map((btn) => {
        const r = btn.getBoundingClientRect();
        return { width: r.width, top: r.top, height: r.height };
      });
      return {
        cardHeight: cardRect.height,
        cardWidth: cardRect.width,
        buttons,
      };
    });
    expect(firstCardMetrics.cardHeight).toBeLessThanOrEqual(85);
    expect(firstCardMetrics.buttons.length).toBe(2);
    expect(firstCardMetrics.buttons[0].width).toBeLessThan(
      firstCardMetrics.cardWidth * 0.5,
    );
    expect(firstCardMetrics.buttons[1].width).toBeLessThan(
      firstCardMetrics.cardWidth * 0.5,
    );
    expect(
      Math.abs(
        firstCardMetrics.buttons[0].top - firstCardMetrics.buttons[1].top,
      ),
    ).toBeLessThan(6);

    // True 2-column vertical masonry stack: Collections sits snugly below Plans (~24px gap)
    const masonryMetrics = await page.evaluate(() => {
      const plans = document
        .querySelector('section[aria-label="Kế hoạch đọc trong tuần"]')
        ?.getBoundingClientRect();
      const collections = document
        .querySelector(
          'section[aria-label="Sách yêu thích và danh sách muốn đọc"]',
        )
        ?.getBoundingClientRect();
      const goals = document
        .querySelector('section[aria-label="Mục tiêu đọc"]')
        ?.getBoundingClientRect();
      const reminders = document
        .querySelector('section[aria-label="Lịch nhắc đọc"]')
        ?.getBoundingClientRect();
      if (!plans || !collections || !goals || !reminders) return null;
      return {
        leftGap: Math.round(collections.top - plans.bottom),
        rightGap: Math.round(reminders.top - goals.bottom),
        sameLeftCol: Math.abs(plans.left - collections.left) < 2,
        sameRightCol: Math.abs(goals.left - reminders.left) < 2,
        twoCols: goals.left > plans.right,
      };
    });
    expect(masonryMetrics).not.toBeNull();
    expect(masonryMetrics!.twoCols).toBe(true);
    expect(masonryMetrics!.sameLeftCol).toBe(true);
    expect(masonryMetrics!.sameRightCol).toBe(true);
    expect(masonryMetrics!.leftGap).toBeGreaterThanOrEqual(16);
    expect(masonryMetrics!.leftGap).toBeLessThanOrEqual(32);
    expect(masonryMetrics!.rightGap).toBeGreaterThanOrEqual(16);
    expect(masonryMetrics!.rightGap).toBeLessThanOrEqual(32);

    // Plans (4/page), Goals (4/page), Collections (5/page) are independently bounded
    await expect(page.locator("article[data-plan-id]")).toHaveCount(4);
    await expect(page.locator("article[data-goal-id]")).toHaveCount(4);
    await expect(page.locator("li[data-collection-id]")).toHaveCount(5);

    // Paginate reminders to page 2 -> Plans remain on page 1, KPI still shows 20
    const plansSection = page.getByRole("region", {
      name: "Kế hoạch đọc trong tuần",
    });
    const remNav = page.getByRole("navigation", {
      name: "Phân trang lịch nhắc đọc",
    });
    await remNav.getByRole("button", { name: /Tiếp/ }).click();
    await expect(page.getByText("08:30")).toBeVisible();
    await expect(plansSection.getByText("Kế hoạch tuần #1")).toBeVisible();
    await expect(overview).toContainText("20");

    // Toggle exact reminder #6 on page 2
    const rem6 = page.locator(
      'article[data-reminder-id="55555555-5555-4555-8555-000000000006"]',
    );
    await rem6.getByRole("checkbox").click();
    await expect.poll(() => mutated.length).toBe(1);
    expect(mutated[0]).toEqual({
      method: "PATCH",
      id: "55555555-5555-4555-8555-000000000006",
    });

    // Switch child -> clears stale due reminders and resets all sections
    await expect(page.getByText(/Đến giờ đọc sách/)).toBeVisible();
    await page.getByLabel("Hồ sơ bé").selectOption(CHILD_2_ID);
    await expect(page.getByText("Chưa có lịch nhắc nào.")).toBeVisible();
    await expect(page.getByText(/Đến giờ đọc sách/)).toHaveCount(0);

    // Switch back to Child 1 and verify mobile 390x844, 360x640, and 200% zoom have zero horizontal overflow
    await page.getByLabel("Hồ sơ bé").selectOption(ids.child);
    await expect(page.locator("article[data-reminder-id]")).toHaveCount(5);
    for (const vp of [
      { width: 1366, height: 768 },
      { width: 390, height: 844 },
      { width: 360, height: 640 },
      { width: 683, height: 384 },
    ]) {
      await page.setViewportSize(vp);
      await assertNoHorizontalOverflow(page);
    }
  });
});
