import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminBookDetailScreen } from "@/components/admin/admin-book-detail-screen";
import { AdminPageUploader } from "@/components/admin/admin-page-uploader";
import {
  AdminServicesContext,
  AdminServicesProvider,
  type AdminServices,
} from "@/components/providers/admin-services-provider";
import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";
import { GlobalTaskCenter } from "@/components/tasks/global-task-center";
import {
  AdminOcrJobQueuedSignal,
  cancelAdminOcrJob,
  createAdminPageService,
  pollAdminBookOcrJobsBatch,
  retryAdminOcrJob,
  type AdminOcrJobDTO,
} from "@/lib/api/admin-page-service";
import {
  clearGlobalTasksMemoryCache,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import { createRevisionService } from "@/lib/api/revision-service";
import { resetTaskAlertAckMemoryCache } from "@/lib/tasks/task-alert-acknowledgment";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import type { AdminBookDTO, AdminPageListItemUI } from "@/types/admin";
import type { GlobalTaskListResponse } from "@/types/global-tasks";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/books",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "admin-offline-ocr-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const BOOK_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const REV_1_ID = "33333333-3333-4333-8333-333333333333";
const JOB_QUEUE_1 = "44444444-4444-4444-8444-444444444444";
const JOB_DEAD_1 = "55555555-5555-4555-8555-555555555555";
const TIMESTAMP = "2026-11-27T09:30:00Z";

function makePageFile(name = "page-1.png", type = "image/png") {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, {
    type,
  });
}

const bookFixture: AdminBookDTO = {
  id: BOOK_ID,
  title: "Tiếng Việt Lớp 1",
  name: "Tập 1",
  author: "ViRead",
  min_grade: 1,
  max_grade: 1,
  lifecycle_status: "ACTIVE",
};

const existingPageFixture: AdminPageListItemUI = {
  book_id: BOOK_ID,
  page_number: 1,
  processing: {
    page_id: PAGE_ID,
    page_revision_id: REV_1_ID,
    revision_no: 1,
    verification_status: "NEEDS_REVIEW",
    lifecycle_status: "ACTIVE",
    ocr_preview_metadata: {},
    verified_at: null,
    current_verified_revision_id: null,
  },
  text_preview: "Trang một",
};

