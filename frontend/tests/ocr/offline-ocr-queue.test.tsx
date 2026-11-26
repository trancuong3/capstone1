import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminBookDetailScreen } from "@/components/admin/admin-book-detail-screen";
import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
import { ParentPrivateBookManager } from "@/components/books/parent-private-book-manager";
import {
  AdminServicesContext,
  type AdminServices,
} from "@/components/providers/admin-services-provider";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";
import { GlobalTaskCenter } from "@/components/tasks/global-task-center";
import {
  AdminOcrJobQueuedSignal,
  createAdminPageService,
  type AdminOcrJobDTO,
} from "@/lib/api/admin-page-service";
import {
  clearGlobalTasksMemoryCache,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import { createRevisionService } from "@/lib/api/revision-service";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import type {
  AdminBookDTO,
  AdminPageListItemUI,
  AdminPageRevisionDetailDTO,
} from "@/types/admin";
import type {
  GlobalTaskItem,
  GlobalTaskListResponse,
} from "@/types/global-tasks";
import type { ParentPrivateBookDetailDTO } from "@/types/parent-private-book";

const { pushMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
    refresh: vi.fn(),
  }),
  usePathname: () => "/book-scanner",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "offline-ocr-queue-token" } },
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
const REV_2_ID = "44444444-4444-4444-8444-444444444444";
const SCAN_JOB_ID = "55555555-5555-4555-8555-555555555555";
const ADMIN_JOB_1_ID = "66666666-6666-4666-8666-666666666666";
const ADMIN_JOB_2_ID = "77777777-7777-4777-8777-777777777777";
const TIMESTAMP = "2026-11-26T10:15:00Z";

function makePageFile(name = "trang-1.png", type = "image/png") {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, {
    type,
  });
}

const completedScanResult = {
  scan_job_id: SCAN_JOB_ID,
  request_id: "req-offline-recovery-01",
  idempotency_key: null,
  status: "SUCCEEDED" as const,
  ocr_text: "Chú mèo con chạy ra sân đón nắng mai.",
  word_count: 9,
  words: [
    {
      word_index: 0,
      line_index: 0,
      text: "Chú",
      normalized_text: "chú",
      bbox: [0.1, 0.1, 0.1, 0.05] as [number, number, number, number],
      ocr_confidence: 0.99,
    },
  ],
  provenance: {
    engine: "paddleocr_vietocr_dual",
    device: "cuda" as const,
    engine_statuses: {
      paddleocr: "success",
      vietocr: "success",
      tesseract: "success",
    },
    model_profile: "FLOW1_EXTERNAL_TRDG",
    checkpoint_sha256: "abc123",
    model_load_status: "loaded",
    cloud_ocr_used: false,
    elapsed_ms: 1500,
  },
  matched: false,
  matched_book_id: null,
  matched_book_title: null,
  match_confidence: 0,
  matched_page: null,
  message: "Đã nhận diện văn bản tiếng Việt.",
};

