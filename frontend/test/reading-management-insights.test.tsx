import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  GoalInsights,
  PlanInsights,
  TodaySummary,
  dayLabel,
  goalCycleLabel,
  isRunningGoal,
  isRunningPlan,
  shortDate,
} from "@/components/reading-management/reading-management-insights";
import { ReadingManagementScreen } from "@/components/reading-management/reading-management-screen";
import {
  conflictMessage,
  readingManagementMessages,
} from "@/lib/api/reading-management-messages";
import { ServiceError } from "@/lib/api/service-error";
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

const CHILD = "11111111-1111-4111-8111-111111111111";
const TS = "2026-11-09T05:00:00+00:00";

function goal(overrides: Partial<ReadingGoalDTO> = {}): ReadingGoalDTO {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    child_id: CHILD,
    metric: "MINUTES",
    target_value: 20,
    period: "DAILY",
    starts_on: "2026-11-01",
    ends_on: null,
    timezone: "Asia/Ho_Chi_Minh",
    status: "ACTIVE",
    current_value: 5,
    progress_percent: 25,
    created_at: TS,
    updated_at: TS,
    phase: "RUNNING",
    streak_cycles: 0,
    cycle_starts_on: "2026-11-09",
    cycle_ends_on: "2026-11-09",
    ...overrides,
  };
}

function plan(overrides: Partial<ReadingPlanDTO> = {}): ReadingPlanDTO {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    child_id: CHILD,
    book_id: null,
    book_title: null,
    title: "Đọc buổi tối",
    target_minutes: 20,
    weekdays: [0, 2, 4],
    starts_on: "2026-11-01",
    ends_on: null,
    timezone: "Asia/Ho_Chi_Minh",
    status: "ACTIVE",
    scheduled_days_this_week: 3,
    completed_days_this_week: 0,
    progress_percent: 0,
    completed_at: null,
    created_at: TS,
    updated_at: TS,
    phase: "RUNNING",
    next_scheduled_date: "2026-11-09",
    is_scheduled_today: true,
    minutes_today: 5,
    ...overrides,
  };
}

describe("date helpers", () => {
  it("formats calendar days without time-zone drift", () => {
    expect(shortDate("2026-11-09")).toBe("09/11");
    expect(dayLabel("2026-11-09")).toBe("Thứ hai, 09/11");
    expect(dayLabel("2026-11-15")).toBe("Chủ nhật, 15/11");
  });

  it("labels the goal cycle", () => {
    expect(goalCycleLabel(goal())).toBe("Ngày 09/11");
    expect(
      goalCycleLabel(
        goal({ cycle_starts_on: "2026-11-09", cycle_ends_on: "2026-11-15" }),
      ),
    ).toBe("09/11 – 15/11");
    expect(goalCycleLabel(goal({ cycle_starts_on: null }))).toBeNull();
  });

  it("only counts live items as running", () => {
    expect(isRunningGoal(goal())).toBe(true);
    expect(isRunningGoal(goal({ phase: "EXPIRED" }))).toBe(false);
    expect(isRunningGoal(goal({ phase: "UPCOMING" }))).toBe(false);
    expect(isRunningGoal(goal({ status: "PAUSED" }))).toBe(false);
    expect(isRunningGoal({ ...goal(), phase: undefined })).toBe(true);
    expect(isRunningPlan(plan())).toBe(true);
    expect(isRunningPlan(plan({ phase: "EXPIRED" }))).toBe(false);
    expect(isRunningPlan(plan({ status: "ENDED" }))).toBe(false);
  });
});

