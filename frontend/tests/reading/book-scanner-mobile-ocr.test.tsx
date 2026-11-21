import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
import { CameraPreview } from "@/components/reading/camera-preview";
import {
  computeOcrOptimalDimensions,
  preprocessScanImage,
  readJpegExifOrientation,
} from "@/lib/reading/scan-image-preprocess";
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
        data: { session: { access_token: "mobile-ocr-test-token" } },
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

function buildJpegWithExifOrientation(orientation: number): ArrayBuffer {
  // Minimal valid JPEG SOI + APP1 Exif (little-endian II) + Orientation tag 0x0112 + EOI
  const buf = new ArrayBuffer(40);
  const view = new DataView(buf);
  view.setUint16(0, 0xffd8, false); // SOI
  view.setUint16(2, 0xffe1, false); // APP1
  view.setUint16(4, 34, false); // APP1 length
  view.setUint32(6, 0x45786966, false); // "Exif"
  view.setUint16(10, 0x0000, false); // "\0\0"
  // TIFF header at offset 12
  view.setUint16(12, 0x4949, false); // "II" little-endian
  view.setUint16(14, 0x002a, true); // TIFF magic 42
  view.setUint32(16, 8, true); // IFD0 offset = 8 -> byte 20
  view.setUint16(20, 1, true); // 1 directory entry
  view.setUint16(22, 0x0112, true); // Orientation tag
  view.setUint16(24, 3, true); // SHORT
  view.setUint32(26, 1, true); // count = 1
  view.setUint16(30, orientation, true); // value
  view.setUint32(34, 0, true); // next IFD = 0
  view.setUint16(38, 0xffd9, false); // EOI
  return buf;
}

const ocrSuccessPayload = {
  scan_job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  request_id: "req-mobile-ocr-01",
  idempotency_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  status: "SUCCEEDED",
  ocr_text: "Cánh đồng lúa chín vàng rực dưới nắng thu.",
  word_count: 9,
  words: [
    {
      word_index: 0,
      line_index: 0,
      text: "Cánh",
      normalized_text: "cánh",
      bbox: [0.1, 0.12, 0.12, 0.04],
      ocr_confidence: 0.99,
    },
  ],
  provenance: {
    engine: "paddleocr_vietocr_dual",
    device: "cpu",
    engine_statuses: {
      paddleocr: "success",
      vietocr: "success",
      tesseract: "success",
    },
    model_profile: "FLOW1_EXTERNAL_TRDG",
    checkpoint_sha256: "200edce4",
    model_load_status: "loaded",
    cloud_ocr_used: false,
    elapsed_ms: 1450,
  },
  matched: true,
  matched_book_id: BOOK_ID,
  matched_book_title: "Tiếng Việt Lớp 2",
  match_confidence: 0.95,
  matched_page: {
    page_id: PAGE_ID,
    page_revision_id: REV_ID,
    page_number: 3,
    confidence: 0.95,
    width: 1536,
    height: 2048,
    words: [
      {
        word_id: "99999999-9999-4999-8999-999999999999",
        word_index: 0,
        text: "Cánh",
        bbox: [0.1, 0.12, 0.12, 0.04],
      },
    ],
  },
  message: "Đã khớp Trang 3.",
};

