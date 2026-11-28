import {
  expect,
  test,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import { ids, installApiFixture, setRole } from "./real-data-fixture";

const TIMESTAMP = "2026-11-27T10:15:00Z";

const CORS_HEADERS = {
  "access-control-allow-origin": "http://127.0.0.1:3106",
  "access-control-allow-headers": "authorization,content-type,accept",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
};

function respondJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    headers: CORS_HEADERS,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function applyRequestedViewport(page: Page, testInfo: TestInfo) {
  if (!testInfo.project.name.includes("mobile")) {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
}

async function makeTestPngBuffers(page: Page, colors: readonly string[]) {
  const base64List = await page.evaluate((palette) => {
    return palette.map((color) => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 560;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Canvas 2D context unavailable");
      }
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 400, 560);
      ctx.fillStyle = "#111827";
      ctx.font = "28px sans-serif";
      ctx.fillText("Trang sach tieng Viet", 36, 120);
      return canvas.toDataURL("image/png").split(",")[1] ?? "";
    });
  }, colors);
  return base64List.map((b64) => Buffer.from(b64, "base64"));
}

test.describe("Offline Docker OCR Queueing & Auto-Recovery E2E", () => {
  test("Scenario 1: Parent BookScanner queues 2 images offline, cancels 1, and auto-recovers when OCR comes back", async ({
    page,
  }, testInfo) => {
    await applyRequestedViewport(page, testInfo);
    const api = await installApiFixture(page);

    const JOB_1 = "55555555-5555-4555-8555-555555555511";
    const JOB_2 = "55555555-5555-4555-8555-555555555512";

    let workerOnline = false;
    let enqueueCount = 0;

    interface ScanJobState {
      job_id: string;
      status: "QUEUED" | "SUCCEEDED" | "CANCELLED";
      file_name: string;
      queue_position: number | null;
    }

    const jobs = new Map<string, ScanJobState>();

    const completedScanResult = {
      scan_job_id: JOB_1,
      request_id: "req-e2e-scan-1",
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
        elapsed_ms: 1200,
      },
      matched: false,
      matched_book_id: null,
      matched_book_title: null,
      match_confidence: 0,
      matched_page: null,
      message: "Đã nhận diện văn bản tiếng Việt.",
    };

    await page.route("http://127.0.0.1:8000/**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: CORS_HEADERS });
      }
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method().toUpperCase();

      if (path === "/health" && method === "GET") {
        const queuedCount = Array.from(jobs.values()).filter(
          (item) => item.status === "QUEUED",
        ).length;
        return respondJson(route, {
          status: "ok",
          ocr_mode: "remote_worker",
          ocr: {
            mode: "remote_worker",
            ready: workerOnline,
            workers: workerOnline ? [{ worker_id: "win-1", online: true }] : [],
            queue: { queued: queuedCount },
          },
        });
      }

      if (path === "/reading/scan-page-ocr/jobs" && method === "GET") {
        const activeJobs = Array.from(jobs.values())
          .filter((item) => item.status === "QUEUED")
          .sort((a, b) => (b.queue_position ?? 0) - (a.queue_position ?? 0))
          .map((item) => ({
            job_id: item.job_id,
            status: item.status,
            worker_online: workerOnline,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
            file_name: item.file_name,
            queue_position: item.queue_position,
            error_code: null,
            error_message: null,
            result: null,
          }));
        return respondJson(route, {
          worker_online: workerOnline,
          jobs: activeJobs,
        });
      }

      if (path === "/reading/scan-page-ocr/jobs" && method === "POST") {
        enqueueCount += 1;
        const jobId = enqueueCount === 1 ? JOB_1 : JOB_2;
        const fileName = enqueueCount === 1 ? "trang-1.png" : "trang-2.png";
        const state: ScanJobState = {
          job_id: jobId,
          status: "QUEUED",
          file_name: fileName,
          queue_position: enqueueCount,
        };
        jobs.set(jobId, state);
        return respondJson(
          route,
          {
            job_id: state.job_id,
            status: state.status,
            worker_online: workerOnline,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
            file_name: state.file_name,
            queue_position: state.queue_position,
            error_code: null,
            error_message: null,
            result: null,
          },
          202,
        );
      }

      const jobMatch = /^\/reading\/scan-page-ocr\/jobs\/([^/]+)$/.exec(path);
      if (jobMatch) {
        const jobId = jobMatch[1];
        const state = jobs.get(jobId);
        if (!state) {
          return respondJson(route, { detail: "Job not found" }, 404);
        }
        if (method === "DELETE") {
          state.status = "CANCELLED";
          state.queue_position = null;
          return respondJson(route, {
            job_id: state.job_id,
            status: "CANCELLED",
            worker_online: workerOnline,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
            file_name: state.file_name,
            queue_position: null,
            error_code: null,
            error_message: null,
            result: null,
          });
        }
        if (method === "GET") {
          if (workerOnline && state.status === "QUEUED") {
            state.status = "SUCCEEDED";
            state.queue_position = null;
          }
          return respondJson(route, {
            job_id: state.job_id,
            status: state.status,
            worker_online: workerOnline,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
            file_name: state.file_name,
            queue_position: state.queue_position,
            error_code: null,
            error_message: null,
            result:
              state.status === "SUCCEEDED"
                ? { ...completedScanResult, scan_job_id: state.job_id }
                : null,
          });
        }
      }

      return route.fallback();
    });

    await page.goto(`/book-scanner?childId=${ids.child}`);

    const offlineBanner = page.getByTestId("ocr-worker-offline-banner");
    await expect(offlineBanner).toBeVisible();
    await expect(offlineBanner).toContainText(
      "Chức năng nhận diện chữ (OCR) hiện chưa sẵn sàng",
    );
    await expect(
      page.getByRole("button", { name: "Chụp / Tải ảnh vào hàng chờ OCR" }),
    ).toBeVisible();

    const [png1, png2] = await makeTestPngBuffers(page, ["#fef3c7", "#dbeafe"]);

    const fileInput = page.getByTestId("local-ocr-file-input");
    await fileInput.setInputFiles({
      name: "trang-1.png",
      mimeType: "image/png",
      buffer: png1,
    });
    await expect(page.getByTestId("async-ocr-job-card")).toContainText(
      "trang-1.png",
    );

    await fileInput.setInputFiles({
      name: "trang-2.png",
      mimeType: "image/png",
      buffer: png2,
    });
    await expect(page.getByTestId("async-ocr-job-card")).toContainText(
      "trang-2.png",
    );
    const queuedList = page.getByTestId("queued-scan-jobs-list");
    await expect(queuedList).toBeVisible();
    await expect(queuedList).toContainText("2 trang");
    await expect(queuedList).toContainText("trang-1.png");

    // Cancel active job 2 -> job 1 (trang-1.png) stays visible & auto-promotes
    await page.getByTestId("cancel-queued-ocr-job").click();
    await expect(page.getByTestId("async-ocr-job-card")).toContainText(
      "trang-1.png",
    );
    await expect(page.getByTestId("queued-scan-jobs-list")).toHaveCount(0);

    // Worker recovers -> 12s /health auto-poll wakes job polling -> displays OCR result without reload
    workerOnline = true;
    await expect(page.getByTestId("local-ocr-text")).toHaveText(
      "Chú mèo con chạy ra sân đón nắng mai.",
      { timeout: 25_000 },
    );
    await expect(page.getByTestId("local-ocr-result")).toBeVisible();
    expect(api.unexpected).toEqual([]);
  });

  test("Scenario 2: Parent Private Book /my-books & /my-books/[id] + GlobalTaskCenter queue offline and auto-refresh on recovery", async ({
    page,
  }, testInfo) => {
    await applyRequestedViewport(page, testInfo);
    const api = await installApiFixture(page);

    const SUB_ID = "99999999-9999-4999-8999-999999999921";
    const BATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21";
    const TASK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb21";
    const HASH_DONE = "1".repeat(64);

    let workerOnline = false;
    let uploaded = false;
    let submissionDone = false;

    const buildSummary = () => ({
      id: ids.book,
      title: "Truyện Gia Đình Offline",
      author: "Ba Mẹ",
      min_grade: 1,
      max_grade: 2,
      lifecycle_status: "ACTIVE" as const,
      visibility_scope: "PARENT_PRIVATE" as const,
      moderation_status: "ACTIVE" as const,
      suspended_reason: null,
      source_declaration: "[OWNED_PHYSICAL_BOOK] Sách giấy gia đình mua",
      committed_page_count: 0,
      pending_submission_count: submissionDone ? 0 : 1,
      flagged_submission_count: 0,
      failed_submission_count: 0,
      ready_to_add_count: submissionDone ? 1 : 0,
      readable_for_children: false,
      has_held_multipage_batch: false,
      privacy_notice: "Sách riêng của gia đình.",
      created_at: TIMESTAMP,
    });

    const buildSubmission = () => ({
      id: SUB_ID,
      book_id: ids.book,
      batch_id: BATCH_ID,
      batch_total_pages: 1,
      source_page_number: 1,
      target_page_number: 1,
      source_file_name: "trang-gia-dinh.png",
      source_format: "IMAGE" as const,
      image_width: 400,
      image_height: 560,
      image_url: `http://127.0.0.1:8000/books/my-books/${ids.book}/submissions/${SUB_ID}/image`,
      source_type: "OWNED_PHYSICAL_BOOK" as const,
      source_type_label: "Sách giấy gia đình sở hữu",
      source_note: null,
      submission_version: 1,
      optimistic_lock_version: 1,
      workflow_status: submissionDone
        ? ("PASSED_READY_TO_ADD" as const)
        : ("CHECKING" as const),
      workflow_status_label: submissionDone
        ? "Đạt — có thể thêm trang"
        : "Đang kiểm tra…",
      ocr_status: submissionDone
        ? ("COMPLETED" as const)
        : ("PENDING" as const),
      ocr_text: submissionDone ? "Con mèo trèo cây cau." : null,
      ocr_error_code: null,
      is_image_only: false,
      proofread_status: submissionDone
        ? ("COMPLETED" as const)
        : ("PENDING" as const),
      proofread_text: submissionDone ? "Con mèo trèo cây cau." : null,
      proofread_suggestions: [],
      uncertain_word_indices: [],
      proofread_error_code: null,
      spelling_accepted: true,
      candidate_text: submissionDone ? "Con mèo trèo cây cau." : null,
      candidate_hash: submissionDone ? HASH_DONE : null,
      tool_check_status: submissionDone
        ? ("PASSED" as const)
        : ("PENDING" as const),
      tool_check_suitability: submissionDone ? ("SUITABLE" as const) : null,
      tool_check_scope: {
        modality: "TEXT_ONLY" as const,
        covers_all_chunks: submissionDone,
        chunks_checked: submissionDone ? 1 : 0,
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
    });

    await page.route("http://127.0.0.1:8000/**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: CORS_HEADERS });
      }
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method().toUpperCase();

      if (path === "/health" && method === "GET") {
        return respondJson(route, {
          status: "ok",
          ocr_mode: "remote_worker",
          ocr: {
            mode: "remote_worker",
            ready: workerOnline,
            workers: workerOnline ? [{ worker_id: "win-1", online: true }] : [],
            queue: { queued: uploaded && !submissionDone ? 1 : 0 },
          },
        });
      }

      if (path === "/books/my-books/paged" && method === "GET") {
        return respondJson(route, {
          items: [buildSummary()],
          total: 1,
          limit: 9,
          offset: 0,
        });
      }

      if (path === `/books/my-books/${ids.book}` && method === "GET") {
        return respondJson(route, {
          book: buildSummary(),
          pages: [],
          submissions: uploaded ? [buildSubmission()] : [],
        });
      }

      if (path === `/books/my-books/${ids.book}/assets` && method === "GET") {
        return respondJson(route, { book_id: ids.book, assets: [] });
      }

      if (
        path === `/books/my-books/${ids.book}/submissions` &&
        method === "POST"
      ) {
        uploaded = true;
        return respondJson(
          route,
          {
            book_id: ids.book,
            batch_id: BATCH_ID,
            source_format: "IMAGE",
            total_pages: 1,
            replayed_idempotency: false,
            submissions: [buildSubmission()],
          },
          202,
        );
      }

      if (
        path === `/books/my-books/${ids.book}/submissions/${SUB_ID}/image` &&
        method === "GET"
      ) {
        return route.fulfill({
          status: 200,
          headers: CORS_HEADERS,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560"><rect width="400" height="560" fill="#fef3c7"/></svg>',
        });
      }

      if (path === "/studio/tasks" && method === "GET") {
        const tasks = uploaded
          ? [
              {
                id: TASK_ID,
                source: "parent_submission",
                job_type: "PARENT_BOOK_SUBMISSION",
                title_vi: "Nhận diện chữ trang sách của tôi",
                book_id: ids.book,
                book_page_id: null,
                book_title: "Truyện Gia Đình Offline",
                page_number: 1,
                source_revision_id: null,
                actor_role: "parent",
                status: submissionDone ? "SUCCEEDED" : "WAITING_FOR_WORKER",
                status_label_vi: submissionDone
                  ? "Hoàn tất"
                  : "Chờ máy xử lý AI kết nối lại",
                stage: submissionDone ? "DONE" : "OCR",
                stage_label_vi: submissionDone
                  ? "Đã kiểm tra xong"
                  : "Đã lưu trong hàng chờ — Chờ máy chủ OCR bật lại",
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
                result_href: `/my-books/${ids.book}`,
                result_ref: {},
                checkpoints: {},
                error_code: null,
                error_message_vi: null,
                created_at: TIMESTAMP,
                updated_at: TIMESTAMP,
                started_at: null,
                completed_at: submissionDone ? TIMESTAMP : null,
              },
            ]
          : [];
        return respondJson(route, {
          actor_id: ids.parent,
          actor_role: "parent",
          active_count: uploaded && !submissionDone ? 1 : 0,
          waiting_review_count: 0,
          failed_count: 0,
          completed_count: submissionDone ? 1 : 0,
          worker_online: workerOnline,
          recommended_poll_ms: 15000,
          tasks,
        });
      }

      return route.fallback();
    });

    await page.goto("/my-books");

    const listBanner = page.getByTestId("ocr-worker-offline-banner");
    await expect(listBanner).toBeVisible();
    await expect(listBanner).toContainText(
      "Chức năng nhận diện chữ (OCR) hiện chưa sẵn sàng",
    );
    await expect(
      page.getByTestId(`book-waiting-ocr-${ids.book}`),
    ).toContainText("Chờ OCR mở lại");

    await page.locator(`a[href="/my-books/${ids.book}"]`).click();
    await page.waitForURL(new RegExp(`/my-books/${ids.book}$`));

    const detailBanner = page.getByTestId("private-book-worker-offline-notice");
    await expect(detailBanner).toBeVisible();
    await expect(detailBanner).toContainText(
      "Chức năng nhận diện chữ (OCR) hiện chưa sẵn sàng",
    );

    const uploadBtn = page.getByRole("button", {
      name: "Tải trang & đưa vào hàng chờ OCR",
    });
    await expect(uploadBtn).toBeVisible();

    const [png] = await makeTestPngBuffers(page, ["#fde68a"]);
    await page.getByLabel("Chọn tệp trang sách hoặc tài liệu").setInputFiles({
      name: "trang-gia-dinh.png",
      mimeType: "image/png",
      buffer: png,
    });
    await uploadBtn.click();

    await expect(
      page.getByText(/Đã lưu 1 trang \(IMAGE\) vào hàng chờ OCR/i),
    ).toBeVisible();
    await expect(
      page.getByTestId("submission-queued-offline-badge"),
    ).toContainText(/Đã lưu trong hàng chờ/i);

    // viread:tasks-changed updates Global Task Center with 1 amber queued task (no double count)
    const taskTrigger = page.getByTestId("global-task-center-trigger");
    await expect(taskTrigger).toContainText("Hàng chờ OCR (1)");
    await expect(taskTrigger).toHaveClass(/border-amber-300/);

    await taskTrigger.click();
    const drawer = page.getByTestId("global-task-center-panel");
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByTestId("global-task-center-worker-offline-banner"),
    ).toBeVisible();
    await expect(
      drawer.getByTestId(`task-queued-offline-${TASK_ID}`),
    ).toBeVisible();
    await expect(drawer.locator('[data-testid^="task-card-"]')).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    // OCR recovers -> detail auto-refreshes to verified/ready-to-add state without manual reload
    workerOnline = true;
    submissionDone = true;

    await expect(page.getByText("Con mèo trèo cây cau.")).toBeVisible({
      timeout: 25_000,
    });
    await expect(
      page.getByRole("button", { name: /Thêm trang vào sách/ }),
    ).toBeEnabled();
    await expect(
      page.getByTestId("submission-queued-offline-badge"),
    ).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test("Scenario 3: Admin book detail + uploader + OCR review offline queueing, DEAD_LETTER, cancel/retry & auto-recovery", async ({
    page,
  }, testInfo) => {
    await applyRequestedViewport(page, testInfo);
    const api = await installApiFixture(page);
    await setRole(page, "admin");

    const JOB_QUEUED_UPLOAD = "44444444-4444-4444-8444-444444444431";
    const JOB_DEAD_LETTER = "55555555-5555-4555-8555-555555555532";
    const JOB_REPROCESS = "66666666-6666-4666-8666-666666666633";
    const PAGE_2_ID = "77777777-7777-4777-8777-777777777731";
    const REV_2_ID = "88888888-8888-4888-8888-888888888832";

    let workerOnline = false;
    let newPageCommitted = false;

    interface AdminOcrJobState {
      id: string;
      job_kind: string;
      status: "QUEUED" | "DEAD_LETTER" | "SUCCEEDED" | "CANCELLED";
      book_id: string;
      page_id: string | null;
      file_name: string;
      queue_position: number | null;
      error_message?: string | null;
    }

    let adminJobs: AdminOcrJobState[] = [
      {
        id: JOB_DEAD_LETTER,
        job_kind: "ADMIN_PAGE_UPLOAD",
        status: "DEAD_LETTER",
        book_id: ids.book,
        page_id: null,
        file_name: "trang-loi.png",
        queue_position: null,
        error_message: "Ảnh quá mờ, không đọc được chữ.",
      },
    ];

    await page.route("http://127.0.0.1:8000/**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: CORS_HEADERS });
      }
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method().toUpperCase();

      if (path === "/health" && method === "GET") {
        if (workerOnline && !newPageCommitted) {
          // Simulate Docker OCR worker draining queued jobs on startup
          adminJobs = adminJobs.map((job) =>
            job.status === "QUEUED"
              ? { ...job, status: "SUCCEEDED", queue_position: null }
              : job,
          );
          newPageCommitted = true;
        }
        return respondJson(route, {
          status: "ok",
          ocr_mode: "remote_worker",
          ocr: {
            mode: "remote_worker",
            ready: workerOnline,
            workers: workerOnline ? [{ worker_id: "win-1", online: true }] : [],
            queue: {
              queued: adminJobs.filter((j) => j.status === "QUEUED").length,
            },
          },
        });
      }

      if (
        path === `/books/admin/catalog/${ids.book}/pages` &&
        method === "GET"
      ) {
        const list = [
          {
            book_id: ids.book,
            page_number: 1,
            processing: {
              page_id: ids.page,
              page_revision_id: ids.revision,
              revision_no: 1,
              verification_status: "NEEDS_REVIEW",
              lifecycle_status: "ACTIVE",
              ocr_preview_metadata: {},
              verified_at: null,
              current_verified_revision_id: null,
            },
            text_preview: "Trang một",
          },
        ];
        if (newPageCommitted) {
          list.push({
            book_id: ids.book,
            page_number: 2,
            processing: {
              page_id: PAGE_2_ID,
              page_revision_id: REV_2_ID,
              revision_no: 1,
              verification_status: "NEEDS_REVIEW",
              lifecycle_status: "ACTIVE",
              ocr_preview_metadata: {},
              verified_at: null,
              current_verified_revision_id: null,
            },
            text_preview: "Trang mới hoàn tất OCR",
          });
        }
        return respondJson(route, list);
      }

      if (
        path === `/books/admin/catalog/${ids.book}/ocr-jobs` &&
        method === "GET"
      ) {
        return respondJson(
          route,
          adminJobs
            .filter((j) => j.status !== "CANCELLED")
            .map((j) => ({
              ...j,
              worker_online: workerOnline,
              created_at: TIMESTAMP,
              updated_at: TIMESTAMP,
              completed_at: j.status === "DEAD_LETTER" ? TIMESTAMP : null,
            })),
        );
      }

      if (
        path === `/books/admin/catalog/${ids.book}/pages/jobs` &&
        method === "POST"
      ) {
        const created: AdminOcrJobState = {
          id: JOB_QUEUED_UPLOAD,
          job_kind: "ADMIN_PAGE_UPLOAD",
          status: "QUEUED",
          book_id: ids.book,
          page_id: null,
          file_name: "trang-moi-2.png",
          queue_position: 1,
        };
        adminJobs = [created, ...adminJobs];
        return respondJson(
          route,
          {
            ...created,
            worker_online: workerOnline,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
          },
          202,
        );
      }

      if (
        path === `/books/admin/pages/${ids.page}/reprocess/jobs` &&
        method === "POST"
      ) {
        const reprocessJob: AdminOcrJobState = {
          id: JOB_REPROCESS,
          job_kind: "ADMIN_PAGE_REPROCESS",
          status: "QUEUED",
          book_id: ids.book,
          page_id: ids.page,
          file_name: "trang-1.png",
          queue_position: 2,
        };
        adminJobs = [
          reprocessJob,
          ...adminJobs.filter((j) => j.id !== JOB_REPROCESS),
        ];
        return respondJson(
          route,
          {
            ...reprocessJob,
            worker_online: workerOnline,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
          },
          202,
        );
      }

      const retryMatch = /^\/books\/admin\/ocr-jobs\/([^/]+)\/retry$/.exec(
        path,
      );
      if (retryMatch && method === "POST") {
        const jobId = retryMatch[1];
        adminJobs = adminJobs.map((j) =>
          j.id === jobId
            ? {
                ...j,
                status: "QUEUED",
                queue_position: 2,
                error_message: null,
              }
            : j,
        );
        const updated = adminJobs.find((j) => j.id === jobId);
        return respondJson(route, {
          ...updated,
          worker_online: workerOnline,
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
        });
      }

      const jobMatch = /^\/books\/admin\/ocr-jobs\/([^/]+)$/.exec(path);
      if (jobMatch) {
        const jobId = jobMatch[1];
        const found = adminJobs.find((j) => j.id === jobId);
        if (!found) {
          return respondJson(route, { detail: "Not found" }, 404);
        }
        if (method === "DELETE") {
          adminJobs = adminJobs.filter((j) => j.id !== jobId);
          return respondJson(route, {
            ...found,
            status: "CANCELLED",
            queue_position: null,
          });
        }
        if (method === "GET") {
          return respondJson(route, {
            ...found,
            worker_online: workerOnline,
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
          });
        }
      }

      return route.fallback();
    });

    await page.goto(`/admin/books/${ids.book}`);

    // Pre-action offline banner + DEAD_LETTER panel visible immediately
    const adminBanner = page.getByTestId("admin-ocr-worker-offline-banner");
    await expect(adminBanner).toBeVisible();
    await expect(adminBanner).toContainText(
      "Dịch vụ xử lý OCR hiện đang ngoại tuyến",
    );

    const deadLetterPanel = page.getByTestId(
      "admin-book-ocr-dead-letter-panel",
    );
    await expect(deadLetterPanel).toBeVisible();
    await expect(deadLetterPanel).toContainText("trang-loi.png");
    await expect(deadLetterPanel).toContainText(
      "Ảnh quá mờ, không đọc được chữ.",
    );

    // Expand uploader and upload a page -> amber QUEUED_OFFLINE badge (no 100%)
    await page.getByRole("button", { name: /Tải trang lên/i }).click();
    const submitBtn = page.getByRole("button", {
      name: /Tải lên & đưa vào hàng chờ OCR/i,
    });
    await expect(submitBtn).toBeVisible();

    const [png] = await makeTestPngBuffers(page, ["#e0f2fe"]);
    await page.locator("#page-images").setInputFiles({
      name: "trang-moi-2.png",
      mimeType: "image/png",
      buffer: png,
    });
    await submitBtn.click();

    await expect(page.getByText("Đã đưa vào hàng chờ OCR")).toBeVisible();
    await expect(page.getByText("100%")).toHaveCount(0);

    // KPI includes pending new page (0 processing + 1 queued upload = 1)
    await expect(
      page.getByTestId("admin-book-kpi-processing-count"),
    ).toHaveText("1");
    await expect(
      page.getByTestId(`admin-queued-new-page-row-${JOB_QUEUED_UPLOAD}`),
    ).toContainText("trang-moi-2.png");

    // Retry DEAD_LETTER job -> panel clears and KPI increments to 2
    await page.getByTestId(`retry-dead-letter-job-${JOB_DEAD_LETTER}`).click();
    await expect(
      page.getByTestId("admin-book-ocr-dead-letter-panel"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("admin-book-kpi-processing-count"),
    ).toHaveText("2");

    // Cancel the uploaded queued job -> KPI drops to 1 (retried job remains queued)
    await page
      .getByTestId(`cancel-queued-ocr-job-${JOB_QUEUED_UPLOAD}`)
      .click();
    await expect(
      page.getByTestId("admin-book-kpi-processing-count"),
    ).toHaveText("1");

    // Visit OCR Review screen -> pre-action offline banner visible, then trigger reprocess for queued banner controls
    await page.goto(`/admin/books/${ids.book}/pages/${ids.page}`);
    await expect(
      page.getByTestId("admin-ocr-worker-offline-banner"),
    ).toBeVisible();

    await page.getByRole("tab", { name: /Lịch sử phiên bản/i }).click();
    await page
      .getByRole("button", { name: /Chạy lại OCR từ ảnh đã lưu/i })
      .click();

    const reviewQueuedBanner = page.getByTestId(
      "admin-review-ocr-queued-banner",
    );
    await expect(reviewQueuedBanner).toBeVisible();
    const checkNowBtn = page.getByTestId("admin-review-check-ocr-now");
    const cancelQueuedBtn = page.getByTestId("admin-review-cancel-ocr-job");
    await expect(checkNowBtn).toHaveText(/Kiểm tra lại ngay/);
    await expect(cancelQueuedBtn).toHaveText(/Hủy yêu cầu chờ/);

    await checkNowBtn.click();
    await expect(reviewQueuedBanner).toBeVisible();

    await cancelQueuedBtn.click();
    await expect(
      page.getByTestId("admin-review-ocr-queued-banner"),
    ).toHaveCount(0);

    // Return to book detail while offline (retried job still queued), then recover OCR -> auto-refreshes without manual reload
    await page.goto(`/admin/books/${ids.book}`);
    await expect(
      page.getByTestId("admin-book-kpi-processing-count"),
    ).toHaveText("1");

    workerOnline = true;

    await expect(
      page.getByRole("heading", { name: "Trang 2", exact: true }),
    ).toBeVisible({
      timeout: 25_000,
    });
    await expect(page.getByTestId("admin-book-ocr-queue-banner")).toHaveCount(
      0,
    );
    await expect(
      page.getByTestId("admin-book-kpi-processing-count"),
    ).toHaveText("0");
    expect(api.unexpected).toEqual([]);
  });
});
