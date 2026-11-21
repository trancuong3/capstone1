"use client";

import {
  Camera,
  CheckCircle2,
  FileImage,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useRouter } from "next/navigation";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { CameraPreview } from "@/components/reading/camera-preview";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import {
  scanPageImageWithLocalOcr,
  type LocalOcrPageScanDTO,
} from "@/lib/api/page-match-service";
import { isServiceError } from "@/lib/api/service-error";
import { cn } from "@/lib/utils/cn";
import type { ReadingPageDTO } from "@/types/reading";

interface BookScannerScreenProps {
  bookId?: string;
}

const MAX_SCAN_FILE_BYTES = 12 * 1024 * 1024;
const ALLOWED_SCAN_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

function createIdempotencyKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
}

type LocalOcrScanState =
  | { readonly status: "idle" }
  | {
      readonly status: "processing";
      readonly fileName: string;
      readonly file: File;
      readonly idempotencyKey: string;
    }
  | {
      readonly status: "succeeded";
      readonly fileName: string;
      readonly result: LocalOcrPageScanDTO;
    }
  | {
      readonly status: "error";
      readonly fileName: string;
      readonly file: File | null;
      readonly idempotencyKey: string | null;
      readonly message: string;
      readonly authExpired: boolean;
      readonly retryable: boolean;
    };