beforeEach(() => {
  installApiFetchFixture();
  pushMock.mockReset();
  replaceMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Mobile Book Scanner & EXIF/Resolution OCR Pre-processing", () => {
  it("parses JPEG EXIF orientation 1..8 and computes upright OCR-optimal dimensions", () => {
    for (const expected of [1, 3, 6, 8]) {
      const buf = buildJpegWithExifOrientation(expected);
      expect(readJpegExifOrientation(buf)).toBe(expected);
    }

    // 4032x3024 raw sensor landscape rotated 90 CW (EXIF 6) -> 1536x2048 upright portrait
    const rotated = computeOcrOptimalDimensions(4032, 3024, 6, 2048);
    expect(rotated.swappedAxes).toBe(true);
    expect(rotated.scaled).toBe(true);
    expect(rotated.width).toBe(1536);
    expect(rotated.height).toBe(2048);

    // Compact upright 1200x1600 page -> untouched dimensions
    const compact = computeOcrOptimalDimensions(1200, 1600, 1, 2048);
    expect(compact.swappedAxes).toBe(false);
    expect(compact.scaled).toBe(false);
    expect(compact.width).toBe(1200);
    expect(compact.height).toBe(1600);
  });

  it("normalizes an oversized EXIF-rotated 48MP phone photo before sending to local OCR", async () => {
    const closeBitmap = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 4000,
        height: 3000,
        close: closeBitmap,
      })),
    );

    const transformSpy = vi.fn();
    const drawImageSpy = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        ({
          fillStyle: "",
          imageSmoothingEnabled: true,
          imageSmoothingQuality: "high",
          fillRect: vi.fn(),
          save: vi.fn(),
          restore: vi.fn(),
          transform: transformSpy,
          drawImage: drawImageSpy,
        }) as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      function (this: HTMLCanvasElement, cb: BlobCallback) {
        cb(new Blob(["optimized-upright-jpeg"], { type: "image/jpeg" }));
      },
    );

    const exifBytes = buildJpegWithExifOrientation(6);
    const rawCameraPhoto = new File([exifBytes], "IMG_20261122.JPG", {
      type: "image/jpeg",
    });

    const prepared = await preprocessScanImage(rawCameraPhoto);
    expect(prepared.wasTransformed).toBe(true);
    expect(prepared.exifOrientation).toBe(6);
    expect(prepared.width).toBe(1536);
    expect(prepared.height).toBe(2048);
    expect(prepared.file.type).toBe("image/jpeg");
    expect(prepared.file.name).toBe("IMG_20261122.jpg");
    expect(transformSpy).toHaveBeenCalledWith(0, 1, -1, 0, 1536, 0);
    expect(drawImageSpy).toHaveBeenCalled();
    expect(closeBitmap).toHaveBeenCalled();

    // PDF and DOCX files MUST pass through untouched
    const pdfFile = new File(["%PDF-1.7"], "sach.pdf", {
      type: "application/pdf",
    });
    const pdfPrepared = await preprocessScanImage(pdfFile);
    expect(pdfPrepared.wasTransformed).toBe(false);
    expect(pdfPrepared.file).toBe(pdfFile);
  });

  it("renders portrait-first viewport, avoids overlapping auto-scan spam, and recovers camera on first tap after viread:android-background", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let activeTrackStop = vi.fn();
    let getUserMediaCalls = 0;

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          getUserMediaCalls += 1;
          activeTrackStop = vi.fn();
          const track = {
            readyState: "live",
            stop: activeTrackStop,
            addEventListener: vi.fn(),
          };
          return {
            getVideoTracks: () => [track],
            getTracks: () => [track],
          } as unknown as MediaStream;
        }),
      },
    });

    Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
      configurable: true,
      get: () => 4,
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        ({
          drawImage: vi.fn(),
        }) as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => {
      cb(new Blob(["frame-jpeg"], { type: "image/jpeg" }));
    });

    let inFlightScans = 0;
    let maxConcurrentScans = 0;
    let totalScanCalls = 0;
    let resolveSlowScan: (() => void) | null = null;

    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/reading/match-page") {
        totalScanCalls += 1;
        inFlightScans += 1;
        maxConcurrentScans = Math.max(maxConcurrentScans, inFlightScans);
        await new Promise<void>((resolve) => {
          resolveSlowScan = resolve;
        });
        inFlightScans -= 1;
        return Response.json({
          framing_valid: true,
          matched: false,
          status_code: "LOW_CONFIDENCE",
          message: "Giữ sách yên thêm chút nữa.",
          confidence: 0.45,
          matched_page: null,
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <AppServicesProvider>
        <CameraPreview enableScanner />
      </AppServicesProvider>,
    );

    const viewport = await screen.findByTestId("scanner-camera-viewport");
    expect(viewport.className).toContain("aspect-[3/4]");
    expect(viewport.className).toContain("sm:aspect-[16/10]");

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Chụp & Quét ngay/i }),
      ).not.toBeDisabled();
    });

    // Trigger manual shutter -> 1 scan in flight
    fireEvent.click(screen.getByRole("button", { name: /Chụp & Quét ngay/i }));
    await waitFor(() => expect(totalScanCalls).toBe(1));

    // Advance 6 seconds while scan #1 is still in flight -> sequential loop MUST NOT spam a 2nd overlapping request!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(totalScanCalls).toBe(1);
    expect(maxConcurrentScans).toBe(1);

    // Finish scan #1
    await act(async () => {
      resolveSlowScan?.();
    });

    // Simulate Android Activity entering background -> tracks stop immediately & "Bật lại camera" appears
    act(() => {
      document.dispatchEvent(new Event("viread:android-background"));
    });
    expect(activeTrackStop).toHaveBeenCalledTimes(1);

    const resumeBtn = await screen.findByRole("button", {
      name: /Bật lại camera/i,
    });
    // First tap on "Bật lại camera" immediately reacquires the camera without staying deadlocked!
    fireEvent.click(resumeBtn);
    await waitFor(() => expect(getUserMediaCalls).toBe(2));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Chụp & Quét ngay/i }),
      ).not.toBeDisabled();
    });
  });

  it("validates supported vs unsupported formats and supports native camera capture input", async () => {
    const user = userEvent.setup({ applyAccept: false });
    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/reading/scan-page-ocr") {
        return Response.json(ocrSuccessPayload);
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

    await screen.findByRole("button", { name: /Chụp bằng Camera máy/i });
    const nativeInput = screen.getByTestId(
      "native-camera-ocr-input",
    ) as HTMLInputElement;
    expect(nativeInput).toHaveAttribute("capture", "environment");

    const fileInput = screen.getByTestId(
      "local-ocr-file-input",
    ) as HTMLInputElement;

    // Reject 0-byte file
    await user.upload(
      fileInput,
      new File([], "empty.jpg", { type: "image/jpeg" }),
    );
    expect(await screen.findByText(/Tệp ảnh bị rỗng/i)).toBeInTheDocument();

    // Reject unsupported executable
    await user.upload(
      fileInput,
      new File(["MZ"], "malware.exe", {
        type: "application/x-msdownload",
      }),
    );
    expect(
      await screen.findByText(/Định dạng ảnh chưa hỗ trợ/i),
    ).toBeInTheDocument();

    // Accept WebP mobile camera photo and complete OCR
    const webpFile = new File(["RIFFwebpdata"], "trang-3.webp", {
      type: "image/webp",
    });
    await user.upload(fileInput, webpFile);
    expect(await screen.findByTestId("local-ocr-text")).toHaveTextContent(
      "Cánh đồng lúa chín vàng rực dưới nắng thu.",
    );
  });
});