beforeEach(() => {
  installApiFetchFixture();
  pushMock.mockReset();
  replaceMock.mockReset();
  window.sessionStorage.clear();
  clearGlobalTasksMemoryCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Offline OCR worker durable queueing across Parent, Admin, and Global Task Center", () => {
  it("Flow 1: BookScannerScreen queues offline without erroring, preserves job across reload without cancelling, and displays OCR result when worker returns", async () => {
    const user = userEvent.setup();
    let workerOnline = false;
    let jobCompleted = false;
    let cancelCalls = 0;
    let pollCalls = 0;

    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = (init?.method ?? "GET").toUpperCase();

      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/health") {
        return Response.json({
          status: "ok",
          ocr: {
            mode: "remote_worker",
            ready: workerOnline,
            workers: workerOnline ? [{ worker_id: "win-1", online: true }] : [],
            queue: { queued: jobCompleted ? 0 : 1 },
          },
        });
      }
      if (path === "/reading/scan-page-ocr/jobs" && method === "GET") {
        return Response.json({
          worker_online: workerOnline,
          jobs:
            pollCalls > 0 && !jobCompleted
              ? [
                  {
                    job_id: SCAN_JOB_ID,
                    status: "QUEUED",
                    worker_online: workerOnline,
                    created_at: TIMESTAMP,
                    updated_at: TIMESTAMP,
                    file_name: "trang-1.png",
                    queue_position: 1,
                    error_code: null,
                    error_message: null,
                    result: null,
                  },
                ]
              : [],
        });
      }
      if (path === "/reading/scan-page-ocr/jobs" && method === "POST") {
        pollCalls += 1;
        return Response.json(
          {
            job_id: SCAN_JOB_ID,
            status: "QUEUED",
            worker_online: false,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
            file_name: "trang-1.png",
            queue_position: 1,
            error_code: null,
            error_message: null,
            result: null,
          },
          { status: 202 },
        );
      }
      if (
        path === `/reading/scan-page-ocr/jobs/${SCAN_JOB_ID}` &&
        method === "GET"
      ) {
        pollCalls += 1;
        return Response.json({
          job_id: SCAN_JOB_ID,
          status: jobCompleted ? "SUCCEEDED" : "QUEUED",
          worker_online: workerOnline,
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
          file_name: "trang-1.png",
          queue_position: jobCompleted ? null : 1,
          error_code: null,
          error_message: null,
          result: jobCompleted ? completedScanResult : null,
        });
      }
      if (
        path === `/reading/scan-page-ocr/jobs/${SCAN_JOB_ID}` &&
        method === "DELETE"
      ) {
        cancelCalls += 1;
        return Response.json({
          job_id: SCAN_JOB_ID,
          status: "CANCELLED",
          worker_online: workerOnline,
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
          file_name: "trang-1.png",
          queue_position: null,
          error_code: null,
          error_message: null,
          result: null,
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    const firstRender = render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <BookScannerScreen />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    // 1. Offline top banner reassures parents they can still capture/upload into queue
    const banner = await screen.findByTestId("ocr-worker-offline-banner");
    expect(banner).toHaveTextContent(/Máy chủ OCR đang tạm tắt/i);
    expect(banner).toHaveTextContent(/lưu sẵn vào hàng chờ/i);

    // 2. Upload page while worker is offline -> calm queued card with queue position & actions
    const input = screen.getByTestId(
      "local-ocr-file-input",
    ) as HTMLInputElement;
    await user.upload(input, makePageFile("trang-1.png"));

    const queuedCard = await screen.findByTestId("async-ocr-job-card");
    expect(queuedCard).toHaveTextContent(
      /Đã lưu trang sách trong hàng chờ OCR/i,
    );
    expect(screen.getByTestId("ocr-queue-position")).toHaveTextContent("#1");
    expect(screen.getByTestId("check-queued-ocr-now")).toBeInTheDocument();
    expect(screen.getByTestId("scan-another-while-queued")).toBeInTheDocument();
    expect(screen.getByTestId("cancel-queued-ocr-job")).toBeInTheDocument();

    // 3. Unmount (simulate leaving/reloading page) -> MUST NOT cancel the queued job!
    firstRender.unmount();
    expect(cancelCalls).toBe(0);

    // 4. Remount -> restores queued job from GET /reading/scan-page-ocr/jobs?active_only=true
    render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <BookScannerScreen />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    expect(await screen.findByTestId("async-ocr-job-card")).toHaveTextContent(
      /Đã lưu trang sách trong hàng chờ OCR/i,
    );

    // 5. Simulate laptop turning back on and completing the OCR job -> click "Kiểm tra lại ngay"
    workerOnline = true;
    jobCompleted = true;
    await user.click(screen.getByTestId("check-queued-ocr-now"));

    expect(await screen.findByTestId("local-ocr-text")).toHaveTextContent(
      "Chú mèo con chạy ra sân đón nắng mai.",
    );
    expect(cancelCalls).toBe(0);
  });

  it("Flow 2: ParentPrivateBookManager displays distinct offline queued badge/banner and uses gentle >=12s polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let workerOnline = false;
    let submissionDone = false;
    let detailFetches = 0;

    const SUB_ID = "99999999-9999-4999-8999-999999999999";
    const BATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const HASH_DONE = "1".repeat(64);

    const buildDetail = (): ParentPrivateBookDetailDTO => ({
      book: {
        id: BOOK_ID,
        title: "Truyện Gia Đình Bé An",
        author: "Ba Mẹ",
        min_grade: 1,
        max_grade: 2,
        lifecycle_status: "ACTIVE",
        visibility_scope: "PARENT_PRIVATE",
        moderation_status: "ACTIVE",
        suspended_reason: null,
        source_declaration: "Sách giấy gia đình mua",
        committed_page_count: 0,
        pending_submission_count: submissionDone ? 0 : 1,
        flagged_submission_count: 0,
        failed_submission_count: 0,
        ready_to_add_count: submissionDone ? 1 : 0,
        readable_for_children: false,
        has_held_multipage_batch: false,
        privacy_notice: "Sách riêng của gia đình.",
        created_at: TIMESTAMP,
      },
      pages: [],
      submissions: [
        {
          id: SUB_ID,
          book_id: BOOK_ID,
          batch_id: BATCH_ID,
          batch_total_pages: 1,
          source_page_number: 1,
          target_page_number: 1,
          source_file_name: "trang-1.jpg",
          source_format: "IMAGE",
          image_width: 800,
          image_height: 1000,
          image_url: `http://127.0.0.1:8000/books/my-books/${BOOK_ID}/submissions/${SUB_ID}/image`,
          source_type: "OWNED_PHYSICAL_BOOK",
          source_type_label: "Sách giấy gia đình sở hữu",
          source_note: null,
          submission_version: 1,
          optimistic_lock_version: 1,
          workflow_status: submissionDone ? "PASSED_READY_TO_ADD" : "CHECKING",
          workflow_status_label: submissionDone
            ? "Sẵn sàng thêm vào sách"
            : "Đang kiểm tra…",
          ocr_status: submissionDone ? "COMPLETED" : "PENDING",
          ocr_text: submissionDone ? "Con mèo trèo cây cau." : null,
          ocr_error_code: null,
          is_image_only: false,
          proofread_status: submissionDone ? "COMPLETED" : "PENDING",
          proofread_text: submissionDone ? "Con mèo trèo cây cau." : null,
          proofread_suggestions: [],
          uncertain_word_indices: [],
          proofread_error_code: null,
          spelling_accepted: true,
          candidate_text: submissionDone ? "Con mèo trèo cây cau." : null,
          candidate_hash: submissionDone ? HASH_DONE : null,
          tool_check_status: submissionDone ? "PASSED" : "PENDING",
          tool_check_suitability: submissionDone ? "SUITABLE" : null,
          tool_check_scope: {
            modality: "TEXT_ONLY",
            covers_all_chunks: true,
            chunks_checked: 1,
            total_chunks: 1,
            image_visual_safety_checked: false,
            requires_admin_visual_review: false,
            copyright_scanner_status: "NOT_CONFIGURED",
            local_ai_enforced: true,
          },
          tool_check_findings_count: 0,
          tool_check_parent_notice: null,
          tool_check_policy_blocked: false,
          tool_check_workflow_id: null,
          tool_check_error_code: null,
          provider_events: [],
          can_add_to_book: submissionDone,
          can_request_admin_review: false,
          can_retry: false,
          admin_decision: null,
          admin_decision_reason: null,
          approved_snapshot_hash: null,
          approved_submission_version: null,
          committed_page_id: null,
          committed_revision_id: null,
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
        },
      ],
    });

    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") {
        return Response.json({
          status: "ok",
          ocr: {
            mode: "remote_worker",
            ready: workerOnline,
            workers: workerOnline ? [{ worker_id: "win-1", online: true }] : [],
            queue: { queued: submissionDone ? 0 : 1 },
          },
        });
      }
      if (path === `/books/my-books/${BOOK_ID}`) {
        detailFetches += 1;
        return Response.json(buildDetail());
      }
      if (path === `/books/my-books/${BOOK_ID}/assets`) {
        return Response.json({ book_id: BOOK_ID, assets: [] });
      }
      if (path === `/books/my-books/${BOOK_ID}/submissions/${SUB_ID}/image`) {
        return new Response(new Blob(["img"]), { status: 200 });
      }
      throw new Error(`Unexpected fetch path: ${path}`);
    });

    render(<ParentPrivateBookManager bookId={BOOK_ID} />);

    // Offline banner & distinct amber queued badge appear
    expect(
      await screen.findByTestId("private-book-worker-offline-notice"),
    ).toHaveTextContent(/Máy chủ OCR đang tạm tắt/i);
    expect(
      await screen.findByTestId("submission-queued-offline-badge"),
    ).toHaveTextContent(
      /Đã lưu trong hàng chờ OCR — Đang chờ máy chủ bật lại/i,
    );
    expect(
      screen.getByTestId("private-book-ocr-queue-banner"),
    ).toHaveTextContent(/Đã lưu trong hàng chờ OCR/i);

    const fetchesBeforeWait = detailFetches;
    // Advance 6s while offline -> MUST NOT spam a 3s poll tick!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(detailFetches).toBe(fetchesBeforeWait);

    // Laptop turns back on & finishes OCR -> next gentle 12s tick transitions cleanly!
    workerOnline = true;
    submissionDone = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("submission-queued-offline-badge"),
      ).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText(/Con mèo trèo cây cau/i),
    ).toBeInTheDocument();
  });

  it("Flow 3: Admin single upload, reupload, reprocess, BookDetailScreen, and OcrReviewScreen handle offline queued state cleanly without errors", async () => {
    // 3a. Single upload + reupload + reprocess services resolve/signal cleanly when worker_online=false (no 100-poll hang!)
    apiFetchFixture.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      if (
        path === `/books/admin/catalog/${BOOK_ID}/pages/jobs` &&
        method === "POST"
      ) {
        return Response.json(
          {
            id: ADMIN_JOB_1_ID,
            job_kind: "ADMIN_PAGE_UPLOAD",
            status: "QUEUED",
            book_id: BOOK_ID,
            page_id: PAGE_ID,
            worker_online: false,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
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
      if (
        path === `/books/admin/pages/${PAGE_ID}/reupload-ocr/jobs` &&
        method === "POST"
      ) {
        return Response.json(
          {
            id: ADMIN_JOB_2_ID,
            job_kind: "ADMIN_PAGE_REUPLOAD",
            status: "QUEUED",
            book_id: BOOK_ID,
            page_id: PAGE_ID,
            worker_online: false,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
          },
          { status: 202 },
        );
      }
      if (
        path === `/books/admin/pages/${PAGE_ID}/reprocess/jobs` &&
        method === "POST"
      ) {
        return Response.json(
          {
            id: ADMIN_JOB_2_ID,
            job_kind: "ADMIN_PAGE_REPROCESS",
            status: "QUEUED",
            book_id: BOOK_ID,
            page_id: PAGE_ID,
            worker_online: false,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
          },
          { status: 202 },
        );
      }
      throw new Error(`Unexpected Admin API call: ${method} ${path}`);
    });

    const pageSvc = createAdminPageService({
      pollIntervalMs: 10,
      maxPollAttempts: 5,
    });
    const progressLog: Array<{ status: string; summary_message?: string }> = [];
    await pageSvc.upload(
      BOOK_ID,
      [
        {
          client_id: "0-page.png",
          file_name: "page.png",
          mime_type: "image/png",
          size_bytes: 16,
          upload_kind: "image",
          file: makePageFile("page.png"),
        },
      ],
      (p) => progressLog.push(p),
    );
    expect(
      progressLog.some(
        (p) =>
          p.status === "PROCESSING" &&
          (p.summary_message ?? "").includes("hàng chờ OCR"),
      ),
    ).toBe(true);
    expect(progressLog.some((p) => p.status === "FAILED")).toBe(false);

    // Reupload emits typed AdminOcrJobQueuedSignal (NOT a 503 error!)
    await expect(
      pageSvc.replaceImageAndReprocess(PAGE_ID, makePageFile("new.png")),
    ).rejects.toBeInstanceOf(AdminOcrJobQueuedSignal);

    // Reprocess emits typed AdminOcrJobQueuedSignal (NOT a 503 error!)
    const revSvc = createRevisionService({
      pollIntervalMs: 10,
      maxPollAttempts: 5,
    });
    await expect(revSvc.reprocess(PAGE_ID)).rejects.toBeInstanceOf(
      AdminOcrJobQueuedSignal,
    );

    // 3b. AdminBookDetailScreen renders offline queued banner + per-page badges surviving reload
    const bookDto: AdminBookDTO = {
      id: BOOK_ID,
      title: "Tiếng Việt Lớp 2",
      name: "Tập 1",
      author: "ViRead",
      min_grade: 2,
      max_grade: 2,
      lifecycle_status: "ACTIVE",
    };
    const existingPage: AdminPageListItemUI = {
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
      text_preview: "Bầu trời xanh ngắt",
    };
    const queuedJobs: AdminOcrJobDTO[] = [
      {
        id: ADMIN_JOB_1_ID,
        job_kind: "ADMIN_PAGE_UPLOAD",
        status: "QUEUED",
        book_id: BOOK_ID,
        page_id: "88888888-8888-4888-8888-888888888888",
        worker_online: false,
      },
      {
        id: ADMIN_JOB_2_ID,
        job_kind: "ADMIN_PAGE_REPROCESS",
        status: "QUEUED",
        book_id: BOOK_ID,
        page_id: PAGE_ID,
        worker_online: false,
      },
    ];

    const detailServices = {
      books: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => bookDto),
        create: vi.fn(),
        update: vi.fn(),
        retire: vi.fn(),
      },
      pages: {
        list: vi.fn(async () => [existingPage]),
        listOcrJobs: vi.fn(async () => queuedJobs),
        getImage: vi.fn(),
        replaceImageAndReprocess: vi.fn(),
        upload: vi.fn(),
        reload: vi.fn(),
        updateStatus: vi.fn(),
        retire: vi.fn(),
      },
    } as unknown as AdminServices;

    render(
      <AdminServicesContext.Provider value={detailServices}>
        <AdminBookDetailScreen bookId={BOOK_ID} />
      </AdminServicesContext.Provider>,
    );

    const bookBanner = await screen.findByTestId("admin-book-ocr-queue-banner");
    expect(bookBanner).toHaveTextContent(
      /Đã lưu 2 trang trong hàng chờ OCR — Tự động xử lý ngay khi máy chủ OCR bật lại/i,
    );
    expect(screen.getByTestId("admin-queued-new-page-badge")).toHaveTextContent(
      /Trang mới #1/i,
    );
    expect(screen.getByTestId("admin-page-queued-ocr-badge")).toHaveTextContent(
      /Đã lưu trong hàng chờ OCR/i,
    );

    // 3c. AdminOcrReviewScreen restores queued job on mount & handles reprocess queued signal calmly (not error!)
    const revDetail: AdminPageRevisionDetailDTO = {
      page_id: PAGE_ID,
      page_revision_id: REV_1_ID,
      revision_no: 1,
      verification_status: "NEEDS_REVIEW",
      lifecycle_status: "ACTIVE",
      draft_text: "Bầu trời xanh ngắt",
      words: [
        {
          word_index: 0,
          line_index: 0,
          text: "Bầu",
          normalized_text: "bầu",
          bbox: [0.1, 0.1, 0.1, 0.05],
          ocr_confidence: 0.95,
        },
      ],
      ocr_metadata: {},
      created_at: TIMESTAMP,
      verified_at: null,
      verified_by: null,
    };

    const reviewServices = {
      books: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => bookDto),
        create: vi.fn(),
        update: vi.fn(),
        retire: vi.fn(),
      },
      pages: {
        list: vi.fn(async () => [existingPage]),
        listOcrJobs: vi.fn(async () => [queuedJobs[1]]),
        getImage: vi.fn(async () => ({
          page_id: PAGE_ID,
          page_revision_id: REV_1_ID,
          page_number: 1,
          preview_url: "https://example.com/page-1.png",
          width: 800,
          height: 1000,
        })),
        replaceImageAndReprocess: vi.fn(),
        upload: vi.fn(),
        reload: vi.fn(async () => existingPage.processing),
        updateStatus: vi.fn(),
        retire: vi.fn(),
      },
      ocr: {
        getRevision: vi.fn(async () => revDetail),
        saveDraft: vi.fn(),
        aiCorrectText: vi.fn(),
        runCombinedWorkflow: vi.fn(),
        getLatestWorkflow: vi.fn(async () => null),
        updateWorkflowCandidate: vi.fn(),
        decideWorkflowSafety: vi.fn(),
        decideWorkflowImageSafety: vi.fn(),
        retryWorkflow: vi.fn(),
      },
      revisions: {
        list: vi.fn(async () => [
          {
            page_revision_id: REV_1_ID,
            revision_no: 1,
            verification_status: "NEEDS_REVIEW",
            is_current_verified: false,
            created_at: TIMESTAMP,
            verified_at: null,
          },
        ]),
        createDraft: vi.fn(),
        verify: vi.fn(),
        reprocess: vi.fn(async () => {
          throw new AdminOcrJobQueuedSignal(
            queuedJobs[1],
            "Đã lưu yêu cầu chạy lại OCR trong hàng chờ — Tự động xử lý ngay khi máy chủ OCR bật lại",
          );
        }),
      },
    } as unknown as AdminServices;

    render(
      <AdminServicesContext.Provider value={reviewServices}>
        <AdminOcrReviewScreen bookId={BOOK_ID} pageId={PAGE_ID} />
      </AdminServicesContext.Provider>,
    );

    expect(
      await screen.findByTestId("admin-review-ocr-queued-banner"),
    ).toHaveTextContent(
      /Đã lưu 1 trang trong hàng chờ OCR — Tự động xử lý ngay khi máy chủ OCR bật lại/i,
    );
    expect(REV_2_ID).toBeTruthy();
  });

  it("Flow 4: GlobalTaskCenter renders calm amber 'Hàng chờ OCR' pill and clear offline sub-status without infinite spinner", async () => {
    const waitingTasks: GlobalTaskItem[] = [
      {
        id: "task-scan-1",
        source: "ocr_inference_job",
        job_type: "LOCAL_PAGE_SCAN",
        title_vi: "Quét nhanh trang sách",
        book_id: null,
        book_page_id: null,
        book_title: null,
        page_number: null,
        source_revision_id: null,
        actor_role: "parent",
        status: "WAITING_FOR_WORKER",
        status_label_vi: "Chờ máy xử lý AI kết nối lại",
        stage: "OCR",
        stage_label_vi: "Đã lưu trong hàng chờ — Chờ máy chủ OCR bật lại",
        priority: 10,
        attempt_count: 0,
        max_attempts: 3,
        progress_completed: null,
        progress_total: null,
        progress_unit: null,
        progress_pct: null,
        is_indeterminate: true,
        can_retry: false,
        can_cancel: false,
        result_href: "/book-scanner",
        result_ref: {},
        checkpoints: {},
        error_code: null,
        error_message_vi: null,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        started_at: null,
        completed_at: null,
      },
      {
        id: "task-sub-1",
        source: "ocr_inference_job",
        job_type: "PARENT_BOOK_SUBMISSION",
        title_vi: "Nhận diện chữ trang sách của tôi",
        book_id: BOOK_ID,
        book_page_id: null,
        book_title: "Sách gia đình",
        page_number: 1,
        source_revision_id: null,
        actor_role: "parent",
        status: "WAITING_FOR_WORKER",
        status_label_vi: "Chờ máy xử lý AI kết nối lại",
        stage: "OCR",
        stage_label_vi: "Đã lưu trong hàng chờ — Chờ máy chủ OCR bật lại",
        priority: 50,
        attempt_count: 0,
        max_attempts: 3,
        progress_completed: null,
        progress_total: null,
        progress_unit: null,
        progress_pct: null,
        is_indeterminate: true,
        can_retry: false,
        can_cancel: false,
        result_href: `/my-books?bookId=${BOOK_ID}`,
        result_ref: {},
        checkpoints: {},
        error_code: null,
        error_message_vi: null,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        started_at: null,
        completed_at: null,
      },
    ];

    const feed: GlobalTaskListResponse = {
      actor_id: "parent-offline",
      actor_role: "parent",
      active_count: 2,
      waiting_review_count: 0,
      failed_count: 0,
      completed_count: 0,
      worker_online: false,
      recommended_poll_ms: 15000,
      tasks: waitingTasks,
    };

    const mockService: GlobalTasksService = {
      listTasks: vi.fn(async () => feed),
      createTask: vi.fn(),
      retryTask: vi.fn(),
      cancelTask: vi.fn(),
      getCapabilities: vi.fn(),
    };

    render(
      <AiTaskCenterProvider
        actorId="parent-offline"
        actorRole="parent"
        service={mockService}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    const trigger = await screen.findByTestId("global-task-center-trigger");
    await waitFor(() => expect(trigger).toHaveTextContent("Hàng chờ OCR (2)"));

    fireEvent.click(trigger);

    const scanQueuedBox = await screen.findByTestId(
      "task-queued-offline-task-scan-1",
    );
    expect(scanQueuedBox).toHaveTextContent(
      "Đã lưu trong hàng chờ — Chờ máy chủ OCR bật lại",
    );
    expect(
      screen.getByTestId("task-queued-offline-task-sub-1"),
    ).toHaveTextContent("Đã lưu trong hàng chờ — Chờ máy chủ OCR bật lại");
    expect(screen.queryByText("Đang xử lý nền…")).not.toBeInTheDocument();
  });
});
