import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AdminPageUploader } from "@/components/admin/admin-page-uploader";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
import { CameraPreview } from "@/components/reading/camera-preview";
import { requestApi } from "@/lib/api/api-client";
import { createAdminPageService } from "@/lib/api/admin-page-service";
import { createOcrReviewService } from "@/lib/api/ocr-review-service";
import { isServiceError } from "@/lib/api/service-error";
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
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const BOOK_ID = "60ffdba4-1790-482a-963a-a7351e5ea58a";
const PAGE_ID = "77777777-7777-4777-8777-777777777777";
const REV_ID = "88888888-8888-4888-8888-888888888888";
const WORKFLOW_ID = "99999999-9999-4999-8999-999999999999";

beforeEach(() => {
  installApiFetchFixture();
  pushMock.mockReset();
  replaceMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OCR pipeline UX & polling hardening", () => {
  it("maps remote OCR 503/504 and DB-unavailable backend messages in safeBackendMessages", async () => {
    const cases: Array<[number, string, string]> = [
      [
        503,
        "Remote OCR worker is offline; live page scan is temporarily unavailable.",
        "ngoại tuyến",
      ],
      [
        504,
        "Remote OCR worker did not finish before sync timeout; poll job status asynchronously.",
        "xếp hàng",
      ],
      [503, "Database temporarily unavailable", "đang bận"],
    ];

    for (const [status, detail, expectedSnippet] of cases) {
      apiFetchFixture.mockResolvedValueOnce(
        Response.json({ detail }, { status }),
      );
      let caught: unknown = null;
      try {
        await requestApi("/reading/scan-page-ocr", z.object({}));
      } catch (err) {
        caught = err;
      }
      expect(isServiceError(caught)).toBe(true);
      if (isServiceError(caught)) {
        expect(caught.message).toContain(expectedSnippet);
        expect(caught.message).not.toBe("Có lỗi xảy ra. Vui lòng thử lại sau.");
      }
    }
  });

  it("BookScannerScreen marks /health network failures as unreachable (never ready), survives transient poll 503, and cancels on unmount", async () => {
    const user = userEvent.setup();
    const cancelledJobIds: string[] = [];
    let pollCalls = 0;

    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") {
        throw new TypeError("Failed to fetch");
      }
      if (url.pathname === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (url.pathname === "/reading/scan-page-ocr/jobs") {
        return Response.json(
          {
            job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            status: "QUEUED",
            worker_online: true,
            created_at: "2026-11-26T00:00:00Z",
            updated_at: "2026-11-26T00:00:00Z",
            error_code: null,
            error_message: null,
            result: null,
          },
          { status: 202 },
        );
      }
      if (
        url.pathname ===
        "/reading/scan-page-ocr/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      ) {
        if ((init?.method ?? "GET").toUpperCase() === "DELETE") {
          cancelledJobIds.push("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
          return Response.json({ status: "CANCELLED" });
        }
        pollCalls += 1;
        if (pollCalls === 1) {
          return Response.json(
            { detail: "Database temporarily unavailable" },
            { status: 503 },
          );
        }
        return Response.json({
          job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "RUNNING",
          worker_online: true,
          created_at: "2026-11-26T00:00:00Z",
          updated_at: "2026-11-26T00:00:02Z",
          error_code: null,
          error_message: null,
          result: null,
        });
      }
      return Response.json({}, { status: 404 });
    });

    const { unmount } = render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <BookScannerScreen />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    expect(
      await screen.findByTestId("ocr-worker-offline-banner"),
    ).toBeInTheDocument();

    const input = screen.getByTestId(
      "local-ocr-file-input",
    ) as HTMLInputElement;
    const file = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      "page.png",
      { type: "image/png" },
    );
    await user.upload(input, file);

    expect(await screen.findByTestId("async-ocr-job-card")).toBeInTheDocument();

    // Unmount mid-queue -> must issue cancel request for activeJobIdRef.
    unmount();
    await waitFor(() => {
      expect(cancelledJobIds).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    });
  });

  it("CameraPreview pauses autoScan and shows clear banner on 503 remote OCR offline (stopping 1.8s upload storm)", async () => {
    const scanCalls: number[] = [];
    const fakeTrack = {
      readyState: "live",
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
    const fakeStream = {
      getTracks: () => [fakeTrack],
      getVideoTracks: () => [fakeTrack],
    } as unknown as MediaStream;

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream),
      },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) =>
      cb(new Blob(["jpeg"], { type: "image/jpeg" })),
    );

    apiFetchFixture.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/reading/match-page") {
        scanCalls.push(Date.now());
        return Response.json(
          {
            detail:
              "Remote OCR worker is offline; live page scan is temporarily unavailable.",
          },
          { status: 503 },
        );
      }
      return Response.json({}, { status: 404 });
    });

    const { container } = render(<CameraPreview enableScanner />);
    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", {
      value: 4,
      configurable: true,
    });
    Object.defineProperty(video, "videoWidth", {
      value: 1200,
      configurable: true,
    });
    Object.defineProperty(video, "videoHeight", {
      value: 1600,
      configurable: true,
    });

    const scanBtn = await screen.findByRole("button", {
      name: /Chụp & Quét ngay/i,
    });
    await waitFor(() => expect(scanBtn).not.toBeDisabled());
    fireEvent.click(scanBtn);

    const banner = await screen.findByTestId("camera-ocr-unavailable-banner");
    expect(banner).toHaveTextContent(/ngoại tuyến/i);
    expect(
      screen.getByRole("button", { name: /Tự động quét: ĐANG TẮT/i }),
    ).toBeInTheDocument();
    expect(scanCalls.length).toBe(1);
  });

  it("AdminPageService polls multi-page document uploads via single batch /ocr-jobs endpoint and tolerates transient 503", async () => {
    const batchCalls: string[] = [];
    const singleJobCalls: string[] = [];
    let batchPollCount = 0;

    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (
        url.pathname === `/books/admin/catalog/${BOOK_ID}/documents/jobs` &&
        init?.method === "POST"
      ) {
        return Response.json(
          {
            book_id: BOOK_ID,
            source_format: "PDF",
            total_source_pages: 2,
            job_ids: ["job-1", "job-2"],
            queued_count: 2,
            worker_online: true,
            jobs: [
              { id: "job-1", job_kind: "ADMIN_PAGE_UPLOAD", status: "QUEUED" },
              { id: "job-2", job_kind: "ADMIN_PAGE_UPLOAD", status: "QUEUED" },
            ],
          },
          { status: 202 },
        );
      }
      if (url.pathname === `/books/admin/catalog/${BOOK_ID}/ocr-jobs`) {
        batchCalls.push(url.pathname);
        batchPollCount += 1;
        if (batchPollCount === 1) {
          return Response.json(
            { detail: "Database temporarily unavailable" },
            { status: 503 },
          );
        }
        return Response.json([
          { id: "job-1", job_kind: "ADMIN_PAGE_UPLOAD", status: "SUCCEEDED" },
          { id: "job-2", job_kind: "ADMIN_PAGE_UPLOAD", status: "SUCCEEDED" },
        ]);
      }
      if (url.pathname.startsWith("/books/admin/ocr-jobs/")) {
        singleJobCalls.push(url.pathname);
        return Response.json({
          id: "job-1",
          job_kind: "ADMIN_PAGE_UPLOAD",
          status: "SUCCEEDED",
        });
      }
      if (url.pathname === `/books/admin/catalog/${BOOK_ID}/pages`) {
        return Response.json([]);
      }
      return Response.json({}, { status: 404 });
    });

    const svc = createAdminPageService({
      pollIntervalMs: 5,
      maxPollAttempts: 10,
    });
    const progressEvents: Array<Record<string, unknown>> = [];
    const pdfFile = new File(["%PDF-1.4 mock"], "sample.pdf", {
      type: "application/pdf",
    });

    await svc.upload(
      BOOK_ID,
      [
        {
          client_id: "doc-1",
          file_name: "sample.pdf",
          mime_type: "application/pdf",
          size_bytes: pdfFile.size,
          upload_kind: "document",
          file: pdfFile,
        },
      ],
      (p) => progressEvents.push(p as unknown as Record<string, unknown>),
    );

    expect(batchCalls.length).toBe(2);
    expect(singleJobCalls.length).toBe(0);
    const finalProgress = progressEvents[progressEvents.length - 1];
    expect(finalProgress?.created_pages_count).toBe(2);
    expect(finalProgress?.progress_percent).toBe(100);
  });

  it("AdminPageUploader displays OCR worker offline warning banner when /health reports ocr.ready=false", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          ocr: { mode: "remote_worker", ready: false },
        });
      }
      return Response.json({}, { status: 200 });
    });

    render(
      <AdminServicesProvider>
        <AdminPageUploader bookId={BOOK_ID} onUploaded={vi.fn()} />
      </AdminServicesProvider>,
    );

    expect(
      await screen.findByTestId("admin-ocr-worker-offline-banner"),
    ).toHaveTextContent(/Dịch vụ xử lý OCR hiện đang ngoại tuyến/i);
  });

  it("OcrReviewService runCombinedWorkflow fails cleanly instead of spinning forever when stuck QUEUED", async () => {
    vi.useFakeTimers();
    const sha = "a".repeat(64);
    const queuedWorkflow = {
      workflow_id: WORKFLOW_ID,
      page_id: PAGE_ID,
      book_id: BOOK_ID,
      page_revision_id: REV_ID,
      status: "QUEUED",
      stage: "PROOFREADING",
      progress: { completed_chunks: 0, total_chunks: 1 },
      attempts: 0,
      error_code: null,
      original_ocr_hash: sha,
      admin_input_hash: sha,
      proofread_text: null,
      proofread_output_hash: null,
      corrections: [],
      uncertain_word_indices: [],
      proofread_metadata: {},
      safety_metadata: {},
      candidate_history: [],
      safety_history: [],
      review_history: [],
      candidate_text: null,
      candidate_hash: null,
      candidate_version: 0,
      safety_input_hash: null,
      hash_match: false,
      suitability: null,
      safety_status: "PENDING",
      findings: [],
      provider_events: [],
      ocr_approved_at: null,
      final_approved_text_hash: null,
      created_at: "2026-11-26T00:00:00Z",
      updated_at: "2026-11-26T00:00:00Z",
    };

    apiFetchFixture.mockImplementation(async () =>
      Response.json(queuedWorkflow),
    );

    const svc = createOcrReviewService();
    const promise = svc.runCombinedWorkflow(PAGE_ID, REV_ID, "Xin chào", []);
    const caughtPromise = promise.catch((err: unknown) => err);

    for (let i = 0; i < 25; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
    }

    const error = await caughtPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/chờ worker xử lý quá lâu/i);
  });
});
