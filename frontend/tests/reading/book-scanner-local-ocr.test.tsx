import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
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

const MATCHED_BOOK_ID = "60ffdba4-1790-482a-963a-a7351e5ea58a";
const MATCHED_PAGE_ID = "77777777-7777-4777-8777-777777777777";
const MATCHED_REV_ID = "88888888-8888-4888-8888-888888888888";
const WORD_ID = "99999999-9999-4999-8999-999999999991";

const ocrSuccessPayload = {
  scan_job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  request_id: "req-local-ocr-001",
  idempotency_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  status: "SUCCEEDED",
  ocr_text: "Buổi sáng mùa thu trời trong xanh.",
  word_count: 7,
  words: [
    {
      word_index: 0,
      line_index: 0,
      text: "Buổi",
      normalized_text: "buổi",
      bbox: [0.1, 0.1, 0.1, 0.05],
      ocr_confidence: 0.98,
    },
  ],
  provenance: {
    engine: "paddleocr_vietocr_dual",
    device: "cuda",
    engine_statuses: {
      paddleocr: "success",
      vietocr: "success",
      tesseract: "success",
    },
    model_profile: "FLOW1_EXTERNAL_TRDG",
    checkpoint_sha256:
      "200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6",
    model_load_status: "loaded",
    cloud_ocr_used: false,
    elapsed_ms: 4200,
  },
  matched: true,
  matched_book_id: MATCHED_BOOK_ID,
  matched_book_title: "NHỮNG NGƯỜI KHỐN KHỔ",
  match_confidence: 0.92,
  matched_page: {
    page_id: MATCHED_PAGE_ID,
    page_revision_id: MATCHED_REV_ID,
    page_number: 2,
    confidence: 0.92,
    width: 1000,
    height: 1400,
    words: [
      {
        word_id: WORD_ID,
        word_index: 0,
        text: "Buổi",
        bbox: [0.1, 0.1, 0.1, 0.05],
      },
    ],
  },
  message:
    "Đã nhận diện tiếng Việt bằng OCR cục bộ và khớp Trang 2 của sách “NHỮNG NGƯỜI KHỐN KHỔ”.",
};

function renderScanner() {
  return render(
    <WithSelectedChild childId={TEST_CHILD_ID}>
      <AppServicesProvider>
        <BookScannerScreen />
      </AppServicesProvider>
    </WithSelectedChild>,
  );
}

function makePageFile(name = "trang-1.png", type = "image/png") {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, {
    type,
  });
}

