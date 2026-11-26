import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { ReadingAutomationSettings } from "@/components/reading/reading-automation-settings";
import { TodaySummary } from "@/components/reading-management/reading-management-insights";
import { ReadingManagementScreen } from "@/components/reading-management/reading-management-screen";
import { VerifiedBookPicker } from "@/components/reading-management/verified-book-picker";
import type { BookListItemDTO } from "@/types/book";
import type {
  ReadingGoalDTO,
  ReadingPlanDTO,
} from "@/types/reading-management";

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

const sampleGoal: ReadingGoalDTO = {
  id: "22222222-2222-4222-8222-222222222222",
  child_id: childId,
  metric: "MINUTES",
  target_value: 20,
  period: "DAILY",
  starts_on: "2026-11-01",
  ends_on: null,
  timezone: "Asia/Ho_Chi_Minh",
  status: "ACTIVE",
  phase: "RUNNING",
  current_value: 10,
  progress_percent: 50,
  streak_cycles: 2,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const samplePlan: ReadingPlanDTO = {
  id: "33333333-3333-4333-8333-333333333333",
  child_id: childId,
  title: "Đọc buổi tối",
  book_id: null,
  book_title: "Dế Mèn Phiêu Lưu Ký",
  target_minutes: 15,
  weekdays: [0, 2, 4],
  starts_on: "2026-11-01",
  ends_on: null,
  timezone: "Asia/Ho_Chi_Minh",
  status: "ACTIVE",
  phase: "RUNNING",
  completed_days_this_week: 1,
  scheduled_days_this_week: 3,
  progress_percent: 33,
  completed_at: null,
  is_scheduled_today: true,
  minutes_today: 5,
  next_scheduled_date: "2026-11-02",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const sampleBooks: BookListItemDTO[] = Array.from({ length: 6 }, (_, idx) => ({
  id: `44444444-4444-4444-8444-00000000000${idx + 1}`,
  title: `Sách đọc thử ${idx + 1}`,
  author: "Tác giả",
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
  available_to_read: true,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/profiles/children") return Response.json([child]);
    if (url.pathname === "/books/catalog") return Response.json(sampleBooks);
    if (url.pathname === "/reading-management/goals")
      return Response.json([sampleGoal]);
    if (url.pathname === "/reading-management/plans")
      return Response.json([samplePlan]);
    if (url.pathname.startsWith("/reading-management/"))
      return Response.json([]);
    throw new Error("Unexpected API route: " + url.pathname);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("F10.4 reading-management mobile overhaul", () => {
  it("keeps md:hidden mobile tablist, switches tabs, preserves md: masonry, and enforces >= 44px Lưu/Hủy & min-[640px] forms", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AppServicesProvider>
        <ReadingManagementScreen />
      </AppServicesProvider>,
    );

    const tablist = await screen.findByRole("tablist", {
      name: "Mục quản lý đọc",
    });
    expect(tablist.className).toContain("md:hidden");
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    tabs.forEach((tab) => expect(tab.className).toContain("min-h-11"));

    const plansSection = screen.getByRole("region", {
      name: "Kế hoạch đọc trong tuần",
    });
    const goalsSection = screen.getByRole("region", { name: "Mục tiêu đọc" });
    expect(goalsSection.parentElement?.className).toContain("hidden");
    expect(goalsSection.parentElement?.className).toContain("md:flex");
    expect(plansSection.parentElement?.parentElement?.className).toContain(
      "lg:grid-cols-2",
    );

    // Switch to Mục tiêu tab -> plansSection & its column get hidden md:block / hidden md:flex, goalsSection visible
    await user.click(within(tablist).getByRole("tab", { name: /Mục tiêu/ }));
    expect(plansSection.className).toContain("hidden");
    expect(plansSection.className).toContain("md:block");
    expect(plansSection.parentElement?.className).toContain("hidden");
    expect(plansSection.parentElement?.className).toContain("md:flex");
    expect(goalsSection.className).not.toContain("hidden");

    // Inline goal edit Lưu / Hủy have min-h-11! and min-w-11
    await user.click(screen.getByRole("button", { name: "Sửa mục tiêu" }));
    const saveBtn = screen.getByRole("button", { name: "Lưu" });
    const cancelBtn = screen.getByRole("button", { name: "Hủy" });
    expect(saveBtn.className).toContain("min-h-11!");
    expect(saveBtn.className).toContain("min-w-11");
    expect(cancelBtn.className).toContain("min-h-11!");
    expect(cancelBtn.className).toContain("min-w-11");
    expect(container.innerHTML).not.toMatch(/\bsm:/);

    // Open plan form -> uses grid-cols-1 min-[640px]:grid-cols-2
    await user.click(screen.getByRole("button", { name: "Thêm kế hoạch" }));
    const formEl = container.querySelector("form");
    expect(formEl).not.toBeNull();
    expect(formEl!.className).toContain("grid-cols-1");
    expect(formEl!.className).toContain("min-[640px]:grid-cols-2");
    expect(formEl!.outerHTML).not.toMatch(/\bsm:/);
  });

  it("enforces >= 44px controls in VerifiedBookPicker, TodaySummary, and ReadingAutomationSettings", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <TodaySummary
          childName="Bé An"
          goals={[sampleGoal]}
          plans={[samplePlan]}
        />
        <VerifiedBookPicker
          books={sampleBooks}
          busy={false}
          childId={childId}
          collections={[]}
          onReload={vi.fn()}
          onToggle={vi.fn()}
        />
        <ReadingAutomationSettings />
      </>,
    );

    const todaySection = screen.getByRole("region", { name: "Hôm nay" });
    expect(todaySection.className).toContain("mt-2");
    expect(todaySection.className).toContain("md:mt-0");
    expect(todaySection.className).toContain("md:p-6");

    const pickerSummary = screen
      .getByText("Thêm từ thư viện sách đã xác minh")
      .closest("summary")!;
    expect(pickerSummary.className).toContain("min-h-12");
    await user.click(pickerSummary);

    const pickerPagination = screen.getByRole("navigation", {
      name: "Trang thư viện sách",
    });
    const nextPageBtn = within(pickerPagination).getByRole("button", {
      name: "Tiếp",
    });
    expect(nextPageBtn.className).toContain("min-h-11");

    const coachingGroup = screen.getByRole("group", {
      name: "Mức độ tương tác của thầy cô giáo",
    });
    expect(coachingGroup.className).toContain("ml-4");
    expect(coachingGroup.className).toContain("min-[640px]:ml-8");
    const gridDiv = coachingGroup.querySelector(".grid");
    expect(gridDiv?.className).toContain("min-[640px]:grid-cols-2");

    expect(container.innerHTML).not.toMatch(/\bsm:/);
  });
});