describe("GoalInsights", () => {
  it("shows the current cycle and the streak", () => {
    render(<GoalInsights goal={goal({ streak_cycles: 4 })} />);
    expect(
      screen.getByText(/Chu kỳ hiện tại: Ngày 09\/11/),
    ).toBeInTheDocument();
    expect(screen.getByText(/liên tiếp đạt mục tiêu/)).toHaveTextContent(
      "4 ngày liên tiếp đạt mục tiêu",
    );
  });

  it("counts weeks for weekly goals and hides a zero streak", () => {
    const { rerender } = render(
      <GoalInsights goal={goal({ period: "WEEKLY", streak_cycles: 2 })} />,
    );
    expect(screen.getByText(/tuần liên tiếp/)).toBeInTheDocument();
    rerender(<GoalInsights goal={goal({ streak_cycles: 0 })} />);
    expect(screen.queryByText(/liên tiếp/)).not.toBeInTheDocument();
  });

  it("explains an expired goal and how to close it", () => {
    render(
      <GoalInsights goal={goal({ phase: "EXPIRED", ends_on: "2026-11-05" })} />,
    );
    expect(screen.getByText(/Chu kỳ cuối/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(
      "Mục tiêu đã hết hạn từ 05/11",
    );
  });

  it("explains an upcoming goal", () => {
    render(
      <GoalInsights
        goal={goal({ phase: "UPCOMING", starts_on: "2026-11-20" })}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "chưa đến ngày bắt đầu (20/11)",
    );
  });

  it("stays quiet for finished goals", () => {
    const { container } = render(
      <GoalInsights
        goal={goal({
          status: "COMPLETED",
          phase: "FINISHED",
          streak_cycles: 3,
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("PlanInsights", () => {
  it("shows today's minutes against the target", () => {
    render(<PlanInsights plan={plan()} />);
    expect(screen.getByText(/Hôm nay bé cần đọc/)).toHaveTextContent(
      "5/20 phút",
    );
  });

  it("congratulates once today's target is reached", () => {
    render(<PlanInsights plan={plan({ minutes_today: 25 })} />);
    expect(screen.getByText(/Hôm nay bé đã đọc đủ/)).toHaveTextContent(
      "25/20 phút",
    );
  });

  it("points to the next reading day when today is free", () => {
    render(
      <PlanInsights
        plan={plan({
          is_scheduled_today: false,
          next_scheduled_date: "2026-11-11",
        })}
      />,
    );
    expect(screen.getByText(/Hôm nay không có lịch đọc/)).toHaveTextContent(
      "Thứ tư, 11/11",
    );
  });

  it("handles upcoming, expired, paused and finished plans", () => {
    const { rerender, container } = render(
      <PlanInsights
        plan={plan({
          phase: "UPCOMING",
          starts_on: "2026-11-20",
          next_scheduled_date: "2026-11-23",
        })}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "Buổi đọc đầu tiên: Thứ hai, 23/11",
    );
    rerender(
      <PlanInsights plan={plan({ phase: "EXPIRED", ends_on: "2026-11-06" })} />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "Kế hoạch đã hết hạn từ 06/11",
    );
    rerender(<PlanInsights plan={plan({ status: "PAUSED" })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <PlanInsights plan={plan({ status: "COMPLETED", phase: "FINISHED" })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("TodaySummary", () => {
  it("lists today's plans and daily goals with progress", () => {
    render(
      <TodaySummary
        childName="Bé An"
        plans={[plan({ minutes_today: 10 })]}
        goals={[
          goal({ streak_cycles: 2, current_value: 12, progress_percent: 60 }),
        ]}
      />,
    );
    const region = screen.getByRole("region", { name: "Hôm nay" });
    expect(
      within(region).getByText("Hôm nay Bé An cần đọc gì?"),
    ).toBeInTheDocument();
    expect(within(region).getByText(/10\/20 phút hôm nay/)).toBeInTheDocument();
    expect(
      within(region).getByRole("progressbar", {
        name: "Tiến độ hôm nay: Đọc buổi tối",
      }),
    ).toHaveAttribute("aria-valuenow", "50");
    expect(
      within(region).getByText(/12\/20 · 2 ngày liên tiếp/),
    ).toBeInTheDocument();
  });

  it("ignores weekly, expired and paused items", () => {
    render(
      <TodaySummary
        childName="Bé An"
        plans={[
          plan({
            status: "PAUSED",
            is_scheduled_today: false,
            next_scheduled_date: null,
          }),
        ]}
        goals={[goal({ period: "WEEKLY" }), goal({ phase: "EXPIRED" })]}
      />,
    );
    expect(
      screen.getByText(/Chưa có kế hoạch hoặc mục tiêu hằng ngày/),
    ).toBeInTheDocument();
  });

  it("names the next reading day when today is free", () => {
    render(
      <TodaySummary
        childName="Bé An"
        plans={[
          plan({
            is_scheduled_today: false,
            next_scheduled_date: "2026-11-11",
          }),
        ]}
        goals={[]}
      />,
    );
    expect(
      screen.getByText(/Buổi tiếp theo: Thứ tư, 11\/11 \(Đọc buổi tối\)/),
    ).toBeInTheDocument();
  });
});

describe("conflictMessage", () => {
  const conflict = (message: string, status = 409) =>
    new ServiceError({
      code: "CONTENT_INACTIVE",
      message,
      status,
      request_id: "",
      retryable: false,
    });

  it("returns the authored reason for known 409 conflicts only", () => {
    const [known] = Object.values(readingManagementMessages);
    expect(conflictMessage(conflict(known))).toBe(known);
    expect(conflictMessage(conflict(known, 500))).toBeNull();
    expect(conflictMessage(conflict("raw SQL error text"))).toBeNull();
    expect(conflictMessage(new Error(known))).toBeNull();
    expect(conflictMessage(null)).toBeNull();
  });
});

describe("ReadingManagementScreen with derived data", () => {
  const fetchMock = vi.fn();
  const child = {
    id: CHILD,
    parent_id: "99999999-9999-4999-8999-999999999999",
    alias: "Bé An",
    grade: 2,
    settings: {},
    created_at: "2026-10-01T00:00:00Z",
  };
  let goalRows: unknown[] = [];
  let planRows: unknown[] = [];

  beforeEach(() => {
    goalRows = [];
    planRows = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/profiles/children")
          return Response.json([child]);
        if (url.pathname === "/books/catalog") return Response.json([]);
        if (
          url.pathname === "/reading-management/goals" &&
          init?.method === "POST"
        ) {
          return Response.json(
            {
              detail:
                "An active goal with the same metric and period already overlaps these dates",
            },
            { status: 409 },
          );
        }
        if (url.pathname === "/reading-management/goals")
          return Response.json(goalRows);
        if (url.pathname === "/reading-management/plans")
          return Response.json(planRows);
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

  it("shows today's summary, streak and does not count an expired goal as running", async () => {
    const base = {
      child_id: CHILD,
      created_at: TS,
      updated_at: TS,
    };
    goalRows = [
      {
        ...base,
        id: "33333333-3333-4333-8333-333333333333",
        metric: "MINUTES",
        target_value: 20,
        period: "DAILY",
        starts_on: "2026-11-01",
        ends_on: null,
        timezone: "Asia/Ho_Chi_Minh",
        status: "ACTIVE",
        current_value: 5,
        progress_percent: 25,
        phase: "RUNNING",
        streak_cycles: 3,
        cycle_starts_on: "2026-11-09",
        cycle_ends_on: "2026-11-09",
      },
      {
        ...base,
        id: "33333333-3333-4333-8333-333333333334",
        metric: "SESSIONS",
        target_value: 1,
        period: "DAILY",
        starts_on: "2026-10-01",
        ends_on: "2026-10-31",
        timezone: "Asia/Ho_Chi_Minh",
        status: "ACTIVE",
        current_value: 1,
        progress_percent: 100,
        phase: "EXPIRED",
        streak_cycles: 0,
        cycle_starts_on: "2026-10-31",
        cycle_ends_on: "2026-10-31",
      },
    ];
    renderScreen();
    const summary = await screen.findByRole("region", { name: "Hôm nay" });
    expect(within(summary).getByText(/5\/20/)).toBeInTheDocument();
    const overview = screen.getByRole("region", {
      name: "Tổng quan thói quen đọc",
    });
    const running = within(overview)
      .getByText("Mục tiêu đang chạy")
      .closest("article");
    expect(running).toHaveTextContent("1");
    expect(screen.getByText(/ngày liên tiếp đạt mục tiêu/)).toHaveTextContent(
      "3 ngày liên tiếp đạt mục tiêu",
    );
    expect(
      screen.getByText(/Mục tiêu đã hết hạn từ 31\/10/),
    ).toBeInTheDocument();
  });

  it("shows the specific reason when a goal conflicts with an existing one", async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("heading", { name: "Mục tiêu đọc" });
    await user.click(screen.getByRole("button", { name: "Tạo mục tiêu" }));
    expect(
      await screen.findByText(/đã có mục tiêu cùng loại và cùng chu kỳ/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Không thực hiện được thao tác/),
    ).not.toBeInTheDocument();
  });
});
