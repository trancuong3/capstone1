import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AiTaskCenterProvider,
  sanitizeScopedTaskFeed,
} from "@/components/tasks/ai-task-center-provider";
import { GlobalTaskCenter } from "@/components/tasks/global-task-center";
import { StudioTasksPageScreen } from "@/components/tasks/studio-tasks-page-screen";
import {
  clearAdminBookUploadSessions,
  getAdminBookUploadSession,
  rehydrateAdminBookUploadTasks,
} from "@/lib/admin/admin-book-upload-session";
import {
  ACTOR_SWITCH_BROADCAST_KEY,
  clearGlobalTasksMemoryCache,
  createGlobalTasksService,
  emitStudioTasksChanged,
  getCachedGlobalTasksSnapshot,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import {
  isCacheableApiGetPath,
  resetApiReadCacheForActorSwitch,
} from "@/lib/api/read-cache";
import {
  clearStoredScanJobIds,
  readStoredScanJobId,
  writeStoredScanJobId,
} from "@/lib/cache/scan-job-storage";
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

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: {
          session: {
            access_token: "isolation-test-token",
            user: { id: "admin-1" },
          },
        },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

function makeTask(overrides: Partial<GlobalTaskItem> = {}): GlobalTaskItem {
  const nowIso = "2026-11-27T10:00:00.000Z";
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "smart_studio_job",
    job_type: "OCR_EXTRACT",
    title_vi: "Tách nội dung OCR thông minh",
    book_id: "22222222-2222-4222-8222-222222222222",
    book_page_id: "33333333-3333-4333-8333-333333333333",
    book_title: "Chú Mèo Đi Hia",
    page_number: 2,
    source_revision_id: null,
    actor_id: "parent-a",
    actor_role: "parent",
    portal: "parent",
    status: "RUNNING",
    status_label_vi: "Đang xử lý",
    stage: "OCR",
    stage_label_vi: "Nhận diện chữ (OCR)",
    priority: 50,
    attempt_count: 1,
    max_attempts: 3,
    progress_completed: 2,
    progress_total: 4,
    progress_unit: "trang",
    progress_pct: 50,
    progress_mode: "measured",
    is_indeterminate: false,
    can_retry: false,
    can_cancel: true,
    result_href: "/my-books/22222222-2222-4222-8222-222222222222",
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
  return {
    actor_id: "parent-a",
    actor_role: "parent",
    portal: "parent",
    active_count: tasks.filter((t) =>
      [
        "QUEUED",
        "RUNNING",
        "WAITING_FOR_WORKER",
        "WAITING_FOR_QUOTA",
        "RETRY_SCHEDULED",
        "CANCEL_REQUESTED",
      ].includes(t.status),
    ).length,
    waiting_review_count: tasks.filter((t) => t.status === "WAITING_FOR_REVIEW")
      .length,
    failed_count: tasks.filter((t) => t.status === "FAILED").length,
    completed_count: tasks.filter((t) => t.status === "SUCCEEDED").length,
    worker_online: true,
    recommended_poll_ms: null,
    tasks,
    ...overrides,
  };
}

function makeMockService(feed: GlobalTaskListResponse): GlobalTasksService & {
  listTasks: ReturnType<typeof vi.fn>;
  retryTask: ReturnType<typeof vi.fn>;
  cancelTask: ReturnType<typeof vi.fn>;
} {
  return {
    listTasks: vi.fn().mockResolvedValue(feed),
    createTask: vi.fn(),
    retryTask: vi.fn().mockResolvedValue({
      task: makeTask({ status: "QUEUED" }),
      action: "retried",
      deduplicated: false,
      message_vi: "OK",
    } satisfies GlobalTaskActionResponse),
    cancelTask: vi.fn().mockResolvedValue({
      task: makeTask({ status: "CANCEL_REQUESTED" }),
      action: "cancel_requested",
      deduplicated: false,
      message_vi: "OK",
    } satisfies GlobalTaskActionResponse),
    getCapabilities: vi.fn(),
  };
}

describe("AI Task Center strict Admin/Parent & per-Parent isolation", () => {
  beforeEach(() => {
    clearGlobalTasksMemoryCache();
    clearAdminBookUploadSessions();
    clearStoredScanJobIds();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearGlobalTasksMemoryCache();
    clearAdminBookUploadSessions();
    clearStoredScanJobIds();
  });

  it("routes Admin and Parent list/retry/cancel calls to dedicated portal endpoints with 404 fallback", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/studio/admin/tasks/admin-job-1/retry")) {
        return Response.json({
          task: makeTask({
            id: "admin-job-1",
            actor_id: "admin-1",
            actor_role: "admin",
            portal: "admin",
            status: "QUEUED",
          }),
          action: "retried",
          deduplicated: false,
          message_vi: "OK",
        });
      }
      if (url.includes("/studio/parent/tasks/parent-job-1/cancel")) {
        return Response.json({
          task: makeTask({
            id: "parent-job-1",
            actor_id: "parent-1",
            actor_role: "parent",
            portal: "parent",
            status: "CANCEL_REQUESTED",
          }),
          action: "cancel_requested",
          deduplicated: false,
          message_vi: "OK",
        });
      }
      if (url.includes("/studio/admin/tasks")) {
        return Response.json(
          makeFeed(
            [
              makeTask({
                id: "admin-job-1",
                actor_id: "admin-1",
                actor_role: "admin",
                portal: "admin",
              }),
            ],
            { actor_id: "admin-1", actor_role: "admin", portal: "admin" },
          ),
        );
      }
      if (url.includes("/studio/parent/tasks")) {
        // Simulate older backend returning 404 so graceful fallback to /studio/tasks?portal=parent is verified
        return new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/studio/tasks")) {
        return Response.json(
          makeFeed([], {
            actor_id: "parent-1",
            actor_role: "parent",
            portal: "parent",
          }),
        );
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = createGlobalTasksService();
    const adminFeed = await svc.listTasks({ portal: "admin" });
    expect(adminFeed.tasks).toHaveLength(1);
    expect(requestedUrls[0]).toContain("/studio/admin/tasks");
    expect(requestedUrls[0]).not.toContain("/studio/parent/tasks");

    const parentFeed = await svc.listTasks({ portal: "parent" });
    expect(parentFeed.tasks).toHaveLength(0);
    expect(requestedUrls.some((u) => u.includes("/studio/parent/tasks"))).toBe(
      true,
    );
    expect(
      requestedUrls.some(
        (u) => u.includes("/studio/tasks") && u.includes("portal=parent"),
      ),
    ).toBe(true);

    await svc.retryTask("admin-job-1", { portal: "admin" });
    expect(
      requestedUrls.some((u) =>
        u.includes("/studio/admin/tasks/admin-job-1/retry"),
      ),
    ).toBe(true);

    await svc.cancelTask("parent-job-1", { portal: "parent" });
    expect(
      requestedUrls.some((u) =>
        u.includes("/studio/parent/tasks/parent-job-1/cancel"),
      ),
    ).toBe(true);
  });

  it("sanitizes cross-portal and cross-parent leaked tasks in sanitizeScopedTaskFeed", () => {
    const adminTask = makeTask({
      id: "task-admin",
      actor_id: "admin-1",
      actor_role: "admin",
      portal: "admin",
      book_title: "Sách Quản Trị",
    });
    const parentATask = makeTask({
      id: "task-parent-a",
      actor_id: "parent-a",
      actor_role: "parent",
      portal: "parent",
      book_title: "Sách Gia Đình A",
    });
    const parentBTask = makeTask({
      id: "task-parent-b",
      actor_id: "parent-b",
      actor_role: "parent",
      portal: "parent",
      book_title: "Sách Gia Đình B",
    });

    const mixedFeed = makeFeed([adminTask, parentATask, parentBTask], {
      actor_id: "parent-a",
      actor_role: "parent",
      portal: "parent",
      active_count: 3,
    });

    const parentAScoped = sanitizeScopedTaskFeed(
      mixedFeed,
      "parent-a",
      "parent",
    );
    expect(parentAScoped).not.toBeNull();
    expect(parentAScoped!.tasks.map((t) => t.id)).toEqual(["task-parent-a"]);
    expect(parentAScoped!.active_count).toBe(1);

    // Mismatched top-level actor_id is rejected completely
    expect(sanitizeScopedTaskFeed(mixedFeed, "parent-b", "parent")).toBeNull();

    const adminScoped = sanitizeScopedTaskFeed(
      makeFeed([adminTask, parentATask, parentBTask], {
        actor_id: "admin-1",
        actor_role: "admin",
        portal: "admin",
        active_count: 3,
      }),
      "admin-1",
      "admin",
    );
    expect(adminScoped).not.toBeNull();
    expect(adminScoped!.tasks.map((t) => t.id)).toEqual(["task-admin"]);
    expect(adminScoped!.active_count).toBe(1);
  });

  it("renders separate Admin vs Parent Task Center drawers, empty states, and routes with zero cross-portal bleed", async () => {
    navigationMock.pathname = "/admin/books";
    const adminService = makeMockService(
      makeFeed([], {
        actor_id: "admin-1",
        actor_role: "admin",
        portal: "admin",
      }),
    );

    const { unmount } = render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={adminService}
      >
        <GlobalTaskCenter variant="sidebar" />
      </AiTaskCenterProvider>,
    );

    await waitFor(() =>
      expect(adminService.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ portal: "admin" }),
      ),
    );
    fireEvent.click(screen.getByTestId("global-task-center-trigger"));
    const adminPanel = await screen.findByTestId("global-task-center-panel");
    expect(adminPanel).toHaveTextContent("Tác vụ AI quản trị");
    expect(adminPanel).toHaveTextContent("Không gian quản trị (riêng bạn)");
    expect(
      within(adminPanel).getByTestId("global-task-center-full-page-link"),
    ).toHaveAttribute("href", "/admin/tasks");
    unmount();

    navigationMock.pathname = "/my-books";
    const parentService = makeMockService(
      makeFeed([], {
        actor_id: "parent-a",
        actor_role: "parent",
        portal: "parent",
      }),
    );

    render(
      <AiTaskCenterProvider
        actorId="parent-a"
        actorRole="parent"
        service={parentService}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    await waitFor(() =>
      expect(parentService.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ portal: "parent" }),
      ),
    );
    fireEvent.click(screen.getByTestId("global-task-center-trigger"));
    const parentPanel = await screen.findByTestId("global-task-center-panel");
    expect(parentPanel).toHaveTextContent("Tác vụ AI của tôi");
    expect(parentPanel).toHaveTextContent("Không gian phụ huynh (riêng bạn)");
    expect(parentPanel).not.toHaveTextContent("Tác vụ AI quản trị");
    expect(
      within(parentPanel).getByTestId("global-task-center-full-page-link"),
    ).toHaveAttribute("href", "/studio/tasks");
  });

  it("removes cross-role filters on StudioTasksPageScreen and strictly binds book/page links to viewMode", async () => {
    const adminTask = makeTask({
      id: "task-admin-only",
      actor_id: "admin-1",
      actor_role: "admin",
      portal: "admin",
      book_id: "book-admin-1",
      book_page_id: "page-admin-1",
      book_title: "Sách Danh Mục Quản Trị",
      result_href: null,
    });
    const leakedParentTask = makeTask({
      id: "task-leaked-parent",
      actor_id: "parent-a",
      actor_role: "parent",
      portal: "parent",
      book_id: "book-parent-1",
      book_title: "Sách Riêng Phụ Huynh A",
    });

    const service = makeMockService(
      makeFeed([adminTask, leakedParentTask], {
        actor_id: "admin-1",
        actor_role: "admin",
        portal: "admin",
      }),
    );

    render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        service={service}
      >
        <StudioTasksPageScreen viewMode="admin" />
      </AiTaskCenterProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText(/Sách Danh Mục Quản Trị/)).toBeInTheDocument(),
    );
    // Cross-role filter controls MUST NOT exist!
    expect(screen.queryByText("Tất cả vai trò")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Phụ huynh" }),
    ).not.toBeInTheDocument();
    // Leaked parent task MUST NOT render!
    expect(
      screen.queryByText(/Sách Riêng Phụ Huynh A/),
    ).not.toBeInTheDocument();

    const openBookLink = screen.getByRole("link", { name: "Mở sách" });
    expect(openBookLink).toHaveAttribute("href", "/admin/books/book-admin-1");

    const openPageLink = screen.getByRole("link", { name: "Mở trang" });
    expect(openPageLink).toHaveAttribute(
      "href",
      "/admin/books/book-admin-1/pages/page-admin-1",
    );
  });

  it("ignores cross-portal STUDIO_TASKS_CHANGED events and wipes tasks on cross-tab actor switch broadcast", async () => {
    const service = makeMockService(
      makeFeed([makeTask({ id: "parent-job-1", book_title: "Sách Nhà A" })], {
        actor_id: "parent-a",
        actor_role: "parent",
        portal: "parent",
      }),
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
    expect(getCachedGlobalTasksSnapshot("parent-a", "parent")).not.toBeNull();

    // Admin task event must NOT refresh a Parent provider
    await act(async () => {
      emitStudioTasksChanged({ portal: "admin", actorId: "admin-1" });
    });
    expect(service.listTasks).toHaveBeenCalledTimes(1);

    // Cross-tab actor switch event wipes in-memory cache immediately
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: ACTOR_SWITCH_BROADCAST_KEY,
          newValue: String(Date.now()),
        }),
      );
    });
    expect(getCachedGlobalTasksSnapshot("parent-a", "parent")).toBeNull();
  });

  it("isolates book scanner sessionStorage job IDs per user and clears legacy unscoped keys", () => {
    window.sessionStorage.setItem(
      "viread:book-scanner:last-job-id",
      "legacy-job",
    );
    writeStoredScanJobId("parent-a", "job-of-a");
    expect(
      window.sessionStorage.getItem("viread:book-scanner:last-job-id"),
    ).toBeNull();

    expect(readStoredScanJobId("parent-a")).toBe("job-of-a");
    expect(readStoredScanJobId("parent-b")).toBeNull();

    clearStoredScanJobIds("parent-b");
    expect(readStoredScanJobId("parent-a")).toBeNull();
  });

  it("never caches /studio/tasks endpoints in api read-cache and clears upload sessions on actor switch", async () => {
    expect(isCacheableApiGetPath("/studio/admin/tasks?limit=10")).toBe(false);
    expect(isCacheableApiGetPath("/studio/parent/tasks?limit=10")).toBe(false);
    expect(isCacheableApiGetPath("/studio/tasks?limit=10")).toBe(false);

    const adminService = makeMockService(
      makeFeed(
        [
          makeTask({
            id: "admin-upload-1",
            source: "ocr_inference_job",
            job_type: "OCR_EXTRACT",
            book_id: "book-shared-id",
            actor_id: "admin-a",
            actor_role: "admin",
            portal: "admin",
          }),
        ],
        { actor_id: "admin-a", actor_role: "admin", portal: "admin" },
      ),
    );

    await rehydrateAdminBookUploadTasks("book-shared-id", {
      actorId: "admin-a",
      service: adminService,
    });
    expect(
      getAdminBookUploadSession("book-shared-id", "admin-a").serverTasks,
    ).toHaveLength(1);
    expect(
      getAdminBookUploadSession("book-shared-id", "admin-b").serverTasks,
    ).toHaveLength(0);

    // Actor switch clears upload sessions via registered cache reset listener
    resetApiReadCacheForActorSwitch();
    expect(
      getAdminBookUploadSession("book-shared-id", "admin-a").serverTasks,
    ).toHaveLength(0);
  });

  it("does not trigger an infinite refresh loop when StudioTasksPageScreen mounts inside AiTaskCenterProvider", async () => {
    const adminTask = makeTask({
      id: "task-single-refresh",
      actor_id: "admin-1",
      actor_role: "admin",
      portal: "admin",
      status: "SUCCEEDED",
      status_label_vi: "Hoàn thành",
      progress_pct: 100,
    });
    const service = makeMockService(
      makeFeed([adminTask], {
        actor_id: "admin-1",
        actor_role: "admin",
        portal: "admin",
        active_count: 0,
      }),
    );

    render(
      <AiTaskCenterProvider
        actorId="admin-1"
        actorRole="admin"
        autoSyncOnMount={false}
        service={service}
      >
        <StudioTasksPageScreen viewMode="admin" />
      </AiTaskCenterProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("studio-task-row-task-single-refresh"),
      ).toBeInTheDocument(),
    );
    // Allow any chained effects/timers to settle; listTasks MUST be called once, never looping!
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(service.listTasks).toHaveBeenCalledTimes(1);
  });

  it("hides progress bars for CANCELLED/STALE tasks and renders non-zero warning progress for PARTIAL_SUCCESS", async () => {
    const cancelledTask = makeTask({
      id: "task-cancelled",
      actor_id: "parent-a",
      actor_role: "parent",
      portal: "parent",
      status: "CANCELLED",
      status_label_vi: "Đã hủy",
      progress_pct: 0,
    });
    const staleTask = makeTask({
      id: "task-stale",
      actor_id: "parent-a",
      actor_role: "parent",
      portal: "parent",
      status: "STALE",
      status_label_vi: "Cũ",
      progress_pct: 0,
    });
    const partialTask = makeTask({
      id: "task-partial",
      actor_id: "parent-a",
      actor_role: "parent",
      portal: "parent",
      status: "PARTIAL_SUCCESS",
      status_label_vi: "Hoàn tất một phần",
      progress_pct: 85,
    });

    const service = makeMockService(
      makeFeed([cancelledTask, staleTask, partialTask], {
        actor_id: "parent-a",
        actor_role: "parent",
        portal: "parent",
        active_count: 0,
      }),
    );

    navigationMock.pathname = "/my-books";
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
    await waitFor(() => expect(service.listTasks).toHaveBeenCalledTimes(1));
    fireEvent.click(trigger);

    const partialProgress = await screen.findByTestId(
      "task-progress-task-partial",
    );
    expect(
      screen.queryByTestId("task-progress-task-cancelled"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("task-progress-task-stale"),
    ).not.toBeInTheDocument();
    expect(partialProgress).toHaveTextContent("85%");
    expect(within(partialProgress).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "85",
    );
  });
});