beforeEach(() => {
  installApiFetchFixture();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Admin offline OCR API & UI hardening", () => {
  it("emits QUEUED_OFFLINE, early-exits batch polling, and dispatches viread:tasks-changed on enqueue/cancel/retry/reprocess", async () => {
    let batchListCalls = 0;
    const tasksChangedSpy = vi.fn();
    window.addEventListener("viread:tasks-changed", tasksChangedSpy);

    apiFetchFixture.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = (init?.method ?? "GET").toUpperCase();

      if (
        path === `/books/admin/catalog/${BOOK_ID}/documents/jobs` &&
        method === "POST"
      ) {
        return Response.json(
          {
            book_id: BOOK_ID,
            source_format: "PDF",
            total_source_pages: 2,
            job_ids: ["doc-j1", "doc-j2"],
            queued_count: 2,
            worker_online: false,
          },
          { status: 202 },
        );
      }
      if (
        path === `/books/admin/catalog/${BOOK_ID}/pages/jobs` &&
        method === "POST"
      ) {
        return Response.json(
          {
            id: JOB_QUEUE_1,
            job_kind: "ADMIN_PAGE_UPLOAD",
            status: "QUEUED",
            book_id: BOOK_ID,
            worker_online: false,
          },
          { status: 202 },
        );
      }
      if (
        path === `/books/admin/catalog/${BOOK_ID}/ocr-jobs` &&
        method === "GET"
      ) {
        batchListCalls += 1;
        return Response.json([
          {
            id: "doc-j1",
            job_kind: "ADMIN_PAGE_UPLOAD",
            status: "QUEUED",
            worker_online: false,
          },
          {
            id: "doc-j2",
            job_kind: "ADMIN_PAGE_UPLOAD",
            status: "FAILED_RETRYABLE",
            worker_online: false,
          },
        ]);
      }
      if (path === `/books/admin/catalog/${BOOK_ID}/pages`) {
        return Response.json([]);
      }
      if (
        path === `/books/admin/ocr-jobs/${JOB_QUEUE_1}` &&
        method === "DELETE"
      ) {
        return Response.json({
          id: JOB_QUEUE_1,
          job_kind: "ADMIN_PAGE_UPLOAD",
          status: "CANCELLED",
        });
      }
      if (
        path === `/books/admin/ocr-jobs/${JOB_DEAD_1}/retry` &&
        method === "POST"
      ) {
        return Response.json({
          id: JOB_DEAD_1,
          job_kind: "ADMIN_PAGE_UPLOAD",
          status: "QUEUED",
          worker_online: false,
        });
      }
      if (
        path === `/books/admin/pages/${PAGE_ID}/reprocess/jobs` &&
        method === "POST"
      ) {
        return Response.json(
          {
            id: "reproc-1",
            job_kind: "ADMIN_PAGE_REPROCESS",
            status: "QUEUED",
            book_id: BOOK_ID,
            page_id: PAGE_ID,
            worker_online: false,
          },
          { status: 202 },
        );
      }
      throw new Error(`Unexpected API call: ${method} ${path}`);
    });

    const pageSvc = createAdminPageService({
      pollIntervalMs: 5,
      maxPollAttempts: 60,
    });
    const progressEvents: Array<{
      status: string;
      queued_offline?: boolean;
      progress_percent: number;
    }> = [];

    const pdfFile = new File(["%PDF-1.4"], "sach.pdf", {
      type: "application/pdf",
    });
    await pageSvc.upload(
      BOOK_ID,
      [
        {
          client_id: "doc-1",
          file_name: "sach.pdf",
          mime_type: "application/pdf",
          size_bytes: pdfFile.size,
          upload_kind: "document",
          file: pdfFile,
        },
        {
          client_id: "img-1",
          file_name: "trang.png",
          mime_type: "image/png",
          size_bytes: 16,
          upload_kind: "image",
          file: makePageFile("trang.png"),
        },
      ],
      (p) => progressEvents.push(p),
    );

    const offlineEvents = progressEvents.filter(
      (e) => e.status === "QUEUED_OFFLINE",
    );
    expect(offlineEvents).toHaveLength(2);
    expect(offlineEvents.every((e) => e.queued_offline === true)).toBe(true);

    // pollAdminBookOcrJobsBatch early-exits cleanly on offline queued jobs (no 60-poll hang!)
    const settledBatch = await pollAdminBookOcrJobsBatch(
      BOOK_ID,
      [
        {
          id: "doc-j1",
          job_kind: "ADMIN_PAGE_UPLOAD",
          status: "QUEUED",
          worker_online: false,
        },
        {
          id: "doc-j2",
          job_kind: "ADMIN_PAGE_UPLOAD",
          status: "FAILED_RETRYABLE",
          worker_online: false,
        },
      ],
      { pollIntervalMs: 5, maxAttempts: 60 },
    );
    expect(settledBatch).toHaveLength(2);
    expect(batchListCalls).toBe(0);

    await cancelAdminOcrJob(JOB_QUEUE_1);
    await retryAdminOcrJob(JOB_DEAD_1);

    const revSvc = createRevisionService({
      pollIntervalMs: 5,
      maxPollAttempts: 5,
    });
    await expect(revSvc.reprocess(PAGE_ID)).rejects.toBeInstanceOf(
      AdminOcrJobQueuedSignal,
    );

    expect(tasksChangedSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
    window.removeEventListener("viread:tasks-changed", tasksChangedSpy);
  });

  it("AdminPageUploader updates offline CTA and renders amber QUEUED_OFFLINE badge without 100%", async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 800, height: 1000, close: vi.fn() })),
    );

    apiFetchFixture.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/health") {
        return Response.json({
          status: "ok",
          ocr: { mode: "remote_worker", ready: false },
        });
      }
      if (
        path === `/books/admin/catalog/${BOOK_ID}/pages/jobs` &&
        method === "POST"
      ) {
        return Response.json(
          {
            id: JOB_QUEUE_1,
            job_kind: "ADMIN_PAGE_UPLOAD",
            status: "QUEUED",
            book_id: BOOK_ID,
            worker_online: false,
          },
          { status: 202 },
        );
      }
      if (
        path === `/books/admin/catalog/${BOOK_ID}/pages` &&
        method === "GET"
      ) {
        return Response.json([]);
      }
      throw new Error(`Unexpected API call: ${method} ${path}`);
    });

    render(
      <AdminServicesProvider>
        <AdminPageUploader bookId={BOOK_ID} onUploaded={vi.fn()} />
      </AdminServicesProvider>,
    );

    expect(
      await screen.findByTestId("admin-ocr-worker-offline-banner"),
    ).toBeInTheDocument();

    const submitBtn = screen.getByRole("button", {
      name: /Tải lên & đưa vào hàng chờ OCR/i,
    });
    expect(submitBtn).toBeInTheDocument();

    const fileInput = document.getElementById(
      "page-images",
    ) as HTMLInputElement;
    await user.upload(fileInput, makePageFile("offline-page.png"));
    await user.click(submitBtn);

    expect(
      await screen.findByText(/Đã đưa vào hàng chờ OCR/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
  });

  it("AdminBookDetailScreen shows top offline banner even when uploader collapsed, includes pendingNewPageJobs in KPI, supports cancel/retry/DEAD_LETTER, and smooth queued reupload", async () => {
    const user = userEvent.setup();

    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") {
        return Response.json({
          status: "ok",
          ocr: { mode: "remote_worker", ready: false },
        });
      }
      return Response.json({}, { status: 404 });
    });

    let currentJobs: AdminOcrJobDTO[] = [
      {
        id: JOB_QUEUE_1,
        job_kind: "ADMIN_PAGE_UPLOAD",
        status: "QUEUED",
        book_id: BOOK_ID,
        page_id: null,
        file_name: "trang-moi-2.png",
        queue_position: 3,
        worker_online: false,
        created_at: TIMESTAMP,
      },
      {
        id: JOB_DEAD_1,
        job_kind: "ADMIN_PAGE_UPLOAD",
        status: "DEAD_LETTER",
        book_id: BOOK_ID,
        page_id: null,
        file_name: "trang-loi.png",
        error_message: "Ảnh quá mờ, không đọc được chữ.",
        created_at: TIMESTAMP,
      },
    ];

    const cancelOcrJob = vi.fn(async (jobId: string) => {
      currentJobs = currentJobs.filter((j) => j.id !== jobId);
      return {
        id: jobId,
        job_kind: "ADMIN_PAGE_UPLOAD",
        status: "CANCELLED" as const,
      };
    });
    const retryOcrJob = vi.fn(async (jobId: string) => {
      currentJobs = currentJobs.map((j) =>
        j.id === jobId
          ? { ...j, status: "QUEUED" as const, worker_online: false }
          : j,
      );
      return {
        id: jobId,
        job_kind: "ADMIN_PAGE_UPLOAD",
        status: "QUEUED" as const,
      };
    });
    const booksGet = vi.fn(async () => bookFixture);
    const pagesList = vi.fn(async () => [existingPageFixture]);
    const listOcrJobs = vi.fn(async () => currentJobs);
    const getImage = vi.fn(async () => ({
      page_id: PAGE_ID,
      page_revision_id: REV_1_ID,
      page_number: 1,
      preview_url: "https://example.com/p1.png",
      width: 600,
      height: 800,
    }));
    const replaceImageAndReprocess = vi.fn(async () => {
      throw new AdminOcrJobQueuedSignal(
        {
          id: "reupload-queued-1",
          job_kind: "ADMIN_PAGE_REUPLOAD",
          status: "QUEUED",
          book_id: BOOK_ID,
          page_id: PAGE_ID,
          worker_online: false,
        },
        "Đã lưu trang trong hàng chờ — Tự động xử lý ngay khi dịch vụ nhận diện chữ hoạt động lại",
      );
    });

    const services = {
      books: {
        list: vi.fn(async () => []),
        get: booksGet,
        create: vi.fn(),
        update: vi.fn(),
        retire: vi.fn(),
      },
      pages: {
        list: pagesList,
        listOcrJobs,
        cancelOcrJob,
        retryOcrJob,
        getImage,
        replaceImageAndReprocess,
        upload: vi.fn(),
        reload: vi.fn(),
        updateStatus: vi.fn(),
        retire: vi.fn(),
      },
    } as unknown as AdminServices;

    render(
      <AdminServicesContext.Provider value={services}>
        <AdminBookDetailScreen bookId={BOOK_ID} />
      </AdminServicesContext.Provider>,
    );

    // Top offline banner mounts even when uploader is collapsed
    const banners = await screen.findAllByTestId(
      "admin-ocr-worker-offline-banner",
    );
    expect(banners).toHaveLength(1);

    // KPI count includes pendingNewPageJobs.length (0 processing + 1 pendingNewPage = 1)
    expect(
      screen.getByTestId("admin-book-kpi-processing-count"),
    ).toHaveTextContent("1");

    // Queued new page shows file_name, #queue_position, and cancel button
    const queuedRow = screen.getByTestId(
      `admin-queued-new-page-row-${JOB_QUEUE_1}`,
    );
    expect(queuedRow).toHaveTextContent("trang-moi-2.png");
    expect(queuedRow).toHaveTextContent("#3");

    // DEAD_LETTER panel shows error_message + Retry OCR + Cancel
    const deadLetterPanel = screen.getByTestId(
      "admin-book-ocr-dead-letter-panel",
    );
    expect(deadLetterPanel).toHaveTextContent("trang-loi.png");
    expect(deadLetterPanel).toHaveTextContent(
      "Ảnh quá mờ, không đọc được chữ.",
    );

    // Retry DEAD_LETTER job
    await user.click(screen.getByTestId(`retry-dead-letter-job-${JOB_DEAD_1}`));
    expect(retryOcrJob).toHaveBeenCalledWith(JOB_DEAD_1);
    await waitFor(() => {
      expect(
        screen.queryByTestId("admin-book-ocr-dead-letter-panel"),
      ).not.toBeInTheDocument();
    });

    // Cancel queued new-page job
    await user.click(
      screen.getByTestId(`cancel-queued-ocr-job-${JOB_QUEUE_1}`),
    );
    expect(cancelOcrJob).toHaveBeenCalledWith(JOB_QUEUE_1);

    // Offline page image reupload preserves queued message and calls refreshPages() without full load()
    const booksGetCountBefore = booksGet.mock.calls.length;
    await user.click(
      screen.getByRole("button", { name: /Xem ảnh \/ thay ảnh trang 1/i }),
    );
    await user.upload(
      screen.getByLabelText(/Chọn ảnh mới cho trang 1/i),
      makePageFile("replacement.png"),
    );
    await user.click(screen.getByRole("button", { name: /Thay ảnh trang 1/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Ảnh mới đã vào hàng chờ OCR/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/Ảnh mới đang chờ duyệt/i),
    ).not.toBeInTheDocument();
    expect(booksGet.mock.calls.length).toBe(booksGetCountBefore);
  });

  it("clears the sidebar GlobalTaskCenter FAILED warning immediately when Admin retries a DEAD_LETTER OCR job directly on AdminBookDetailScreen", async () => {
    const user = userEvent.setup();
    clearGlobalTasksMemoryCache();
    resetTaskAlertAckMemoryCache();
    window.localStorage.clear();

    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") {
        return Response.json({
          status: "ok",
          ocr: { mode: "remote_worker", ready: true },
        });
      }
      return Response.json({}, { status: 404 });
    });

    let currentJobs: AdminOcrJobDTO[] = [
      {
        id: JOB_DEAD_1,
        job_kind: "ADMIN_PAGE_UPLOAD",
        status: "DEAD_LETTER",
        book_id: BOOK_ID,
        file_name: "trang-loi.png",
        error_message: "Ảnh quá mờ, không đọc được chữ.",
        worker_online: true,
      },
    ];

    const failedTaskFeed: GlobalTaskListResponse = {
      actor_id: "admin-direct",
      actor_role: "admin",
      portal: "admin",
      active_count: 0,
      waiting_review_count: 0,
      failed_count: 1,
      completed_count: 0,
      worker_online: true,
      recommended_poll_ms: null,
      tasks: [
        {
          id: JOB_DEAD_1,
          source: "ocr_inference_job",
          job_type: "ADMIN_PAGE_UPLOAD",
          title_vi: "Nhận diện chữ OCR",
          book_id: BOOK_ID,
          book_page_id: null,
          book_title: bookFixture.title,
          page_number: null,
          source_revision_id: null,
          actor_id: "admin-direct",
          actor_role: "admin",
          portal: "admin",
          status: "FAILED",
          status_label_vi: "Xử lý thất bại",
          stage: "OCR",
          stage_label_vi: "Gặp lỗi",
          priority: 50,
          attempt_count: 3,
          max_attempts: 3,
          progress_completed: null,
          progress_total: null,
          progress_unit: null,
          progress_pct: 0,
          is_indeterminate: false,
          can_retry: false,
          can_cancel: false,
          result_href: `/admin/books/${BOOK_ID}`,
          result_ref: {},
          checkpoints: {},
          error_code: "OCR_FAILED",
          error_message_vi: "Ảnh quá mờ, không đọc được chữ.",
          created_at: "2026-11-28T08:00:00Z",
          updated_at: "2026-11-28T08:00:00Z",
          started_at: "2026-11-28T08:00:00Z",
          completed_at: "2026-11-28T08:00:00Z",
        },
      ],
    };

    const taskService: GlobalTasksService = {
      listTasks: vi.fn(async () => failedTaskFeed),
      createTask: vi.fn(),
      retryTask: vi.fn(),
      cancelTask: vi.fn(),
      getCapabilities: vi.fn(),
    };

    const retryOcrJob = vi.fn(async (jobId: string) => {
      currentJobs = [];
      return {
        id: jobId,
        job_kind: "ADMIN_PAGE_UPLOAD",
        status: "QUEUED" as const,
      };
    });

    const services = {
      books: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => bookFixture),
        create: vi.fn(),
        update: vi.fn(),
        retire: vi.fn(),
      },
      pages: {
        list: vi.fn(async () => [existingPageFixture]),
        listOcrJobs: vi.fn(async () => currentJobs),
        cancelOcrJob: vi.fn(),
        retryOcrJob,
        getImage: vi.fn(),
        replaceImageAndReprocess: vi.fn(),
        upload: vi.fn(),
        reload: vi.fn(),
        updateStatus: vi.fn(),
        retire: vi.fn(),
      },
    } as unknown as AdminServices;

    render(
      <AiTaskCenterProvider
        actorId="admin-direct"
        actorRole="admin"
        service={taskService}
      >
        <GlobalTaskCenter variant="sidebar" />
        <AdminServicesContext.Provider value={services}>
          <AdminBookDetailScreen bookId={BOOK_ID} />
        </AdminServicesContext.Provider>
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ lỗi (1)"));

    // Admin retries the failed OCR job directly on the book detail page (without opening the drawer).
    await user.click(
      await screen.findByTestId(`retry-dead-letter-job-${JOB_DEAD_1}`),
    );
    expect(retryOcrJob).toHaveBeenCalledWith(JOB_DEAD_1);

    // Sidebar AI task bar immediately clears the stale FAILED warning!
    await waitFor(() => expect(trigger).toHaveTextContent("Tác vụ AI"));
    expect(
      screen.queryByTestId("global-task-center-sidebar-count"),
    ).not.toBeInTheDocument();
  });
});