beforeEach(() => {
  installApiFetchFixture();
  pushMock.mockReset();
  replaceMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BookScannerScreen local OCR photo upload", () => {
  it("uploads a selected image, renders Vietnamese OCR text + provenance, and navigates to matched page", async () => {
    const user = userEvent.setup();
    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/reading/scan-page-ocr/jobs") {
        return Response.json(
          {
            job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            status: "SUCCEEDED",
            worker_online: true,
            created_at: "2026-11-25T10:00:00Z",
            updated_at: "2026-11-25T10:00:02Z",
            error_code: null,
            error_message: null,
            result: ocrSuccessPayload,
          },
          { status: 202, headers: { "X-Request-ID": "req-local-ocr-001" } },
        );
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    renderScanner();
    await screen.findByRole("button", { name: /Chọn ảnh trang sách/i });

    const input = screen.getByTestId(
      "local-ocr-file-input",
    ) as HTMLInputElement;
    await user.upload(input, makePageFile());

    expect(await screen.findByTestId("local-ocr-text")).toHaveTextContent(
      "Buổi sáng mùa thu trời trong xanh.",
    );
    expect(
      screen.queryByText("paddleocr_vietocr_dual"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("CUDA")).not.toBeInTheDocument();
    expect(screen.queryByText("req-local-ocr-001")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Mở Trang 2 để bắt đầu đọc/i }),
    );
    expect(pushMock).toHaveBeenCalledWith(
      `/books/${MATCHED_BOOK_ID}?pageId=${MATCHED_PAGE_ID}&confidence=0.92`,
    );
  });

  it("shows processing state and allows canceling an in-flight OCR scan cleanly", async () => {
    const user = userEvent.setup();
    let capturedSignal: AbortSignal | undefined;

    apiFetchFixture.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/reading/scan-page-ocr/jobs") {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return await new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          });
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    renderScanner();
    await screen.findByRole("button", { name: /Chọn ảnh trang sách/i });

    const input = screen.getByTestId(
      "local-ocr-file-input",
    ) as HTMLInputElement;
    await user.upload(input, makePageFile());

    expect(
      await screen.findByText(
        /Đang gửi ảnh tới hệ thống nhận diện trang sách tiếng Việt/i,
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Hủy quét/i }));
    expect(capturedSignal?.aborted).toBe(true);
    await waitFor(() => {
      expect(
        screen.queryByText(
          /Đang gửi ảnh tới hệ thống nhận diện trang sách tiếng Việt/i,
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("handles retryable OCR failure with the exact same idempotency_key on retry", async () => {
    const user = userEvent.setup();
    const seenKeys: string[] = [];
    let attempt = 0;

    apiFetchFixture.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/reading/scan-page-ocr/jobs") {
        return Response.json({ detail: "Not Found" }, { status: 404 });
      }
      if (path === "/reading/scan-page-ocr") {
        attempt += 1;
        const form = init?.body as FormData;
        seenKeys.push(String(form.get("idempotency_key") ?? ""));
        if (attempt === 1) {
          return Response.json(
            { detail: "Local OCR processing timed out; please retry" },
            { status: 504 },
          );
        }
        return Response.json(ocrSuccessPayload);
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    renderScanner();
    await screen.findByRole("button", { name: /Chọn ảnh trang sách/i });
    const input = screen.getByTestId(
      "local-ocr-file-input",
    ) as HTMLInputElement;
    await user.upload(input, makePageFile());

    expect(
      await screen.findByText(
        /Nhận diện trang sách xử lý quá thời gian cho phép/i,
      ),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Thử lại với ảnh này/i }),
    );
    expect(await screen.findByTestId("local-ocr-text")).toHaveTextContent(
      "Buổi sáng mùa thu trời trong xanh.",
    );
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBeTruthy();
    expect(seenKeys[0]).toBe(seenKeys[1]);
  });

  it("shows explicit expired-session action on 401 and ignores canceled file selection", async () => {
    const user = userEvent.setup();
    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/reading/scan-page-ocr/jobs") {
        return Response.json({ detail: "Unauthorized" }, { status: 401 });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    renderScanner();
    await screen.findByRole("button", { name: /Chọn ảnh trang sách/i });
    const input = screen.getByTestId(
      "local-ocr-file-input",
    ) as HTMLInputElement;

    // Canceled file chooser (empty files) keeps clean state
    fireEvent.change(input, { target: { files: [] } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // 401 shows expired session link to /login
    await user.upload(input, makePageFile());
    expect(
      await screen.findByText(/Phiên đăng nhập đã hết hạn/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Đăng nhập lại/i }),
    ).toHaveAttribute("href", "/login");
  });

  it("paginates queued scan jobs at 5 per page when many pages are queued", async () => {
    const user = userEvent.setup();
    const queuedList = Array.from({ length: 8 }, (_, index) => ({
      job_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`,
      status: "QUEUED",
      worker_online: false,
      file_name: `trang-cho-${index + 1}.jpg`,
      queue_position: index + 1,
      created_at: "2026-11-25T10:00:00Z",
      updated_at: "2026-11-25T10:00:00Z",
      error_code: null,
      error_message: null,
      result: null,
    }));

    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/reading/scan-page-ocr/jobs") {
        return Response.json({ jobs: queuedList });
      }
      if (path === "/ocr/worker-status") {
        return Response.json({
          status: "unavailable",
          worker_online: false,
          queue_depth: 8,
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    renderScanner();

    // Job 1 is the active card; Jobs 2..8 (7 jobs) are in listedQueuedJobs -> 5 on page 1, 2 on page 2
    const listRegion = await screen.findByTestId("queued-scan-jobs-list");
    expect(listRegion).toHaveTextContent("trang-cho-2.jpg");
    expect(listRegion).toHaveTextContent("trang-cho-6.jpg");
    expect(listRegion).not.toHaveTextContent("trang-cho-7.jpg");
    expect(listRegion).toHaveTextContent("Trang 1 / 2");

    await user.click(screen.getByRole("button", { name: /Sau/i }));
    expect(listRegion).toHaveTextContent("trang-cho-7.jpg");
    expect(listRegion).toHaveTextContent("trang-cho-8.jpg");
    expect(listRegion).not.toHaveTextContent("trang-cho-2.jpg");
    expect(listRegion).toHaveTextContent("Trang 2 / 2");
  });
});
