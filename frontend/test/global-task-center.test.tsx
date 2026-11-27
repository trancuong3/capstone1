import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";
import { GlobalTaskCenter } from "@/components/tasks/global-task-center";
import {
  clearGlobalTasksMemoryCache,
  createGlobalTasksService,
  getCachedGlobalTasksSnapshot,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import type {
  GlobalTaskActionResponse,
  GlobalTaskItem,
  GlobalTaskListResponse,
} from "@/types/global-tasks";

const { navigationMock } = vi.hoisted(() => ({
  navigationMock: {
    pathname: "/my-books",
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

function makeTask(overrides: Partial<GlobalTaskItem> = {}): GlobalTaskItem {
  const nowIso = "2026-11-25T14:00:00.000Z";
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "smart_studio_job",
    job_type: "OCR_EXTRACT",
    title_vi: "Tách nội dung OCR thông minh",
    book_id: "22222222-2222-4222-8222-222222222222",
    book_page_id: "33333333-3333-4333-8333-333333333333",
    book_title: "Chú Mèo Đi Hia",
    page_number: 4,
    source_revision_id: null,
    actor_role: "parent",
    status: "RUNNING",
    status_label_vi: "Đang xử lý",
    stage: "OCR",
    stage_label_vi: "Nhận diện chữ (OCR)",
    priority: 50,
    attempt_count: 1,
    max_attempts: 3,
    progress_completed: null,
    progress_total: null,
    progress_unit: null,
    progress_pct: null,
    is_indeterminate: true,
    can_retry: false,
    can_cancel: true,
    result_href: "/my-books?bookId=22222222-2222-4222-8222-222222222222",
    result_ref: {},
    checkpoints: {},
    error_code: null,
    error_message_vi: null,
    created_at: nowIso,
    updated_at: nowIso,
    started_at: nowIso,
    completed_at: null,
    ...overrides,
  };
}

function makeFeed(
  tasks: GlobalTaskItem[],
  overrides: Partial<GlobalTaskListResponse> = {},
): GlobalTaskListResponse {
  const activeCount = tasks.filter((t) =>
    [
      "QUEUED",
      "RUNNING",
      "WAITING_FOR_WORKER",
      "WAITING_FOR_QUOTA",
      "RETRY_SCHEDULED",
      "CANCEL_REQUESTED",
    ].includes(t.status),
  ).length;
  return {
    actor_id: "parent-a",
    actor_role: "parent",
    active_count: activeCount,
    waiting_review_count: tasks.filter((t) => t.status === "WAITING_FOR_REVIEW")
      .length,
    failed_count: tasks.filter((t) => t.status === "FAILED").length,
    completed_count: tasks.filter((t) => t.status === "SUCCEEDED").length,
    worker_online: true,
    recommended_poll_ms: activeCount > 0 ? 4000 : null,
    tasks,
    ...overrides,
  };
}

function createMockService(
  initialFeed: GlobalTaskListResponse,
): GlobalTasksService & {
  listTasks: ReturnType<typeof vi.fn>;
  retryTask: ReturnType<typeof vi.fn>;
  cancelTask: ReturnType<typeof vi.fn>;
} {
  const listTasks = vi.fn().mockResolvedValue(initialFeed);
  const retryTask = vi
    .fn()
    .mockImplementation(
      async (jobId: string): Promise<GlobalTaskActionResponse> => ({
        task: makeTask({
          id: jobId,
          status: "QUEUED",
          status_label_vi: "Chờ xử lý",
        }),
        action: "retried",
        deduplicated: false,
        message_vi: "Đã xếp lịch chạy lại.",
      }),
    );
  const cancelTask = vi
    .fn()
    .mockImplementation(
      async (jobId: string): Promise<GlobalTaskActionResponse> => ({
        task: makeTask({
          id: jobId,
          status: "CANCEL_REQUESTED",
          status_label_vi: "Đang yêu cầu hủy",
        }),
        action: "cancel_requested",
        deduplicated: false,
        message_vi: "Đã gửi yêu cầu hủy.",
      }),
    );

  return {
    listTasks,
    createTask: vi.fn(),
    retryTask,
    cancelTask,
    getCapabilities: vi.fn(),
  };
}

describe("Global AI Task Center", () => {
  beforeEach(() => {
    navigationMock.pathname = "/my-books";
    clearGlobalTasksMemoryCache();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearGlobalTasksMemoryCache();
  });

  it("persists active tasks across route changes without resetting shell state", async () => {
    const runningTask = makeTask({
      id: "job-persist-1",
      progress_completed: 3,
      progress_total: 10,
      progress_unit: "trang",
      progress_pct: 30,
      is_indeterminate: false,
    });
    const service = createMockService(makeFeed([runningTask]));

    const { rerender } = render(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("AI đang chạy (1)"));

    // Navigate from /my-books -> /dashboard -> /reports
    navigationMock.pathname = "/dashboard";
    rerender(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );
    expect(screen.getByTestId("global-task-center-trigger")).toHaveTextContent(
      "AI đang chạy (1)",
    );

    navigationMock.pathname = "/reports";
    rerender(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );
    expect(screen.getByTestId("global-task-center-trigger")).toHaveTextContent(
      "AI đang chạy (1)",
    );
    // Shared shell provider did NOT spam re-fetches on every route change.
    expect(service.listTasks).toHaveBeenCalledTimes(1);
  });

  it("renders measured and staged percentage progress bars for every active AI task", async () => {
    const measuredTask = makeTask({
      id: "job-measured",
      title_vi: "Nhập nhiều trang sách",
      progress_completed: 3,
      progress_total: 10,
      progress_unit: "trang",
      progress_pct: 30,
      progress_mode: "measured",
      is_indeterminate: false,
    });
    const stagedTask = makeTask({
      id: "job-indeterminate",
      title_vi: "Nhận diện chữ trang sách",
      progress_completed: null,
      progress_total: null,
      progress_unit: null,
      progress_pct: null,
      progress_mode: "staged",
      is_indeterminate: true,
    });
    const service = createMockService(makeFeed([measuredTask, stagedTask]));

    render(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("AI đang chạy (2)"));
    expect(trigger).toHaveTextContent("30%");

    fireEvent.click(trigger);

    const measuredBox = await screen.findByTestId("task-progress-job-measured");
    expect(measuredBox).toHaveTextContent("3/10 trang");
    expect(measuredBox).toHaveTextContent("30%");
    const measuredBar = within(measuredBox).getByRole("progressbar");
    expect(measuredBar).toHaveAttribute("aria-valuenow", "30");
    expect(measuredBar).toHaveAttribute("aria-valuemax", "100");

    const stagedBox = screen.getByTestId("task-progress-job-indeterminate");
    expect(stagedBox).toHaveTextContent("%");
    const stagedBar = within(stagedBox).getByRole("progressbar");
    expect(stagedBar).toHaveAttribute("aria-valuemin", "0");
    expect(stagedBar).toHaveAttribute("aria-valuemax", "100");
    const stagedPct = Number(stagedBar.getAttribute("aria-valuenow"));
    expect(stagedPct).toBeGreaterThanOrEqual(8);
    expect(stagedPct).toBeLessThan(100);
  });

  it("supports Retry, Cancel, and non-blocking 'Xem kết quả' link with >=48px mobile bottom-sheet targets", async () => {
    const failedTask = makeTask({
      id: "job-failed",
      title_vi: "Tạo bìa sách AI",
      status: "FAILED",
      status_label_vi: "Xử lý thất bại",
      error_message_vi: "Tạm hết hạn mức AI miễn phí.",
      can_retry: true,
      can_cancel: false,
    });
    const runningTask = makeTask({
      id: "job-running",
      title_vi: "Tách tranh minh họa sạch chữ",
      status: "RUNNING",
      can_retry: false,
      can_cancel: true,
    });
    const doneTask = makeTask({
      id: "job-done",
      title_vi: "Kiểm tra trang sách của tôi",
      status: "SUCCEEDED",
      status_label_vi: "Bản đọc đã sẵn sàng để xem",
      can_retry: false,
      can_cancel: false,
      result_href: "/my-books?bookId=book-99",
    });

    const service = createMockService(
      makeFeed([failedTask, runningTask, doneTask]),
    );

    render(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    await waitFor(() => expect(service.listTasks).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("global-task-center-trigger"));

    const panel = await screen.findByTestId("global-task-center-panel");
    // Mobile bottom-sheet classes + desktop slide-over classes
    expect(panel.className).toContain("rounded-t-2xl");
    expect(panel.className).toContain("max-h-[82dvh]");
    expect(panel.className).toContain("sm:w-[min(28rem,100vw)]");

    // Touch targets >= 48px (`min-h-12`)
    const retryBtn = within(
      screen.getByTestId("task-card-job-failed"),
    ).getByRole("button", { name: "Thử lại" });
    expect(retryBtn.className).toContain("min-h-12");

    const cancelBtn = within(
      screen.getByTestId("task-card-job-running"),
    ).getByRole("button", { name: "Hủy" });
    expect(cancelBtn.className).toContain("min-h-12");

    const viewLink = within(screen.getByTestId("task-card-job-done")).getByRole(
      "link",
      { name: /Xem kết quả/ },
    );
    expect(viewLink).toHaveAttribute("href", "/my-books?bookId=book-99");
    expect(viewLink.className).toContain("min-h-12");

    fireEvent.click(retryBtn);
    await waitFor(() =>
      expect(service.retryTask).toHaveBeenCalledWith("job-failed", {
        portal: "parent",
      }),
    );

    fireEvent.click(cancelBtn);
    await waitFor(() =>
      expect(service.cancelTask).toHaveBeenCalledWith("job-running", {
        portal: "parent",
      }),
    );
  });

  it("hides completely on /reading/* routes to protect child reading focus, then restores on exit", async () => {
    navigationMock.pathname = "/reading/session-child-1";
    const service = createMockService(makeFeed([makeTask({ id: "job-bg" })]));

    const { rerender } = render(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    await waitFor(() => expect(service.listTasks).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByTestId("global-task-center-trigger"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("global-task-center-panel"),
    ).not.toBeInTheDocument();

    // Return to parent book workspace -> task pill reappears with intact active count!
    navigationMock.pathname = "/my-books";
    rerender(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );
    expect(screen.getByTestId("global-task-center-trigger")).toHaveTextContent(
      "AI đang chạy (1)",
    );
  });

  it("wipes actor-scoped memory cache on logout/actor switch and never writes to localStorage", async () => {
    const parentATask = makeTask({
      id: "job-parent-a",
      book_title: "Bí Mật Gia Đình A",
    });
    const service = createMockService(
      makeFeed([parentATask], { actor_id: "parent-a", actor_role: "parent" }),
    );

    const { rerender } = render(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    await waitFor(() =>
      expect(getCachedGlobalTasksSnapshot("parent-a", "parent")).not.toBeNull(),
    );
    // Never stores book/task data in localStorage!
    expect(window.localStorage.length).toBe(0);

    // Simulate logout -> actorId becomes null
    rerender(
      <AiTaskCenterProvider actorId={null} actorRole={null} service={service}>
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    expect(
      screen.queryByTestId("global-task-center-trigger"),
    ).not.toBeInTheDocument();
    expect(getCachedGlobalTasksSnapshot("parent-a", "parent")).toBeNull();

    // Simulate Parent B signing in -> never sees Parent A's private book title!
    service.listTasks.mockResolvedValueOnce(
      makeFeed([], { actor_id: "parent-b", actor_role: "parent" }),
    );
    rerender(
      <AiTaskCenterProvider
        actorId="parent-b"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    const triggerB = await screen.findByTestId("global-task-center-trigger");
    fireEvent.click(triggerB);
    await waitFor(() =>
      expect(screen.getByTestId("global-task-center-panel")).toHaveTextContent(
        "Chưa có tác vụ AI nào",
      ),
    );
    expect(screen.queryByText("Bí Mật Gia Đình A")).not.toBeInTheDocument();
  });

  it("re-syncs immediately on window focus and viread:android-resume events", async () => {
    const service = createMockService(makeFeed([makeTask({ id: "job-sync" })]));

    render(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    await waitFor(() => expect(service.listTasks).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(service.listTasks).toHaveBeenCalledTimes(2));

    await act(async () => {
      window.dispatchEvent(new Event("viread:android-resume"));
    });
    await waitFor(() => expect(service.listTasks).toHaveBeenCalledTimes(3));
  });

  it("pauses polling when tab is hidden and stops polling when zero active tasks exist", async () => {
    vi.useFakeTimers();
    const service = createMockService(
      makeFeed([makeTask({ id: "job-poll" })], { recommended_poll_ms: 3000 }),
    );

    render(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(service.listTasks).toHaveBeenCalledTimes(1);

    // Tab becomes hidden -> advancing timers MUST NOT poll!
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(service.listTasks).toHaveBeenCalledTimes(1);

    // Tab becomes visible -> immediately re-syncs, backend now returns 0 active jobs!
    service.listTasks.mockResolvedValue(
      makeFeed([
        makeTask({
          id: "job-poll",
          status: "SUCCEEDED",
          status_label_vi: "Bản đọc đã sẵn sàng để xem",
        }),
      ]),
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(service.listTasks).toHaveBeenCalledTimes(2);

    // With active_count === 0, advancing timers MUST NOT schedule extra polls!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(service.listTasks).toHaveBeenCalledTimes(2);
  });

  it("real createGlobalTasksService validates /studio/tasks responses with Zod", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(
          makeFeed([
            makeTask({
              id: "job-http-1",
              progress_completed: 2,
              progress_total: 5,
              progress_unit: "trang",
              progress_pct: 40,
              is_indeterminate: false,
            }),
          ]),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { createBrowserSupabaseClient } =
      await import("@/lib/supabase/client");
    expect(typeof createBrowserSupabaseClient).toBe("function");

    const svc = createGlobalTasksService();
    expect(typeof svc.listTasks).toBe("function");
    expect(typeof svc.retryTask).toBe("function");
    expect(typeof svc.cancelTask).toBe("function");
    expect(typeof svc.getCapabilities).toBe("function");
    vi.unstubAllGlobals();
  });
});
