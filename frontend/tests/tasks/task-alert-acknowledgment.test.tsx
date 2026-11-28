import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/components/i18n/i18n-provider";
import { ParentAccountDropdown } from "@/components/layout/parent-account-dropdown";
import {
  AiTaskCenterProvider,
  useAiTaskCenter,
} from "@/components/tasks/ai-task-center-provider";
import { GlobalTaskCenter } from "@/components/tasks/global-task-center";
import { StudioTasksPageScreen } from "@/components/tasks/studio-tasks-page-screen";
import {
  clearGlobalTasksMemoryCache,
  emitStudioTasksChanged,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import { resetApiReadCacheForActorSwitch } from "@/lib/api/read-cache";
import {
  acknowledgeTaskAlerts,
  buildLegacyParentLastSeenKey,
  buildTaskAlertAckStorageKey,
  getTaskAlertAckState,
  isTaskAlertAcknowledged,
  resetTaskAlertAckMemoryCache,
} from "@/lib/tasks/task-alert-acknowledgment";
import type {
  GlobalTaskActionResponse,
  GlobalTaskItem,
  GlobalTaskListResponse,
} from "@/types/global-tasks";

const { navigationMock } = vi.hoisted(() => ({
  navigationMock: {
    pathname: "/admin/books",
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
  const nowIso = "2026-11-28T10:00:00.000Z";
  return {
    id: "task-1",
    source: "smart_studio_job",
    job_type: "OCR_EXTRACT",
    title_vi: "Tách nội dung OCR thông minh",
    book_id: "book-1",
    book_page_id: "page-1",
    book_title: "Chú Mèo Đi Hia",
    page_number: 2,
    source_revision_id: null,
    actor_id: "admin-1",
    actor_role: "admin",
    portal: "admin",
    status: "FAILED",
    status_label_vi: "Xử lý thất bại",
    stage: "FAILED",
    stage_label_vi: "Gặp lỗi",
    priority: 50,
    attempt_count: 1,
    max_attempts: 3,
    progress_completed: null,
    progress_total: null,
    progress_unit: null,
    progress_pct: 0,
    is_indeterminate: false,
    can_retry: true,
    can_cancel: false,
    result_href: "/admin/books/book-1",
    result_ref: {},
    checkpoints: {},
    error_code: "OCR_FAILED",
    error_message_vi: "Không thể nhận diện chữ trên trang này.",
    created_at: nowIso,
    updated_at: nowIso,
    started_at: nowIso,
    completed_at: nowIso,
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
    actor_id: "admin-1",
    actor_role: "admin",
    portal: "admin",
    active_count: activeCount,
    waiting_review_count: tasks.filter((t) => t.status === "WAITING_FOR_REVIEW")
      .length,
    failed_count: tasks.filter(
      (t) => t.status === "FAILED" || t.status === "PARTIAL_SUCCESS",
    ).length,
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

describe("AI Task Center alert acknowledgment after reading & interacting", () => {
  beforeEach(() => {
    navigationMock.pathname = "/admin/books";
    clearGlobalTasksMemoryCache();
    resetTaskAlertAckMemoryCache();
    window.localStorage.clear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearGlobalTasksMemoryCache();
    resetTaskAlertAckMemoryCache();
  });

  it("clears FAILED and WAITING_FOR_REVIEW warnings on GlobalTaskCenter once user opens/reads drawer and persists across reload", async () => {
    const failedTask = makeTask({
      id: "job-failed-1",
      status: "FAILED",
      updated_at: "2026-11-28T10:00:00.000Z",
    });
    const reviewTask = makeTask({
      id: "job-review-1",
      status: "WAITING_FOR_REVIEW",
      status_label_vi: "Cần xác minh",
      stage_label_vi: "Chờ người dùng xác minh",
      error_message_vi: null,
      can_retry: false,
      updated_at: "2026-11-28T10:01:00.000Z",
    });
    const service = createMockService(makeFeed([failedTask, reviewTask]));

    const { unmount } = render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ lỗi (1)"));
    expect(trigger.className).toContain("bg-red-50");
    expect(
      screen.getByTestId("global-task-center-sidebar-count"),
    ).toHaveTextContent("1");

    // User opens the AI Task Center drawer to read the alert tasks.
    fireEvent.click(trigger);
    await screen.findByTestId("global-task-center-panel");

    // Trigger immediately calms down to idle "Tác vụ AI" with no warning badge.
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ AI"));
    expect(trigger).not.toHaveTextContent("Tác vụ lỗi");
    expect(trigger).not.toHaveTextContent("Cần xác minh");
    expect(trigger.className).not.toContain("bg-red-50");
    expect(trigger.className).not.toContain("bg-amber-50");
    expect(
      screen.queryByTestId("global-task-center-sidebar-count"),
    ).not.toBeInTheDocument();

    // Closing the drawer keeps the warning cleared.
    fireEvent.click(
      screen.getByRole("button", { name: "Đóng trung tâm tác vụ AI" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("global-task-center-panel"),
      ).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveTextContent("Tác vụ AI");

    // Simulate full browser reload: wipe memory cache, remount provider with same backend feed.
    unmount();
    clearGlobalTasksMemoryCache();
    service.listTasks.mockClear();

    render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
      </AiTaskCenterProvider>,
    );

    const reloadedTrigger = await screen.findByTestId(
      "global-task-center-trigger",
    );
    await waitFor(() => expect(service.listTasks).toHaveBeenCalledTimes(1));
    expect(reloadedTrigger).toHaveTextContent("Tác vụ AI");
    expect(
      screen.queryByTestId("global-task-center-sidebar-count"),
    ).not.toBeInTheDocument();
  });

  it("clears PARTIAL_SUCCESS warnings on drawer interaction while keeping WAITING_FOR_WORKER queue status visible", async () => {
    const partialTask = makeTask({
      id: "job-partial-1",
      status: "PARTIAL_SUCCESS",
      status_label_vi: "Hoàn tất một phần",
      stage_label_vi: "Một số trang cần xem lại",
      error_message_vi: null,
      can_retry: true,
      result_href: "/admin/books/book-1",
      updated_at: "2026-11-28T10:05:00.000Z",
    });
    const service = createMockService(makeFeed([partialTask]));

    const { rerender } = render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ lỗi (1)"));

    fireEvent.click(trigger);
    await screen.findByTestId("global-task-center-panel");
    fireEvent.click(
      within(screen.getByTestId("task-card-job-partial-1")).getByRole("link", {
        name: /Xem kết quả/,
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("global-task-center-panel"),
      ).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveTextContent("Tác vụ AI");
    expect(
      screen.queryByTestId("global-task-center-sidebar-count"),
    ).not.toBeInTheDocument();

    // Active WAITING_FOR_WORKER task MUST still show calm queued indicator even after opening/closing drawer.
    const waitingWorkerTask = makeTask({
      id: "job-offline-queue-1",
      status: "WAITING_FOR_WORKER",
      status_label_vi: "Chờ máy xử lý AI kết nối lại",
      stage_label_vi: "Đã lưu trong hàng chờ — Chờ máy chủ OCR bật lại",
      error_message_vi: null,
      can_retry: false,
      can_cancel: false,
      updated_at: "2026-11-28T10:06:00.000Z",
    });
    service.listTasks.mockResolvedValue(
      makeFeed([partialTask, waitingWorkerTask], { worker_online: false }),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(trigger).toHaveTextContent("Hàng chờ OCR (1)"));
    fireEvent.click(trigger);
    await screen.findByTestId("global-task-center-panel");
    fireEvent.click(
      screen.getByRole("button", { name: "Đóng trung tâm tác vụ AI" }),
    );
    expect(trigger).toHaveTextContent("Hàng chờ OCR (1)");
    rerender(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
      </AiTaskCenterProvider>,
    );
    expect(trigger).toHaveTextContent("Hàng chờ OCR (1)");
  });

  it("switches ParentAccountDropdown from red warning dot to calm running dot when failed alert is read while another task is still running", async () => {
    navigationMock.pathname = "/my-books";
    const failedTask = makeTask({
      id: "parent-fail-with-active",
      actor_id: "parent-mix",
      actor_role: "parent",
      portal: "parent",
      status: "FAILED",
      updated_at: "2026-11-28T09:00:00.000Z",
    });
    const runningTask = makeTask({
      id: "parent-running-1",
      actor_id: "parent-mix",
      actor_role: "parent",
      portal: "parent",
      status: "RUNNING",
      status_label_vi: "Đang xử lý",
      error_message_vi: null,
      can_retry: false,
      can_cancel: true,
      progress_pct: 55,
      is_indeterminate: false,
      updated_at: "2026-11-28T09:01:00.000Z",
    });
    const service = createMockService(
      makeFeed([failedTask, runningTask], {
        actor_id: "parent-mix",
        actor_role: "parent",
        portal: "parent",
      }),
    );

    render(
      <I18nProvider initialLocale="vi">
        <AiTaskCenterProvider
          actorId="parent-mix"
          actorRole="parent"
          service={service}
        >
          <GlobalTaskCenter variant="drawer-only" />
          <ParentAccountDropdown
            appStore={null}
            availableChildren={[]}
            avatarUrl={null}
            displayName="Phụ huynh Mix"
            email="mix@example.com"
            isSigningOut={false}
            onSignOut={vi.fn(async () => {})}
            pathname="/my-books"
            roleLabel="Phụ huynh"
            selectedChild={null}
            userId="parent-mix"
          />
        </AiTaskCenterProvider>
      </I18nProvider>,
    );

    // Before reading: red alert dot takes precedence.
    await screen.findByTestId("avatar-notification-dot");

    // Open menu & click AI tasks -> acknowledges failed alert, leaves running task active.
    fireEvent.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    fireEvent.click(screen.getByTestId("menu-ai-tasks-trigger"));
    await screen.findByTestId("global-task-center-panel");

    // Red dot is replaced by calm blue running dot!
    await waitFor(() =>
      expect(
        screen.queryByTestId("avatar-notification-dot"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("avatar-running-dot")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Đóng trung tâm tác vụ AI" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    expect(screen.getByTestId("menu-ai-tasks-trigger")).toHaveTextContent(
      "1 tác vụ đang chạy nền",
    );
  });

  it("re-alerts when a retried task fails again or a new alert task arrives, while keeping active tasks visible", async () => {
    const failedV1 = makeTask({
      id: "job-retry-me",
      status: "FAILED",
      attempt_count: 1,
      updated_at: "2026-11-28T10:00:00.000Z",
    });
    const service = createMockService(makeFeed([failedV1]));

    render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ lỗi (1)"));

    // Open drawer -> reads & clears initial failure.
    fireEvent.click(trigger);
    await screen.findByTestId("global-task-center-panel");
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ AI"));

    // User clicks Retry -> backend moves task to RUNNING.
    const runningV2 = makeTask({
      id: "job-retry-me",
      status: "RUNNING",
      status_label_vi: "Đang xử lý",
      attempt_count: 2,
      progress_pct: 40,
      is_indeterminate: false,
      can_retry: false,
      can_cancel: true,
      error_message_vi: null,
      updated_at: "2026-11-28T10:01:00.000Z",
    });
    service.listTasks.mockResolvedValue(makeFeed([runningV2]));

    fireEvent.click(
      within(screen.getByTestId("task-card-job-retry-me")).getByRole("button", {
        name: "Thử lại",
      }),
    );

    await waitFor(() => expect(trigger).toHaveTextContent("AI đang chạy (1)"));

    // Close drawer: active running task MUST remain shown on the bar.
    fireEvent.click(
      screen.getByRole("button", { name: "Đóng trung tâm tác vụ AI" }),
    );
    expect(trigger).toHaveTextContent("AI đang chạy (1)");

    // Later, attempt 2 fails again -> warning MUST reappear!
    const failedV2 = makeTask({
      id: "job-retry-me",
      status: "FAILED",
      attempt_count: 2,
      updated_at: "2026-11-28T10:02:00.000Z",
    });
    service.listTasks.mockResolvedValue(makeFeed([failedV2]));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ lỗi (1)"));
    expect(
      screen.getByTestId("global-task-center-sidebar-count"),
    ).toHaveTextContent("1");
  });

  it("clears ParentAccountDropdown red alert dot, menu red dot, badge, and warning subtitle after reading, including async autoSyncOnMount=false loads", async () => {
    navigationMock.pathname = "/dashboard";
    const parentFailed = makeTask({
      id: "parent-fail-1",
      actor_id: "parent-1",
      actor_role: "parent",
      portal: "parent",
      status: "FAILED",
      result_href: "/my-books?bookId=book-1",
      updated_at: "2026-11-28T09:00:00.000Z",
    });
    const parentReview = makeTask({
      id: "parent-review-1",
      actor_id: "parent-1",
      actor_role: "parent",
      portal: "parent",
      status: "WAITING_FOR_REVIEW",
      status_label_vi: "Cần xác minh",
      can_retry: false,
      error_message_vi: null,
      result_href: "/my-books?bookId=book-1",
      updated_at: "2026-11-28T09:05:00.000Z",
    });
    const parentDone = makeTask({
      id: "parent-done-1",
      actor_id: "parent-1",
      actor_role: "parent",
      portal: "parent",
      status: "SUCCEEDED",
      status_label_vi: "Hoàn thành",
      can_retry: false,
      error_message_vi: null,
      result_href: "/my-books?bookId=book-1",
      updated_at: "2026-11-28T09:10:00.000Z",
    });

    const service = createMockService(
      makeFeed([parentFailed, parentReview, parentDone], {
        actor_id: "parent-1",
        actor_role: "parent",
        portal: "parent",
      }),
    );

    render(
      <I18nProvider initialLocale="vi">
        <AiTaskCenterProvider
          actorId="parent-1"
          actorRole="parent"
          service={service}
        >
          <GlobalTaskCenter variant="drawer-only" />
          <ParentAccountDropdown
            appStore={null}
            availableChildren={[]}
            avatarUrl={null}
            displayName="Phụ huynh A"
            email="parent@example.com"
            isSigningOut={false}
            onSignOut={vi.fn(async () => {})}
            pathname="/dashboard"
            roleLabel="Phụ huynh"
            selectedChild={null}
            userId="parent-1"
          />
        </AiTaskCenterProvider>
      </I18nProvider>,
    );

    // Before reading: pulsing red dot on avatar + red dot & error subtitle in menu.
    await screen.findByTestId("avatar-notification-dot");
    fireEvent.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    const menuTrigger = screen.getByTestId("menu-ai-tasks-trigger");
    expect(screen.getByTestId("menu-ai-tasks-red-dot")).toBeInTheDocument();
    expect(menuTrigger).toHaveTextContent("1 tác vụ gặp lỗi cần xem");

    // Parent clicks "Tác vụ AI & Thông báo" -> opens drawer and marks all alerts seen.
    fireEvent.click(menuTrigger);
    await screen.findByTestId("global-task-center-panel");

    // Red alert dot disappears immediately.
    await waitFor(() =>
      expect(
        screen.queryByTestId("avatar-notification-dot"),
      ).not.toBeInTheDocument(),
    );

    // Close drawer, reopen account dropdown -> calm idle status with no red dot or badge.
    fireEvent.click(
      screen.getByRole("button", { name: "Đóng trung tâm tác vụ AI" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    const calmMenuTrigger = screen.getByTestId("menu-ai-tasks-trigger");
    expect(
      screen.queryByTestId("menu-ai-tasks-red-dot"),
    ).not.toBeInTheDocument();
    expect(calmMenuTrigger).toHaveTextContent("Chưa có tác vụ mới");
  });

  it("acknowledges alerts that resolve asynchronously while the drawer is open (autoSyncOnMount=false)", async () => {
    navigationMock.pathname = "/dashboard";
    let resolveFetch: ((value: GlobalTaskListResponse) => void) | null = null;
    const delayedFeedPromise = new Promise<GlobalTaskListResponse>(
      (resolve) => {
        resolveFetch = resolve;
      },
    );

    const service = createMockService(
      makeFeed([], {
        actor_id: "parent-async",
        actor_role: "parent",
        portal: "parent",
      }),
    );
    service.listTasks.mockImplementation(() => delayedFeedPromise);

    render(
      <I18nProvider initialLocale="vi">
        <AiTaskCenterProvider
          actorId="parent-async"
          actorRole="parent"
          autoSyncOnMount={false}
          service={service}
        >
          <GlobalTaskCenter variant="drawer-only" />
          <ParentAccountDropdown
            appStore={null}
            availableChildren={[]}
            avatarUrl={null}
            displayName="Phụ huynh Async"
            email="async@example.com"
            isSigningOut={false}
            onSignOut={vi.fn(async () => {})}
            pathname="/dashboard"
            roleLabel="Phụ huynh"
            selectedChild={null}
            userId="parent-async"
          />
        </AiTaskCenterProvider>
      </I18nProvider>,
    );

    // Open menu & click AI Tasks before data has loaded.
    fireEvent.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    fireEvent.click(screen.getByTestId("menu-ai-tasks-trigger"));
    await screen.findByTestId("global-task-center-panel");

    // Backend responds while drawer is open with a failed task (even with a future clock-skewed timestamp!).
    await act(async () => {
      resolveFetch?.(
        makeFeed(
          [
            makeTask({
              id: "skewed-fail-1",
              actor_id: "parent-async",
              actor_role: "parent",
              portal: "parent",
              status: "FAILED",
              updated_at: "2099-01-01T00:00:00.000Z",
            }),
          ],
          {
            actor_id: "parent-async",
            actor_role: "parent",
            portal: "parent",
          },
        ),
      );
      await Promise.resolve();
    });

    await screen.findByTestId("task-card-skewed-fail-1");

    // Close drawer -> because user just viewed it in the open drawer, no red dot appears!
    fireEvent.click(
      screen.getByRole("button", { name: "Đóng trung tâm tác vụ AI" }),
    );
    expect(
      screen.queryByTestId("avatar-notification-dot"),
    ).not.toBeInTheDocument();
  });

  it("acknowledges alerts when visiting StudioTasksPageScreen directly while preserving real summary counts", async () => {
    navigationMock.pathname = "/admin/tasks";
    const failedTask = makeTask({
      id: "page-fail-1",
      status: "FAILED",
      updated_at: "2026-11-28T10:00:00.000Z",
    });
    const service = createMockService(makeFeed([failedTask]));

    render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
        <StudioTasksPageScreen viewMode="admin" />
      </AiTaskCenterProvider>,
    );

    await screen.findByTestId("studio-task-row-page-fail-1");

    // Sidebar bar calms down automatically because user is reading the full tasks page.
    await waitFor(() =>
      expect(
        screen.getByTestId("global-task-center-trigger"),
      ).toHaveTextContent("Tác vụ AI"),
    );
    expect(
      screen.queryByTestId("global-task-center-sidebar-count"),
    ).not.toBeInTheDocument();

    // Real filter count on the full page still shows 1 failed task for inspection/retry.
    expect(
      screen.getByRole("button", { name: /Thất bại\s*1/ }),
    ).toBeInTheDocument();
  });

  it("isolates acknowledgments per actor/portal, syncs cross-tab via storage events, and survives corrupted or restricted localStorage", async () => {
    const sharedUserAdminTask = makeTask({
      id: "shared-id-task",
      actor_id: "user-1",
      actor_role: "admin",
      portal: "admin",
      status: "WAITING_FOR_REVIEW",
      status_label_vi: "Cần xác minh",
      can_retry: false,
      error_message_vi: null,
    });
    const sharedUserParentTask = makeTask({
      id: "shared-id-task",
      actor_id: "user-1",
      actor_role: "parent",
      portal: "parent",
      status: "WAITING_FOR_REVIEW",
      status_label_vi: "Cần xác minh",
      can_retry: false,
      error_message_vi: null,
    });

    // Seed corrupted JSON for admin scope -> must degrade gracefully without throwing.
    window.localStorage.setItem(
      buildTaskAlertAckStorageKey("user-1:admin"),
      "{not-valid-json",
    );

    const adminService = createMockService(
      makeFeed([sharedUserAdminTask], {
        actor_id: "user-1",
        actor_role: "admin",
        portal: "admin",
      }),
    );

    const { unmount } = render(
      <AiTaskCenterProvider
        actorId="user-1"
        actorRole="admin"
        service={adminService}
      >
        <GlobalTaskCenter variant="sidebar" />
      </AiTaskCenterProvider>,
    );

    const adminTrigger = await screen.findByTestId(
      "global-task-center-trigger",
    );
    await waitFor(() =>
      expect(adminTrigger).toHaveTextContent("Cần xác minh (1)"),
    );

    // Acknowledge in admin portal.
    fireEvent.click(adminTrigger);
    await waitFor(() => expect(adminTrigger).toHaveTextContent("Tác vụ AI"));
    unmount();

    // Parent portal for the same user MUST remain unacknowledged (strict portal isolation).
    navigationMock.pathname = "/my-books";
    const parentService = createMockService(
      makeFeed([sharedUserParentTask], {
        actor_id: "user-1",
        actor_role: "parent",
        portal: "parent",
      }),
    );

    render(
      <AiTaskCenterProvider
        actorId="user-1"
        actorRole="parent"
        service={parentService}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    const parentTrigger = await screen.findByTestId(
      "global-task-center-trigger",
    );
    await waitFor(() =>
      expect(parentTrigger).toHaveTextContent("Cần xác minh (1)"),
    );

    // Cross-tab storage sync: another tab acknowledges parent alert -> this tab clears immediately!
    const parentAckKey = buildTaskAlertAckStorageKey("user-1:parent");
    const ackPayload = JSON.stringify({
      v: 1,
      seen: {
        "shared-id-task": "WAITING_FOR_REVIEW|2026-11-28T10:00:00.000Z|1",
      },
    });
    window.localStorage.setItem(parentAckKey, ackPayload);
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: parentAckKey,
          newValue: ackPayload,
        }),
      );
    });

    await waitFor(() => expect(parentTrigger).toHaveTextContent("Tác vụ AI"));
  });

  it("respects legacy viread_tasks_last_seen for old SUCCEEDED tasks while falling back to memory when localStorage.setItem throws", async () => {
    navigationMock.pathname = "/dashboard";
    window.localStorage.setItem(
      buildLegacyParentLastSeenKey("parent-legacy"),
      String(Date.parse("2026-11-28T10:00:00.000Z")),
    );

    const oldSucceeded = makeTask({
      id: "old-done-1",
      actor_id: "parent-legacy",
      actor_role: "parent",
      portal: "parent",
      status: "SUCCEEDED",
      status_label_vi: "Hoàn thành",
      can_retry: false,
      error_message_vi: null,
      updated_at: "2026-11-28T09:55:00.000Z",
    });
    const unseenFailed = makeTask({
      id: "unseen-fail-1",
      actor_id: "parent-legacy",
      actor_role: "parent",
      portal: "parent",
      status: "FAILED",
      updated_at: "2026-11-28T09:50:00.000Z",
    });

    const service = createMockService(
      makeFeed([oldSucceeded, unseenFailed], {
        actor_id: "parent-legacy",
        actor_role: "parent",
        portal: "parent",
      }),
    );

    // Simulate restricted storage mode where setItem throws QuotaExceededError.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    render(
      <I18nProvider initialLocale="vi">
        <AiTaskCenterProvider
          actorId="parent-legacy"
          actorRole="parent"
          service={service}
        >
          <GlobalTaskCenter variant="drawer-only" />
          <ParentAccountDropdown
            appStore={null}
            availableChildren={[]}
            avatarUrl={null}
            displayName="Phụ huynh Legacy"
            email="legacy@example.com"
            isSigningOut={false}
            onSignOut={vi.fn(async () => {})}
            pathname="/dashboard"
            roleLabel="Phụ huynh"
            selectedChild={null}
            userId="parent-legacy"
          />
        </AiTaskCenterProvider>
      </I18nProvider>,
    );

    // Unseen failed task alerts even though oldSucceeded is suppressed by legacy timestamp.
    await screen.findByTestId("avatar-notification-dot");
    fireEvent.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    expect(screen.getByTestId("menu-ai-tasks-trigger")).toHaveTextContent(
      "1 tác vụ gặp lỗi cần xem",
    );

    // Clicking AI tasks still dismisses the warning via in-memory fallback without throwing!
    fireEvent.click(screen.getByTestId("menu-ai-tasks-trigger"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("avatar-notification-dot"),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not silently acknowledge alerts while the tab is hidden, then acknowledges once visible", async () => {
    navigationMock.pathname = "/admin/tasks";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    const failedTask = makeTask({
      id: "hidden-tab-fail",
      status: "FAILED",
    });
    const service = createMockService(makeFeed([failedTask]));

    render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
        <StudioTasksPageScreen viewMode="admin" />
      </AiTaskCenterProvider>,
    );

    await screen.findByTestId("studio-task-row-hidden-tab-fail");
    // Tab is hidden -> warning remains active until user actually views the tab.
    expect(screen.getByTestId("global-task-center-trigger")).toHaveTextContent(
      "Tác vụ lỗi (1)",
    );

    // User switches to the tab -> visibility becomes visible -> warning clears!
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() =>
      expect(
        screen.getByTestId("global-task-center-trigger"),
      ).toHaveTextContent("Tác vụ AI"),
    );
  });

  it("never resurrects an active acknowledged FAILED task during LRU eviction (>120 acks) and handles numeric IDs + cross-source collisions + legacy bare keys", () => {
    const scopeKey = "admin-lru:admin";
    const persistentFailure = makeTask({
      id: "old-fail-persistent",
      source: "ocr_inference_job",
      status: "FAILED",
      updated_at: "2026-11-20T08:00:00.000Z",
    });

    // Acknowledge the persistent failure first (becomes oldest entry).
    expect(
      acknowledgeTaskAlerts(
        scopeKey,
        [persistentFailure],
        "admin-lru",
        "admin",
      ),
    ).toBe(true);

    // Acknowledge 130 subsequent succeeded tasks alongside persistentFailure in the feed.
    for (let i = 1; i <= 130; i += 1) {
      const doneTask = makeTask({
        id: `uuid-ok-${i}`,
        source: "smart_studio_job",
        status: "SUCCEEDED",
        updated_at: `2026-11-28T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      });
      acknowledgeTaskAlerts(
        scopeKey,
        [persistentFailure, doneTask],
        "admin-lru",
        "admin",
      );
    }

    // persistentFailure MUST still be acknowledged (refreshed in LRU, never evicted!).
    let ackState = getTaskAlertAckState(scopeKey, "admin-lru", "admin");
    expect(isTaskAlertAcknowledged(persistentFailure, ackState)).toBe(true);

    // Numeric task ID ("42") MUST NOT be evicted immediately by JS integer-key ordering!
    const numericIdTask = makeTask({
      id: "42",
      source: "smart_studio_job",
      status: "FAILED",
      updated_at: "2026-11-28T12:00:00.000Z",
    });
    expect(
      acknowledgeTaskAlerts(scopeKey, [numericIdTask], "admin-lru", "admin"),
    ).toBe(true);
    ackState = getTaskAlertAckState(scopeKey, "admin-lru", "admin");
    expect(isTaskAlertAcknowledged(numericIdTask, ackState)).toBe(true);

    // Same task ID across two different backend sources MUST stay isolated.
    const sameIdOtherSource = makeTask({
      id: "42",
      source: "ocr_inference_job",
      status: "FAILED",
      updated_at: "2026-11-28T12:00:00.000Z",
    });
    expect(isTaskAlertAcknowledged(sameIdOtherSource, ackState)).toBe(false);

    // Backward-compatible read of a pre-existing legacy bare-id key in localStorage.
    const legacyScope = "admin-bare:admin";
    const legacyTask = makeTask({
      id: "legacy-bare-1",
      source: "smart_studio_job",
      status: "FAILED",
      attempt_count: 1,
      updated_at: "2026-11-28T09:00:00.000Z",
    });
    window.localStorage.setItem(
      buildTaskAlertAckStorageKey(legacyScope),
      JSON.stringify({
        v: 1,
        seen: { "legacy-bare-1": "FAILED|2026-11-28T09:00:00.000Z|1" },
      }),
    );
    const legacyAckState = getTaskAlertAckState(
      legacyScope,
      "admin-bare",
      "admin",
    );
    expect(isTaskAlertAcknowledged(legacyTask, legacyAckState)).toBe(true);
    // Strict no-op when only already-acknowledged legacy bare-id task is present.
    expect(
      acknowledgeTaskAlerts(legacyScope, [legacyTask], "admin-bare", "admin"),
    ).toBe(false);
  });

  it("sends exactly one non-aborted listTasks fetch when opening the drawer and zero fetches when closing it", async () => {
    const signals: AbortSignal[] = [];
    const feed = makeFeed([
      makeTask({
        id: "open-close-fail",
        status: "FAILED",
      }),
    ]);
    const service = createMockService(feed);
    service.listTasks.mockImplementation(
      async (opts?: { readonly signal?: AbortSignal }) => {
        if (opts?.signal) {
          signals.push(opts.signal);
        }
        await Promise.resolve();
        if (opts?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return feed;
      },
    );

    render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ lỗi (1)"));
    expect(service.listTasks).toHaveBeenCalledTimes(1);

    // Open drawer -> exactly 1 fresh fetch (call #2), NOT aborted by effect re-run!
    fireEvent.click(trigger);
    await screen.findByTestId("global-task-center-panel");
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ AI"));
    expect(service.listTasks).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);

    // Close drawer -> ZERO extra fetches!
    fireEvent.click(
      screen.getByRole("button", { name: "Đóng trung tâm tác vụ AI" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("global-task-center-panel"),
      ).not.toBeInTheDocument(),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(service.listTasks).toHaveBeenCalledTimes(2);
  });

  it("keeps ParentAccountDropdown subtitle and red badge count consistent when newly completed tasks coexist with running tasks", async () => {
    navigationMock.pathname = "/my-books";
    const running1 = makeTask({
      id: "run-1",
      actor_id: "parent-prio",
      actor_role: "parent",
      portal: "parent",
      status: "RUNNING",
      status_label_vi: "Đang xử lý",
      error_message_vi: null,
      can_retry: false,
      can_cancel: true,
    });
    const running2 = makeTask({
      id: "run-2",
      actor_id: "parent-prio",
      actor_role: "parent",
      portal: "parent",
      status: "RUNNING",
      status_label_vi: "Đang xử lý",
      error_message_vi: null,
      can_retry: false,
      can_cancel: true,
    });
    const done1 = makeTask({
      id: "done-1",
      actor_id: "parent-prio",
      actor_role: "parent",
      portal: "parent",
      status: "SUCCEEDED",
      status_label_vi: "Hoàn thành",
      error_message_vi: null,
      can_retry: false,
      can_cancel: false,
    });
    const service = createMockService(
      makeFeed([running1, running2, done1], {
        actor_id: "parent-prio",
        actor_role: "parent",
        portal: "parent",
      }),
    );

    render(
      <I18nProvider initialLocale="vi">
        <AiTaskCenterProvider
          actorId="parent-prio"
          actorRole="parent"
          service={service}
        >
          <GlobalTaskCenter variant="drawer-only" />
          <ParentAccountDropdown
            appStore={null}
            availableChildren={[]}
            avatarUrl={null}
            displayName="Phụ huynh Priority"
            email="prio@example.com"
            isSigningOut={false}
            onSignOut={vi.fn(async () => {})}
            pathname="/my-books"
            roleLabel="Phụ huynh"
            selectedChild={null}
            userId="parent-prio"
          />
        </AiTaskCenterProvider>
      </I18nProvider>,
    );

    await screen.findByTestId("avatar-notification-dot");
    fireEvent.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    const menuTrigger = screen.getByTestId("menu-ai-tasks-trigger");
    // Subtitle matches the red badge ("1") instead of contradicting it with "2 tác vụ đang chạy nền"!
    expect(menuTrigger).toHaveTextContent("1 tác vụ mới hoàn tất");
    expect(menuTrigger).toHaveTextContent("1");

    // Once user opens the drawer, the completed alert clears and calm running state ("2") shows.
    fireEvent.click(menuTrigger);
    await screen.findByTestId("global-task-center-panel");
    fireEvent.click(
      screen.getByRole("button", { name: "Đóng trung tâm tác vụ AI" }),
    );
    expect(screen.getByTestId("avatar-running-dot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mở menu tài khoản" }));
    expect(screen.getByTestId("menu-ai-tasks-trigger")).toHaveTextContent(
      "2 tác vụ đang chạy nền",
    );
  });

  it("clears page-scoped alerts via markTargetAlertsSeen without opening the drawer and leaves other pages unread", async () => {
    const page1Review = makeTask({
      id: "wf-page-1",
      source: "admin_ai_workflow",
      book_id: "book-1",
      book_page_id: "page-1",
      status: "WAITING_FOR_REVIEW",
      status_label_vi: "Cần xác minh",
      error_message_vi: null,
      can_retry: false,
    });
    const page2Review = makeTask({
      id: "wf-page-2",
      source: "admin_ai_workflow",
      book_id: "book-1",
      book_page_id: "page-2",
      status: "WAITING_FOR_REVIEW",
      status_label_vi: "Cần xác minh",
      error_message_vi: null,
      can_retry: false,
    });
    const service = createMockService(makeFeed([page1Review, page2Review]));

    function DirectPageActionHarness() {
      const { markTargetAlertsSeen } = useAiTaskCenter();
      return (
        <div>
          <button
            onClick={() =>
              markTargetAlertsSeen({ bookId: "book-1", bookPageId: "page-1" })
            }
            type="button"
          >
            Verify page 1
          </button>
          <button
            onClick={() =>
              markTargetAlertsSeen({ bookId: "book-1", bookPageId: "page-2" })
            }
            type="button"
          >
            Verify page 2
          </button>
        </div>
      );
    }

    render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
        <DirectPageActionHarness />
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("Cần xác minh (2)"));

    // Acting on page 1 reduces unread warning from 2 -> 1 without touching page 2.
    fireEvent.click(screen.getByRole("button", { name: "Verify page 1" }));
    await waitFor(() => expect(trigger).toHaveTextContent("Cần xác minh (1)"));

    // Acting on page 2 clears the warning completely to idle "Tác vụ AI".
    fireEvent.click(screen.getByRole("button", { name: "Verify page 2" }));
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ AI"));
    expect(
      screen.queryByTestId("global-task-center-sidebar-count"),
    ).not.toBeInTheDocument();
  });

  it("clears in-memory fallback ack cache on resetApiReadCacheForActorSwitch and guards hidden-tab closePanel", async () => {
    const failedTask = makeTask({
      id: "fallback-logout-fail",
      status: "FAILED",
    });
    const service = createMockService(makeFeed([failedTask]));

    // Force in-memory fallback mode (restricted storage).
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ lỗi (1)"));

    // Open drawer -> acknowledges in in-memory fallback.
    fireEvent.click(trigger);
    await screen.findByTestId("global-task-center-panel");
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ AI"));

    // While drawer is open, hide tab and deliver a brand-new failed task via tasks-changed.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const hiddenFailure = makeTask({
      id: "arrived-while-hidden",
      status: "FAILED",
      updated_at: "2026-11-28T12:30:00.000Z",
    });
    service.listTasks.mockResolvedValue(makeFeed([failedTask, hiddenFailure]));
    await act(async () => {
      emitStudioTasksChanged({ portal: "admin", actorId: "admin-1" });
      await Promise.resolve();
    });

    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ lỗi (1)"));

    // Closing while hidden MUST NOT silently acknowledge hiddenFailure.
    fireEvent.click(
      screen.getByRole("button", { name: "Đóng trung tâm tác vụ AI" }),
    );
    expect(trigger).toHaveTextContent("Tác vụ lỗi (1)");

    // Simulate same-tab actor switch cache reset -> clears in-memory fallback too!
    await act(async () => {
      resetApiReadCacheForActorSwitch();
    });
    expect(trigger).toHaveTextContent("Tác vụ lỗi (2)");
  });

  it("suppresses post-action bumped signatures via includeNextSync without affecting unrelated tasks, persists across reload, and re-alerts on a later update", async () => {
    const task1V1 = makeTask({
      id: "sub-sync-1",
      source: "parent_submission",
      actor_id: "parent-sync",
      actor_role: "parent",
      portal: "parent",
      book_id: "book-sync",
      book_page_id: null,
      status: "SUCCEEDED",
      status_label_vi: "Bản đọc đã sẵn sàng để xem",
      can_retry: false,
      error_message_vi: null,
      updated_at: "2026-11-28T10:00:00.000Z",
    });
    const task2Other = makeTask({
      id: "sub-sync-2",
      source: "parent_submission",
      actor_id: "parent-sync",
      actor_role: "parent",
      portal: "parent",
      book_id: "book-sync",
      book_page_id: null,
      status: "FAILED",
      updated_at: "2026-11-28T10:00:30.000Z",
    });

    const service = createMockService(
      makeFeed([task1V1, task2Other], {
        actor_id: "parent-sync",
        actor_role: "parent",
        portal: "parent",
      }),
    );

    function DirectMutationHarness() {
      const { markTaskAlertSeen, unreadCompletedCount, unreadFailedCount } =
        useAiTaskCenter();
      return (
        <div>
          <span data-testid="unread-completed">{unreadCompletedCount}</span>
          <span data-testid="unread-failed">{unreadFailedCount}</span>
          <button
            onClick={() => {
              markTaskAlertSeen("sub-sync-1", { includeNextSync: true });
              emitStudioTasksChanged({ portal: "parent" });
            }}
            type="button"
          >
            Commit sub 1
          </button>
        </div>
      );
    }

    const { unmount } = render(
      <AiTaskCenterProvider
        actorId="parent-sync"
        actorRole="parent"
        service={service}
      >
        <DirectMutationHarness />
      </AiTaskCenterProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("unread-completed")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("unread-failed")).toHaveTextContent("1");

    // Backend bumps updated_at on sub-sync-1 when committed (ADDED_TO_BOOK -> still SUCCEEDED).
    const task1V2 = makeTask({
      ...task1V1,
      book_page_id: "page-committed-1",
      updated_at: "2026-11-28T10:05:00.000Z",
    });
    service.listTasks.mockResolvedValue(
      makeFeed([task1V2, task2Other], {
        actor_id: "parent-sync",
        actor_role: "parent",
        portal: "parent",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Commit sub 1" }));

    await waitFor(() => expect(service.listTasks).toHaveBeenCalledTimes(2));
    // sub-sync-1 stays acknowledged even after bumped updated_at; sub-sync-2 remains unread!
    expect(screen.getByTestId("unread-completed")).toHaveTextContent("0");
    expect(screen.getByTestId("unread-failed")).toHaveTextContent("1");

    // Simulate reload: sub-sync-1 V2 stays acknowledged.
    unmount();
    clearGlobalTasksMemoryCache();
    service.listTasks.mockClear();

    render(
      <AiTaskCenterProvider
        actorId="parent-sync"
        actorRole="parent"
        service={service}
      >
        <DirectMutationHarness />
      </AiTaskCenterProvider>,
    );

    await waitFor(() => expect(service.listTasks).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("unread-completed")).toHaveTextContent("0");
    expect(screen.getByTestId("unread-failed")).toHaveTextContent("1");

    // Later server update (V3) MUST re-alert because the one-shot includeNextSync rule was already consumed!
    const task1V3 = makeTask({
      ...task1V2,
      updated_at: "2026-11-28T10:10:00.000Z",
    });
    service.listTasks.mockResolvedValue(
      makeFeed([task1V3, task2Other], {
        actor_id: "parent-sync",
        actor_role: "parent",
        portal: "parent",
      }),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId("unread-completed")).toHaveTextContent("1"),
    );
  });

  it("drops pending includeNextSync rules on non-abort sync error so later alerts are never silently swallowed", async () => {
    const wfV1 = makeTask({
      id: "wf-err-1",
      source: "admin_ai_workflow",
      status: "WAITING_FOR_REVIEW",
      status_label_vi: "Cần xác minh",
      can_retry: false,
      error_message_vi: null,
      updated_at: "2026-11-28T10:00:00.000Z",
    });
    const service = createMockService(makeFeed([wfV1]));

    function ActionHarness() {
      const { markTargetAlertsSeen } = useAiTaskCenter();
      return (
        <button
          onClick={() => {
            markTargetAlertsSeen(
              { bookId: "book-1", bookPageId: "page-1" },
              { includeNextSync: true },
            );
            emitStudioTasksChanged({ portal: "admin" });
          }}
          type="button"
        >
          Trigger failing sync
        </button>
      );
    }

    render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <GlobalTaskCenter variant="sidebar" />
        <ActionHarness />
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("Cần xác minh (1)"));

    // Next sync fails with a transient 500 error -> pending rule is dropped.
    service.listTasks.mockRejectedValueOnce(new Error("Temporary 500"));
    fireEvent.click(
      screen.getByRole("button", { name: "Trigger failing sync" }),
    );
    await waitFor(() => expect(service.listTasks).toHaveBeenCalledTimes(2));
    // Old V1 was already acknowledged synchronously.
    expect(trigger).toHaveTextContent("Tác vụ AI");

    // Later a genuinely new FAILED alert arrives on the same page -> MUST alert!
    const wfV2Failed = makeTask({
      id: "wf-err-1",
      source: "admin_ai_workflow",
      status: "FAILED",
      attempt_count: 2,
      updated_at: "2026-11-28T10:15:00.000Z",
    });
    service.listTasks.mockResolvedValue(makeFeed([wfV2Failed]));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ lỗi (1)"));
  });
});