export function BookScannerScreen({ bookId }: BookScannerScreenProps) {
  const router = useRouter();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const [cameraStarted, setCameraStarted] = useState(false);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);
  const [ocrState, setOcrState] = useState<LocalOcrScanState>({
    status: "idle",
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ocrAbortRef = useRef<AbortController | null>(null);
  const ocrGenerationRef = useRef(0);

  useEffect(() => {
    return () => {
      ocrGenerationRef.current += 1;
      ocrAbortRef.current?.abort();
      ocrAbortRef.current = null;
    };
  }, []);

  const handleCameraUnavailable = useCallback(() => {
    setCameraUnavailable(true);
    setCameraStarted(false);
  }, []);

  const handleBookPageDetected = useCallback(
    (
      matchedBookId: string,
      matchedPage: ReadingPageDTO,
      confidence: number,
    ) => {
      if (!matchedBookId || !matchedPage.page_id) return;
      setCameraStarted(false);
      const params = new URLSearchParams({ pageId: matchedPage.page_id });
      if (Number.isFinite(confidence))
        params.set("confidence", String(confidence));
      router.push(
        `/books/${encodeURIComponent(matchedBookId)}?${params.toString()}`,
      );
    },
    [router],
  );

  const runLocalOcrUpload = useCallback(
    async (file: File, idempotencyKey: string, childId: string) => {
      ocrAbortRef.current?.abort();
      const controller = new AbortController();
      ocrAbortRef.current = controller;
      const generation = ++ocrGenerationRef.current;

      setCameraStarted(false);
      setOcrState({
        status: "processing",
        fileName: file.name,
        file,
        idempotencyKey,
      });

      try {
        const result = await scanPageImageWithLocalOcr(file, {
          fileName: file.name,
          bookId,
          childId,
          idempotencyKey,
          signal: controller.signal,
        });
        if (
          generation !== ocrGenerationRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        setOcrState({
          status: "succeeded",
          fileName: file.name,
          result,
        });
      } catch (error) {
        if (
          generation !== ocrGenerationRef.current ||
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return;
        }
        const authExpired =
          isServiceError(error) && error.code === "AUTH_REQUIRED";
        const retryable = isServiceError(error)
          ? error.retryable || error.status === 504 || error.status === 0
          : true;
        const message = authExpired
          ? "Phiên đăng nhập đã hết hạn. Ba mẹ vui lòng đăng nhập lại để tiếp tục quét trang sách."
          : isServiceError(error)
            ? error.message
            : "Không thể gửi ảnh tới máy chủ OCR cục bộ. Ba mẹ hãy thử lại nhé.";
        setOcrState({
          status: "error",
          fileName: file.name,
          file,
          idempotencyKey,
          message,
          authExpired,
          retryable,
        });
      } finally {
        if (ocrAbortRef.current === controller) {
          ocrAbortRef.current = null;
        }
      }
    },
    [bookId],
  );

  const handleCancelOcr = useCallback(() => {
    ocrGenerationRef.current += 1;
    ocrAbortRef.current?.abort();
    ocrAbortRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
    setOcrState({ status: "idle" });
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>, childId: string) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        // User canceled the system file picker; keep previous clean state.
        return;
      }
      const mime = (file.type || "").toLowerCase();
      const lowerName = file.name.toLowerCase();
      const validExt =
        lowerName.endsWith(".jpg") ||
        lowerName.endsWith(".jpeg") ||
        lowerName.endsWith(".png") ||
        lowerName.endsWith(".webp");
      if (mime && !ALLOWED_SCAN_MIME_TYPES.has(mime) && !validExt) {
        setOcrState({
          status: "error",
          fileName: file.name,
          file: null,
          idempotencyKey: null,
          message:
            "Định dạng ảnh chưa hỗ trợ. Hãy chọn ảnh JPG, PNG hoặc WebP.",
          authExpired: false,
          retryable: false,
        });
        return;
      }
      if (file.size <= 0 || file.size > MAX_SCAN_FILE_BYTES) {
        setOcrState({
          status: "error",
          fileName: file.name,
          file: null,
          idempotencyKey: null,
          message:
            file.size <= 0
              ? "Tệp ảnh bị rỗng. Ba mẹ hãy chọn ảnh khác nhé."
              : "Ảnh vượt quá giới hạn dung lượng 12 MB. Hãy chọn ảnh nhỏ hơn nhé.",
          authExpired: false,
          retryable: false,
        });
        return;
      }
      void runLocalOcrUpload(file, createIdempotencyKey(), childId);
    },
    [runLocalOcrUpload],
  );

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[960px] px-4 py-8"
      >
        <span className="sr-only" role="status">
          Đang xác minh hồ sơ trẻ…
        </span>
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title="Không thể xác minh hồ sơ trẻ" tone="error">
          Chưa thể xác nhận hồ sơ thuộc tài khoản hiện tại. Ba mẹ vui lòng thử
          lại.
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }

  const child = childState.child;

  return (
    <section
      className={cn(
        "mx-auto flex w-full flex-col gap-6",
        cameraStarted ? "max-w-[1120px]" : "max-w-[960px]",
      )}
    >
      <header className="border-b border-border pb-5">
        <div>
          <p className="text-label font-semibold text-muted">
            {child.alias} · Lớp {child.grade}
          </p>
          <h1 className="mt-1 text-heading font-extrabold text-ink">
            Đưa trang sách vào khung camera
          </h1>
          <p className="mt-2 max-w-[720px] text-body leading-7 text-muted">
            Đặt sách ngay ngắn, đủ sáng và giữ trọn trang trong khung, hoặc chọn
            ảnh trang sách có sẵn để nhận diện chữ tiếng Việt bằng OCR cục bộ.
          </p>
        </div>
      </header>

      <input
        ref={fileInputRef}
        accept="image/jpeg,image/png,image/webp"
        aria-label="Chọn ảnh trang sách để quét OCR"
        className="sr-only"
        data-testid="local-ocr-file-input"
        onChange={(event) => handleFileChange(event, child.id)}
        type="file"
      />

      {ocrState.status === "processing" ? (
        <div
          aria-live="polite"
          className="flex flex-col gap-4 rounded-card border border-border bg-white p-5 sm:p-6"
          role="status"
        >
          <div className="flex items-center gap-3">
            <Sparkles
              aria-hidden="true"
              className="size-6 shrink-0 animate-spin text-primary"
            />
            <div className="min-w-0">
              <p className="text-base font-extrabold text-ink">
                Đang gửi ảnh và chạy OCR tiếng Việt cục bộ…
              </p>
              <p className="truncate text-sm text-muted">{ocrState.fileName}</p>
            </div>
          </div>
          <Button
            className="min-h-12 sm:w-auto sm:self-start"
            onClick={handleCancelOcr}
            variant="secondary"
          >
            <X aria-hidden="true" className="size-5" />
            Hủy quét
          </Button>
        </div>
      ) : null}

      {ocrState.status === "error" ? (
        <div className="flex flex-col gap-3">
          <StatusMessage title="Chưa quét được trang sách" tone="error">
            {ocrState.message}
          </StatusMessage>
          <div className="flex flex-wrap gap-3">
            {ocrState.authExpired ? (
              <ButtonLink className="min-h-12 sm:w-auto" href="/login">
                Đăng nhập lại
              </ButtonLink>
            ) : null}
            {!ocrState.authExpired &&
            ocrState.retryable &&
            ocrState.file &&
            ocrState.idempotencyKey ? (
              <Button
                className="min-h-12 sm:w-auto"
                onClick={() =>
                  void runLocalOcrUpload(
                    ocrState.file!,
                    ocrState.idempotencyKey!,
                    child.id,
                  )
                }
              >
                <RotateCcw aria-hidden="true" className="size-5" />
                Thử lại với ảnh này
              </Button>
            ) : null}
            <Button
              className="min-h-12 sm:w-auto"
              onClick={handleCancelOcr}
              variant="secondary"
            >
              Chọn ảnh khác
            </Button>
          </div>
        </div>
      ) : null}

      {ocrState.status === "succeeded" ? (
        <section
          aria-label="Kết quả nhận diện OCR tiếng Việt"
          className="flex flex-col gap-4 rounded-card border border-emerald-200 bg-white p-5 shadow-sm sm:p-6"
          data-testid="local-ocr-result"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 size-6 shrink-0 text-emerald-600"
              />
              <div>
                <h2 className="text-lg font-extrabold text-ink">
                  Kết quả OCR tiếng Việt (máy chủ cục bộ)
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {ocrState.result.message}
                </p>
              </div>
            </div>
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-800">
              {ocrState.result.word_count} từ ·{" "}
              {ocrState.result.provenance.elapsed_ms} ms
            </span>
          </div>

          <div
            className="max-h-60 overflow-y-auto rounded-2xl border border-border bg-cream p-4 text-base leading-relaxed whitespace-pre-wrap text-ink"
            data-testid="local-ocr-text"
          >
            {ocrState.result.ocr_text}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              Engine:{" "}
              <strong className="text-ink">
                {ocrState.result.provenance.engine}
              </strong>
            </span>
            <span>
              Thiết bị:{" "}
              <strong className="text-ink">
                {ocrState.result.provenance.device.toUpperCase()}
              </strong>
            </span>
            <span>
              Mã tác vụ:{" "}
              <code className="text-ink">{ocrState.result.scan_job_id}</code>
            </span>
            {ocrState.result.request_id ? (
              <span>
                Mã yêu cầu:{" "}
                <code className="text-ink">{ocrState.result.request_id}</code>
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-3">
            {ocrState.result.matched &&
            ocrState.result.matched_book_id &&
            ocrState.result.matched_page ? (
              <Button
                className="min-h-14 sm:w-auto"
                onClick={() =>
                  handleBookPageDetected(
                    ocrState.result.matched_book_id!,
                    ocrState.result.matched_page!,
                    ocrState.result.match_confidence,
                  )
                }
              >
                Mở Trang {ocrState.result.matched_page.page_number} để bắt đầu
                đọc
              </Button>
            ) : (
              <ButtonLink className="min-h-14 sm:w-auto" href="/books">
                Mở thư viện để bắt đầu buổi đọc
              </ButtonLink>
            )}
            <Button
              className="min-h-14 sm:w-auto"
              onClick={() => fileInputRef.current?.click()}
              variant="secondary"
            >
              <FileImage aria-hidden="true" className="size-5" />
              Quét ảnh khác
            </Button>
          </div>
        </section>
      ) : null}

      {cameraUnavailable ? (
        <StatusMessage title="Camera chưa sẵn sàng" tone="error">
          Không thể mở camera hoặc quyền camera đã bị thay đổi. Hãy cho phép
          camera trong cài đặt trình duyệt hoặc chọn ảnh trang sách từ máy để
          quét OCR.
        </StatusMessage>
      ) : null}

      {cameraStarted ? (
        <CameraPreview
          bookId={bookId}
          enableScanner
          onCameraUnavailable={handleCameraUnavailable}
          onBookPageDetected={handleBookPageDetected}
        />
      ) : (
        <div className="flex min-h-[380px] flex-col items-center justify-center gap-4 rounded-card bg-desk p-6 text-center">
          <Camera aria-hidden="true" className="size-14 text-primary" />
          <div>
            <h2 className="text-2xl font-extrabold text-ink">
              Camera đang tắt
            </h2>
            <p className="mt-6 max-w-[620px] text-body text-muted">
              Camera chỉ bật khi ba mẹ chọn nút bên dưới. Ba mẹ cũng có thể chọn
              ảnh trang sách từ thiết bị để máy chủ ViRead chạy OCR tiếng Việt
              cục bộ.
            </p>
          </div>
          <div className="flex w-full flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              className="min-h-16 w-full sm:max-w-[300px]"
              onClick={() => {
                setCameraUnavailable(false);
                setCameraStarted(true);
              }}
            >
              Bật camera để quét
            </Button>
            <Button
              className="min-h-16 w-full sm:max-w-[320px]"
              disabled={ocrState.status === "processing"}
              onClick={() => fileInputRef.current?.click()}
              variant="secondary"
            >
              <FileImage aria-hidden="true" className="size-5" />
              Chọn ảnh trang sách (OCR)
            </Button>
          </div>
        </div>
      )}

      {!cameraUnavailable ? (
        <div className="rounded-card bg-sky p-4">
          <h2 className="font-extrabold text-ink">Sau khi nhận diện</h2>
          <p className="mt-2 text-body text-muted">
            ViRead mở chi tiết sách để ba mẹ chọn phạm vi trang. Microphone được
            kiểm tra ở bước chuẩn bị đọc.
          </p>
        </div>
      ) : null}

      {!cameraStarted || cameraUnavailable ? (
        <ButtonLink
          className="min-h-16 sm:max-w-[400px]"
          href="/books"
          variant="secondary"
        >
          Chọn sách từ thư viện
        </ButtonLink>
      ) : null}
    </section>
  );
}
