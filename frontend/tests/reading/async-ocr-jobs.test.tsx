import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthRuntimeContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import { ParentPrivateBookManager } from "@/components/books/parent-private-book-manager";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
import { createAdminPageService } from "@/lib/api/admin-page-service";
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

const { pushMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "async-ocr-test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const BOOK_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const REV_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const SUB_ID = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-11-25T10:00:00Z";

const ocrResult = {
  scan_job_id: JOB_ID,
  request_id: "req-async-01",
  idempotency_key: "idem-01",
  status: "SUCCEEDED",
  ocr_text: "Cánh đồng lúa chín vàng.",
  word_count: 5,
  words: [
    {
      word_index: 0,
      line_index: 0,
      text: "Cánh",
      normalized_text: "cánh",
      bbox: [0.1, 0.1, 0.1, 0.05],
      ocr_confidence: 0.99,
    },
  ],
  provenance: {
    engine: "paddleocr_vietocr_dual",
    device: "cuda",
    engine_statuses: { paddleocr: "success", vietocr: "success" },
    cloud_ocr_used: false,
    elapsed_ms: 1200,
  },
  matched: false,
  matched_book_id: null,
  matched_book_title: null,
  match_confidence: 0,
  matched_page: null,
  message: "Đã nhận diện xong văn bản tiếng Việt.",
};

beforeEach(() => {
  installApiFetchFixture();
  pushMock.mockReset();
  replaceMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Async OCR Queue UX (/book-scanner, /my-books, Admin /jobs)", () => {
  it("shows explicit QUEUED (worker offline) banner + worker_online badge and allows Cancel cleanly", async () => {
    const user = userEvent.setup();
    let cancelCalled = false;
    apiFetchFixture.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/reading/scan-page-ocr/jobs" && init?.method === "POST") {
        return Response.json(
          {
            job_id: JOB_ID,
            status: "QUEUED",
            worker_online: false,
            created_at: NOW,
            updated_at: NOW,
            error_code: null,
            error_message: null,
            result: null,
          },
          { status: 202 },
        );
      }
      if (
        path === `/reading/scan-page-ocr/jobs/${JOB_ID}` &&
        init?.method === "DELETE"
      ) {
        cancelCalled = true;
        return Response.json({
          job_id: JOB_ID,
          status: "CANCELLED",
          worker_online: false,
          created_at: NOW,
          updated_at: NOW,
          result: null,
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <BookScannerScreen />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    await screen.findByRole("button", { name: /Chọn ảnh trang sách/i });
    const fileInput = screen.getByTestId(
      "local-ocr-file-input",
    ) as HTMLInputElement;
    await user.upload(
      fileInput,
      new File([new Uint8Array([137, 80, 78, 71])], "page.png", {
        type: "image/png",
      }),
    );

    expect(
      await screen.findByText(
        /Đang xếp hàng chờ máy chủ OCR Windows bật — ảnh đã được lưu an toàn/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ocr-worker-online-badge")).toHaveTextContent(
      /Đang tắt/i,
    );

    await user.click(screen.getByRole("button", { name: /Hủy quét/i }));
    await waitFor(() => expect(cancelCalled).toBe(true));
    expect(screen.queryByTestId("async-ocr-job-card")).not.toBeInTheDocument();
  });

  it("polls RUNNING -> SUCCEEDED on /reading/scan-page-ocr/jobs/{id} and renders OCR text", async () => {
    const user = userEvent.setup();
    let polls = 0;
    apiFetchFixture.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/reading/scan-page-ocr/jobs" && init?.method === "POST") {
        return Response.json(
          {
            job_id: JOB_ID,
            status: "RUNNING",
            worker_online: true,
            created_at: NOW,
            updated_at: NOW,
            result: null,
          },
          { status: 202 },
        );
      }
      if (path === `/reading/scan-page-ocr/jobs/${JOB_ID}`) {
        polls += 1;
        return Response.json({
          job_id: JOB_ID,
          status: "SUCCEEDED",
          worker_online: true,
          created_at: NOW,
          updated_at: NOW,
          result: ocrResult,
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <BookScannerScreen />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    await screen.findByRole("button", { name: /Chọn ảnh trang sách/i });
    const fileInput = screen.getByTestId(
      "local-ocr-file-input",
    ) as HTMLInputElement;
    await user.upload(
      fileInput,
      new File([new Uint8Array([137, 80, 78, 71])], "page.png", {
        type: "image/png",
      }),
    );

    expect(
      await screen.findByText(/Đang nhận diện trang sách/i),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("local-ocr-text", {}, { timeout: 4_000 }),
    ).toHaveTextContent("Cánh đồng lúa chín vàng.");
    expect(polls).toBeGreaterThanOrEqual(1);
  });

  it("shows honest worker-offline queue status in ParentPrivateBookManager when ocr_status is PENDING and /health worker is offline", async () => {
    const authRuntime: AuthRuntimeState = {
      initializationFailure: null,
      isPasswordRecovery: false,
      lastEvent: "SIGNED_IN",
      mode: "supabase",
      status: "ready",
      session: {
        expires_at: null,
        user: {
          id: "parent-1",
          email: "p@example.test",
          display_name: "Phụ huynh",
        },
      },
    };

    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/books/my-books/${BOOK_ID}`) {
        return Response.json({
          book: {
            id: BOOK_ID,
            title: "Sách gia đình",
            author: null,
            min_grade: 1,
            max_grade: 2,
            lifecycle_status: "ACTIVE",
            visibility_scope: "PARENT_PRIVATE",
            moderation_status: "ACTIVE",
            suspended_reason: null,
            source_declaration: null,
            committed_page_count: 0,
            pending_submission_count: 1,
            flagged_submission_count: 0,
            failed_submission_count: 0,
            ready_to_add_count: 0,
            readable_for_children: false,
            has_held_multipage_batch: false,
            privacy_notice: "Chỉ gia đình đọc.",
            created_at: NOW,
          },
          pages: [],
          submissions: [
            {
              id: SUB_ID,
              book_id: BOOK_ID,
              batch_id: JOB_ID,
              batch_total_pages: 1,
              source_page_number: 1,
              target_page_number: null,
              source_file_name: "trang1.jpg",
              source_format: "IMAGE",
              image_width: 800,
              image_height: 1000,
              image_url: `http://127.0.0.1:8000/books/my-books/${BOOK_ID}/submissions/${SUB_ID}/image`,
              source_type: "OWNED_PHYSICAL_BOOK",
              source_type_label: "Sách giấy gia đình sở hữu",
              source_note: null,
              submission_version: 1,
              optimistic_lock_version: 1,
              workflow_status: "CHECKING",
              workflow_status_label: "Đang kiểm tra",
              ocr_status: "PENDING",
              ocr_text: null,
              ocr_error_code: null,
              is_image_only: false,
              proofread_status: "PENDING",
              proofread_text: null,
              proofread_suggestions: [],
              uncertain_word_indices: [],
              proofread_error_code: null,
              spelling_accepted: false,
              candidate_text: null,
              candidate_hash: null,
              tool_check_status: "PENDING",
              tool_check_suitability: null,
              tool_check_scope: {
                modality: "TEXT_ONLY",
                covers_all_chunks: false,
                chunks_checked: 0,
                total_chunks: 0,
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
              can_add_to_book: false,
              can_request_admin_review: false,
              can_retry: false,
              admin_decision: null,
              admin_decision_reason: null,
              approved_snapshot_hash: null,
              approved_submission_version: null,
              committed_page_id: null,
              committed_revision_id: null,
              created_at: NOW,
              updated_at: NOW,
            },
          ],
        });
      }
      if (path === "/health") {
        return Response.json({
          ocr: {
            mode: "remote_worker",
            ready: false,
            workers: [],
            queue: { queued: 1 },
          },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      });
    });

    render(
      <AuthRuntimeContext.Provider value={authRuntime}>
        <AppServicesProvider>
          <ParentPrivateBookManager bookId={BOOK_ID} />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(
      await screen.findByText(/Đang chờ máy chủ OCR Windows bật/i),
    ).toBeInTheDocument();
  });

  it("uses async /jobs endpoints with polling for Admin pages, documents, reupload-ocr, and reprocess", async () => {
    const revDetail = {
      page_id: PAGE_ID,
      page_revision_id: REV_ID,
      revision_no: 2,
      verification_status: "NEEDS_REVIEW",
      lifecycle_status: "ACTIVE",
      ocr_preview_metadata: {},
      verified_at: null,
      current_verified_revision_id: null,
      draft_text: "Trang sách mẫu",
      words: [],
      ocr_metadata: {},
      created_at: NOW,
      verified_by: null,
    };

    const calledPaths: string[] = [];
    let pollCount = 0;

    apiFetchFixture.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      calledPaths.push(`${init?.method ?? "GET"} ${path}`);

      if (path === `/books/admin/catalog/${BOOK_ID}/documents/jobs`) {
        return Response.json(
          {
            book_id: BOOK_ID,
            source_format: "PDF",
            total_source_pages: 2,
            job_ids: [JOB_ID],
            queued_count: 2,
            worker_online: false,
          },
          { status: 202 },
        );
      }
      if (path === `/books/admin/catalog/${BOOK_ID}/pages`) {
        return Response.json([]);
      }
      if (
        path === `/books/admin/pages/${PAGE_ID}/reupload-ocr/jobs` ||
        path === `/books/admin/pages/${PAGE_ID}/reprocess/jobs`
      ) {
        pollCount = 0;
        return Response.json(
          {
            id: JOB_ID,
            job_kind: "ADMIN_PAGE_REPROCESS",
            status: "QUEUED",
            page_id: PAGE_ID,
            revision_id: null,
          },
          { status: 202 },
        );
      }
      if (path === `/books/admin/ocr-jobs/${JOB_ID}`) {
        pollCount += 1;
        return Response.json({
          id: JOB_ID,
          job_kind: "ADMIN_PAGE_REPROCESS",
          status: pollCount >= 1 ? "SUCCEEDED" : "RUNNING",
          page_id: PAGE_ID,
          revision_id: REV_ID,
        });
      }
      if (path === `/books/admin/pages/${PAGE_ID}/revisions/${REV_ID}`) {
        return Response.json(revDetail);
      }
      throw new Error(`Unexpected admin path: ${path}`);
    });

    const pageService = createAdminPageService({
      pollIntervalMs: 1,
      maxPollAttempts: 5,
    });
    const revService = createRevisionService({
      pollIntervalMs: 1,
      maxPollAttempts: 5,
    });

    const pdfFile = new File(["%PDF-1.7"], "sach.pdf", {
      type: "application/pdf",
    });
    const docProgress: Array<string | undefined> = [];
    await pageService.upload(
      BOOK_ID,
      [
        {
          client_id: "doc-1",
          file_name: "sach.pdf",
          mime_type: "application/pdf",
          size_bytes: pdfFile.size,
          width: 800,
          height: 1000,
          file: pdfFile,
          upload_kind: "document",
        },
      ],
      (p) => docProgress.push(p.summary_message),
    );
    expect(docProgress.some((m) => m?.includes("Đã xếp hàng 2 trang"))).toBe(
      true,
    );

    const imgFile = new File(["img"], "p1.png", { type: "image/png" });
    const replaced = await pageService.replaceImageAndReprocess(
      PAGE_ID,
      imgFile,
    );
    expect(replaced.page_revision_id).toBe(REV_ID);

    const reprocessed = await revService.reprocess(PAGE_ID);
    expect(reprocessed.page_revision_id).toBe(REV_ID);

    expect(calledPaths).toContain(
      `POST /books/admin/catalog/${BOOK_ID}/documents/jobs`,
    );
    expect(calledPaths).toContain(
      `POST /books/admin/pages/${PAGE_ID}/reupload-ocr/jobs`,
    );
    expect(calledPaths).toContain(
      `POST /books/admin/pages/${PAGE_ID}/reprocess/jobs`,
    );
    expect(calledPaths).toContain(`GET /books/admin/ocr-jobs/${JOB_ID}`);
  });
});
