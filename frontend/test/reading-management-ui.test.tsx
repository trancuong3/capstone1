import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReadingManagementScreen } from "@/components/reading-management/reading-management-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const childId = "11111111-1111-4111-8111-111111111111";
const child = {
  id: childId,
  parent_id: "99999999-9999-4999-8999-999999999999",
  alias: "Bé An",
  grade: 2,
  settings: {},
  created_at: "2026-10-01T00:00:00Z",
};
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/profiles/children") return Response.json([child]);
      if (url.pathname === "/books/catalog") return Response.json([]);
      if (
        url.pathname === "/reading-management/goals" &&
        init?.method === "POST"
      )
        return Response.json({ detail: "write failed" }, { status: 500 });
      if (url.pathname.startsWith("/reading-management/"))
        return Response.json([]);
      throw new Error("Unexpected API route: " + url.pathname);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderScreen() {
  return render(
    <AppServicesProvider>
      <ReadingManagementScreen />
    </AppServicesProvider>,
  );
}

describe("ReadingManagementScreen backed by HTTP API adapter", () => {
  it("loads goal, collection, and reminder data for the selected child and shows empty states", async () => {
    renderScreen();
    expect(
      await screen.findByRole("heading", { name: "Quản lý đọc sách" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Mục tiêu đọc" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Kế hoạch đọc trong tuần" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Bé chưa có mục tiêu đọc nào."),
    ).toBeInTheDocument();
    expect(screen.getByText("Chưa có lịch nhắc nào.")).toBeInTheDocument();
    await waitFor(() => {
      const requests = fetchMock.mock.calls.map(
        ([url]) => new URL(String(url)).pathname,
      );
      expect(requests).toContain("/reading-management/goals");
      expect(requests).toContain("/reading-management/plans");
      expect(requests).toContain("/reading-management/collections");
      expect(requests).toContain("/reading-management/reminders");
    });
  });

  it("does not show success when the backend rejects goal creation", async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("heading", { name: "Mục tiêu đọc" });
    await user.click(screen.getByRole("button", { name: "Thêm mục tiêu" }));
    await user.click(screen.getByRole("button", { name: "Tạo mục tiêu" }));
    expect(
      await screen.findByText(/Không thực hiện được thao tác/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Đã lưu mục tiêu đọc.")).not.toBeInTheDocument();
  });

  it("paginates 20 reminders at 5/page independently from plans/goals/collections, keeps true KPI totals, targets exact item on page 2, and resets state on child switch", async () => {
    const child2Id = "22222222-2222-4222-8222-222222222222";
    const child2 = {
      ...child,
      id: child2Id,
      alias: "Bé Bình",
      grade: 3,
    };
    const ts = "2026-11-20T08:00:00Z";
    let child1Reminders = Array.from({ length: 20 }, (_, i) => ({
      id: `55555555-5555-4555-8555-${String(i + 1).padStart(12, "0")}`,
      child_id: childId,
      remind_at: `${String(6 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 === 0 ? "00" : "30"}:00`,
      weekdays: [0, 2, 4],
      timezone: "Asia/Ho_Chi_Minh",
      is_active: true,
      email_enabled: i % 2 === 0,
      deleted_at: null,
      created_at: ts,
      updated_at: ts,
    }));
    const child1Plans = Array.from({ length: 6 }, (_, i) => ({
      id: `66666666-6666-4666-8666-${String(i + 1).padStart(12, "0")}`,
      child_id: childId,
      book_id: null,
      book_title: null,
      title: `Kế hoạch số ${i + 1}`,
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
      created_at: ts,
      updated_at: ts,
      phase: "RUNNING",
      next_scheduled_date: "2026-11-21",
      is_scheduled_today: true,
      minutes_today: 10,
    }));
    const child1Collections = Array.from({ length: 7 }, (_, i) => ({
      id: `77777777-7777-4777-8777-${String(i + 1).padStart(12, "0")}`,
      child_id: childId,
      book_id: `88888888-8888-4888-8888-${String(i + 1).padStart(12, "0")}`,
      collection_type: i < 4 ? "FAVORITE" : "WANT_TO_READ",
      created_at: ts,
      book: {
        id: `88888888-8888-4888-8888-${String(i + 1).padStart(12, "0")}`,
        title: `Cuốn sách đã lưu ${i + 1}`,
        author: "Tác giả",
        min_grade: 1,
        max_grade: 3,
        lifecycle_status: "ACTIVE",
        available_to_read: true,
      },
    }));
    const child1Due = [
      {
        id: "99999999-9999-4999-8999-000000000001",
        reminder_id: child1Reminders[0].id,
        scheduled_local_date: "2026-11-20",
        scheduled_for: ts,
        status: "PENDING",
        acknowledged_at: null,
        email_status: "NOT_REQUESTED",
        email_attempts: 0,
        email_sent_at: null,
        email_error_code: null,
        reminder: child1Reminders[0],
      },
    ];
    const toggledIds: string[] = [];

    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const reqChildId = url.searchParams.get("child_id");
        if (url.pathname === "/profiles/children") {
          return Response.json([child, child2]);
        }
        if (url.pathname === "/books/catalog") return Response.json([]);
        if (url.pathname === "/reading-management/goals") {
          return Response.json([]);
        }
        if (url.pathname === "/reading-management/plans") {
          return Response.json(reqChildId === childId ? child1Plans : []);
        }
        if (url.pathname === "/reading-management/collections") {
          return Response.json(reqChildId === childId ? child1Collections : []);
        }
        if (url.pathname === "/reading-management/reminders/due") {
          return Response.json(reqChildId === childId ? child1Due : []);
        }
        if (
          url.pathname === "/reading-management/reminders" &&
          method === "GET"
        ) {
          return Response.json(reqChildId === childId ? child1Reminders : []);
        }
        if (
          url.pathname.startsWith("/reading-management/reminders/") &&
          method === "PATCH"
        ) {
          const id = url.pathname.split("/").pop()!;
          toggledIds.push(id);
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            is_active?: boolean;
          };
          child1Reminders = child1Reminders.map((r) =>
            r.id === id
              ? { ...r, is_active: body.is_active ?? r.is_active }
              : r,
          );
          return Response.json(child1Reminders.find((r) => r.id === id));
        }
        throw new Error("Unexpected API route: " + method + " " + url.pathname);
      },
    );

    const user = userEvent.setup();
    renderScreen();

    // True KPI totals reflect all 20 reminders, 6 plans, 7 collections even though lists are paginated!
    const overview = await screen.findByRole("region", {
      name: "Tổng quan thói quen đọc",
    });
    expect(
      within(overview).getByText("Lịch nhắc đã bật").closest("article"),
    ).toHaveTextContent("20");
    expect(
      within(overview).getByText("Kế hoạch trong tuần").closest("article"),
    ).toHaveTextContent("6");
    expect(
      within(overview).getByText("Sách đã lưu").closest("article"),
    ).toHaveTextContent("7");

    // Reminders show only 5 items on page 1 (06:00..08:00), NOT 08:30 (item #6)
    const reminderSection = screen.getByRole("region", {
      name: "Lịch nhắc đọc",
    });
    expect(
      reminderSection.querySelectorAll("article[data-reminder-id]"),
    ).toHaveLength(5);
    expect(within(reminderSection).getByText("06:00")).toBeInTheDocument();
    expect(
      within(reminderSection).queryByText("08:30"),
    ).not.toBeInTheDocument();

    // Navigate reminders to page 2 -> Plans remain on page 1 (independent state!)
    const plansSection = screen.getByRole("region", {
      name: "Kế hoạch đọc trong tuần",
    });
    const remindersNav = screen.getByRole("navigation", {
      name: "Phân trang lịch nhắc đọc",
    });
    await user.click(
      within(remindersNav).getByRole("button", { name: /Tiếp/ }),
    );
    expect(
      await within(reminderSection).findByText("08:30"),
    ).toBeInTheDocument();
    expect(within(plansSection).getByText("Kế hoạch số 1")).toBeInTheDocument();
    expect(
      within(plansSection).queryByText("Kế hoạch số 5"),
    ).not.toBeInTheDocument();

    // Toggle exact reminder #6 (08:30) on page 2
    const reminder6Card = reminderSection.querySelector(
      `article[data-reminder-id="${child1Reminders[5].id}"]`,
    ) as HTMLElement;
    expect(reminder6Card).not.toBeNull();
    await user.click(within(reminder6Card).getByRole("checkbox"));
    await waitFor(() => {
      expect(toggledIds).toEqual([child1Reminders[5].id]);
    });

    // Switch to child 2 -> stale due reminder & child 1 data disappear immediately
    expect(screen.getByText(/Đến giờ đọc sách/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Hồ sơ bé"), child2Id);
    expect(
      await screen.findByText("Chưa có lịch nhắc nào."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Đến giờ đọc sách/)).not.toBeInTheDocument();
    expect(screen.queryByText("Kế hoạch số 1")).not.toBeInTheDocument();
  });

  it("renders a 2-column vertical masonry stack and compact single-line reminder metadata", async () => {
    const ts = "2026-11-20T08:00:00Z";
    const dailyReminder = {
      id: "55555555-5555-4555-8555-000000000099",
      child_id: childId,
      remind_at: "19:30:00",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      timezone: "Asia/Ho_Chi_Minh",
      is_active: true,
      email_enabled: true,
      deleted_at: null,
      created_at: ts,
      updated_at: ts,
    };
    const appReminder = {
      ...dailyReminder,
      id: "55555555-5555-4555-8555-000000000100",
      remind_at: "20:00:00",
      weekdays: [0, 2, 4],
      email_enabled: false,
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/profiles/children") return Response.json([child]);
      if (url.pathname === "/books/catalog") return Response.json([]);
      if (url.pathname === "/reading-management/reminders") {
        return Response.json([dailyReminder, appReminder]);
      }
      if (url.pathname.startsWith("/reading-management/")) {
        return Response.json([]);
      }
      throw new Error("Unexpected API route: " + url.pathname);
    });

    renderScreen();

    const plansSection = await screen.findByRole("region", {
      name: "Kế hoạch đọc trong tuần",
    });
    const collectionsSection = screen.getByRole("region", {
      name: "Sách yêu thích và danh sách muốn đọc",
    });
    const goalsSection = screen.getByRole("region", {
      name: "Mục tiêu đọc",
    });
    const remindersSection = screen.getByRole("region", {
      name: "Lịch nhắc đọc",
    });

    // Exact accessible heading names preserved with sibling count badges outside h2
    expect(
      screen.getByRole("heading", { name: "Kế hoạch đọc trong tuần" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Mục tiêu đọc" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Sách yêu thích và danh sách muốn đọc",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Lịch nhắc đọc" }),
    ).toBeInTheDocument();

    // True 2-column vertical masonry stack: Plans+Collections share left column, Goals+Reminders share right column
    expect(plansSection.parentElement).toBe(collectionsSection.parentElement);
    expect(goalsSection.parentElement).toBe(remindersSection.parentElement);
    expect(plansSection.parentElement).not.toBe(goalsSection.parentElement);

    // Compact reminder rows show concise channel pill & weekday summary with full tooltip
    const dailyRow = remindersSection.querySelector(
      `article[data-reminder-id="${dailyReminder.id}"]`,
    ) as HTMLElement;
    expect(within(dailyRow).getByText("19:30")).toBeInTheDocument();
    expect(within(dailyRow).getByText("Email")).toBeInTheDocument();
    const dailySchedule = within(dailyRow).getByText("Hằng ngày");
    expect(dailySchedule).toHaveAttribute(
      "title",
      "T2, T3, T4, T5, T6, T7, CN · Asia/Ho_Chi_Minh",
    );

    const appRow = remindersSection.querySelector(
      `article[data-reminder-id="${appReminder.id}"]`,
    ) as HTMLElement;
    expect(within(appRow).getByText("20:00")).toBeInTheDocument();
    expect(within(appRow).getByText("Ứng dụng")).toBeInTheDocument();
    expect(within(appRow).getByText("T2, T4, T6")).toHaveAttribute(
      "title",
      "T2, T4, T6 · Asia/Ho_Chi_Minh",
    );
  });

  it("paginates goals, due reminders, collections with filter reset, and VerifiedBookPicker with search reset", async () => {
    const ts = "2026-11-20T08:00:00Z";
    const goalsList = Array.from({ length: 9 }, (_, i) => ({
      id: `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`,
      child_id: childId,
      metric: "MINUTES",
      target_value: 15 + i * 5,
      period: "DAILY",
      starts_on: "2026-11-01",
      ends_on: null,
      timezone: "Asia/Ho_Chi_Minh",
      status: "ACTIVE",
      current_value: 5,
      progress_percent: 25,
      created_at: ts,
      updated_at: ts,
      phase: "RUNNING",
      streak_cycles: 0,
      cycle_starts_on: "2026-11-20",
      cycle_ends_on: "2026-11-20",
    }));
    const dueList = Array.from({ length: 8 }, (_, i) => ({
      id: `99999999-9999-4999-8999-${String(i + 1).padStart(12, "0")}`,
      reminder_id: `55555555-5555-4555-8555-${String(i + 1).padStart(12, "0")}`,
      scheduled_local_date: `2026-11-${String(10 + i).padStart(2, "0")}`,
      scheduled_for: ts,
      status: "PENDING",
      acknowledged_at: null,
      email_status: "NOT_REQUESTED",
      email_attempts: 0,
      email_sent_at: null,
      email_error_code: null,
      reminder: {
        id: `55555555-5555-4555-8555-${String(i + 1).padStart(12, "0")}`,
        child_id: childId,
        remind_at: `${String(10 + i).padStart(2, "0")}:00:00`,
        weekdays: [0, 2, 4],
        timezone: "Asia/Ho_Chi_Minh",
        is_active: true,
        email_enabled: false,
        deleted_at: null,
        created_at: ts,
        updated_at: ts,
      },
    }));
    const collectionsList = Array.from({ length: 8 }, (_, i) => ({
      id: `77777777-7777-4777-8777-${String(i + 1).padStart(12, "0")}`,
      child_id: childId,
      book_id: `88888888-8888-4888-8888-${String(i + 1).padStart(12, "0")}`,
      collection_type: i < 2 ? "FAVORITE" : "WANT_TO_READ",
      created_at: ts,
      book: {
        id: `88888888-8888-4888-8888-${String(i + 1).padStart(12, "0")}`,
        title: `Sách bộ sưu tập ${i + 1}`,
        author: "Tác giả",
        min_grade: 1,
        max_grade: 3,
        lifecycle_status: "ACTIVE",
        available_to_read: true,
      },
    }));
    const catalogBooks = Array.from({ length: 12 }, (_, i) => ({
      id: `12121212-1212-4121-8121-${String(i + 1).padStart(12, "0")}`,
      title: i === 11 ? "Truyện Đặc Biệt Cuối" : `Sách thư viện số ${i + 1}`,
      author: "Tác giả mẫu",
      min_grade: 1,
      max_grade: 3,
      page_count: 10,
      cover_url: null,
      lifecycle_status: "ACTIVE",
      is_private: false,
      created_at: ts,
    }));

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/profiles/children") return Response.json([child]);
      if (url.pathname === "/books/catalog") return Response.json(catalogBooks);
      if (url.pathname === "/reading-management/goals")
        return Response.json(goalsList);
      if (url.pathname === "/reading-management/plans")
        return Response.json([]);
      if (url.pathname === "/reading-management/collections")
        return Response.json(collectionsList);
      if (url.pathname === "/reading-management/reminders")
        return Response.json([]);
      if (url.pathname === "/reading-management/reminders/due")
        return Response.json(dueList);
      throw new Error("Unexpected API route: " + url.pathname);
    });

    const user = userEvent.setup();
    renderScreen();

    // Goals paginated at 4/page
    const goalsSection = await screen.findByRole("region", {
      name: "Mục tiêu đọc",
    });
    expect(goalsSection.querySelectorAll("article[data-goal-id]")).toHaveLength(
      4,
    );
    const goalsNav = within(goalsSection).getByRole("navigation", {
      name: "Phân trang mục tiêu đọc",
    });
    expect(goalsNav).toHaveTextContent("Trang 1 / 3");
    await user.click(within(goalsNav).getByRole("button", { name: /Tiếp/ }));
    expect(goalsNav).toHaveTextContent("Trang 2 / 3");
    expect(goalsSection.querySelectorAll("article[data-goal-id]")).toHaveLength(
      4,
    );

    // Due reminders paginated at 5/page
    const remindersSection = screen.getByRole("region", {
      name: "Lịch nhắc đọc",
    });
    expect(remindersSection.querySelectorAll("li[data-due-id]")).toHaveLength(
      5,
    );
    const dueNav = within(remindersSection).getByRole("navigation", {
      name: "Phân trang lời nhắc đến giờ",
    });
    await user.click(within(dueNav).getByRole("button", { name: /Tiếp/ }));
    expect(remindersSection.querySelectorAll("li[data-due-id]")).toHaveLength(
      3,
    );

    // Collections paginated at 5/page and reset page on filter click
    const collectionsSection = screen.getByRole("region", {
      name: "Sách yêu thích và danh sách muốn đọc",
    });
    const collectionsNav = within(collectionsSection).getByRole("navigation", {
      name: "Phân trang sách đã lưu",
    });
    await user.click(
      within(collectionsNav).getByRole("button", { name: /Tiếp/ }),
    );
    expect(
      within(collectionsSection).getByText("Sách bộ sưu tập 6"),
    ).toBeInTheDocument();
    const filterGroup = within(collectionsSection).getByRole("group", {
      name: "Lọc sách đã lưu",
    });
    await user.click(
      within(filterGroup).getByRole("button", { name: /Yêu thích/ }),
    );
    expect(
      within(collectionsSection).getByText("Sách bộ sưu tập 1"),
    ).toBeInTheDocument();
    expect(
      within(collectionsSection).queryByText("Sách bộ sưu tập 6"),
    ).not.toBeInTheDocument();

    // VerifiedBookPicker paginated at 5/page with search resetting page to 1
    await user.click(
      within(collectionsSection).getByText(
        /Thêm từ thư viện sách đã xác minh/i,
      ),
    );
    expect(
      within(collectionsSection).getByText("Sách thư viện số 1"),
    ).toBeInTheDocument();
    expect(
      within(collectionsSection).queryByText("Sách thư viện số 6"),
    ).not.toBeInTheDocument();

    const pickerNav = within(collectionsSection).getByRole("navigation", {
      name: "Trang thư viện sách",
    });
    expect(pickerNav).toHaveTextContent("Trang 1 / 3");
    await user.click(within(pickerNav).getByRole("button", { name: /Tiếp/ }));
    expect(pickerNav).toHaveTextContent("Trang 2 / 3");
    expect(
      within(collectionsSection).getByText("Sách thư viện số 6"),
    ).toBeInTheDocument();

    const searchInput = within(collectionsSection).getByRole("searchbox");
    await user.type(searchInput, "Đặc Biệt");
    expect(
      within(collectionsSection).getByText("Truyện Đặc Biệt Cuối"),
    ).toBeInTheDocument();
    expect(
      within(collectionsSection).queryByRole("navigation", {
        name: "Trang thư viện sách",
      }),
    ).not.toBeInTheDocument();
  });
});
