"use client";

import {
  Camera,
  CheckCircle2,
  Clock3,
  FileImage,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Wifi,
  WifiOff,
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
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import {
  cancelScanPageOcrJob,
  enqueueScanPageOcrJob,
  getScanPageOcrJob,
  scanPageImageWithLocalOcr,
  type LocalOcrPageScanDTO,
  type LocalOcrPageScanJobDTO,
  type LocalOcrScanJobStatus,
} from "@/lib/api/page-match-service";
import { isServiceError } from "@/lib/api/service-error";
import { preprocessScanImage } from "@/lib/reading/scan-image-preprocess";
import { getApiBaseUrl } from "@/lib/supabase/config";
import { cn } from "@/lib/utils/cn";
import type { ReadingPageDTO } from "@/types/reading";

interface BookScannerScreenProps {
  bookId?: string;
}

const MAX_RAW_CAMERA_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_FILE_BYTES = 12 * 1024 * 1024;
const ALLOWED_SCAN_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/x-png",
  "image/webp",
]);

const SCAN_ACCEPT_ATTRIBUTE =
  "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

function createIdempotencyKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
}

type OcrProcessingStage = "optimizing" | "uploading";

const POLL_INTERVAL_WORKER_ONLINE_MS = 1_500;
const POLL_INTERVAL_WORKER_OFFLINE_MS = 4_000;
const MAX_POLL_ATTEMPTS = 120;

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type OcrTranslateFn = ReturnType<typeof useTranslations>;

function describeAsyncJobFailure(
  job: LocalOcrPageScanJobDTO,
  t: OcrTranslateFn,
): string {
  if (job.status === "CANCELLED") {
    return t("scanner.errorCancelled");
  }
  const code = (job.error_code ?? "").toUpperCase();
  if (code.includes("TIMEOUT")) {
    return t("scanner.errorTimeout");
  }
  if (code.includes("UNAVAILABLE") || code.includes("WORKER")) {
    return t("scanner.errorWorkerOffline");
  }
  if (job.error_message && job.error_message.trim()) {
    return t("scanner.errorWithDetail", { detail: job.error_message.trim() });
  }
  return t("scanner.errorGeneric");
}

type LocalOcrScanState =
  | { readonly status: "idle" }
  | {
      readonly status: "processing";
      readonly stage: OcrProcessingStage;
      readonly fileName: string;
      readonly file: File;
      readonly idempotencyKey: string;
    }
  | {
      readonly status: "queued";
      readonly jobId: string;
      readonly jobStatus: Extract<
        LocalOcrScanJobStatus,
        "QUEUED" | "CLAIMED" | "RUNNING" | "FAILED_RETRYABLE"
      >;
      readonly workerOnline: boolean;
      readonly fileName: string;
      readonly file: File;
      readonly wasOptimized: boolean;
      readonly idempotencyKey: string;
    }
  | {
      readonly status: "succeeded";
      readonly fileName: string;
      readonly wasOptimized: boolean;
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
  const { formatNumber } = useI18n();
  const t = useTranslations("ocr");
  const tc = useTranslations("child");
  const router = useRouter();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const [cameraStarted, setCameraStarted] = useState(false);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);
  const [ocrState, setOcrState] = useState<LocalOcrScanState>({
    status: "idle",
  });
  const [ocrWorkerStatus, setOcrWorkerStatus] = useState<
    "checking" | "ready" | "offline" | "unreachable"
  >("checking");
  const [ocrCheckNonce, setOcrCheckNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let didTimeout = false;
    const timer = globalThis.setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, 15_000);
    let active = true;

    async function checkOcrReadiness() {
      try {
        const res = await fetch(`${getApiBaseUrl()}/health`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!active) return;
        if (!res.ok) {
          setOcrWorkerStatus("unreachable");
          return;
        }
        const body = (await res.json()) as {
          ocr?: { mode?: string; ready?: boolean; probe_degraded?: boolean };
        };
        if (!active) return;
        if (body?.ocr?.probe_degraded) {
          setOcrWorkerStatus("unreachable");
        } else if (body?.ocr?.ready === false) {
          setOcrWorkerStatus("offline");
        } else {
          setOcrWorkerStatus("ready");
        }
      } catch {
        if (!active) return;
        if (didTimeout) {
          setOcrWorkerStatus("unreachable");
        } else {
          // Keep non-blocking when health probe is unavailable in isolated test/offline envs.
          setOcrWorkerStatus("ready");
        }
      } finally {
        globalThis.clearTimeout(timer);
      }
    }

    void checkOcrReadiness();
    return () => {
      active = false;
      globalThis.clearTimeout(timer);
      controller.abort();
    };
  }, [ocrCheckNonce]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);
  const ocrAbortRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
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
    async (rawFile: File, idempotencyKey: string, childId: string) => {
      ocrAbortRef.current?.abort();
      const controller = new AbortController();
      ocrAbortRef.current = controller;
      const generation = ++ocrGenerationRef.current;

      setCameraStarted(false);
      setOcrState({
        status: "processing",
        stage: "optimizing",
        fileName: rawFile.name,
        file: rawFile,
        idempotencyKey,
      });

      let uploadFile = rawFile;
      let wasOptimized = false;
      try {
        const prepared = await preprocessScanImage(rawFile, {
          signal: controller.signal,
        });
        if (
          generation !== ocrGenerationRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        uploadFile = prepared.file;
        wasOptimized = prepared.wasTransformed;

        if (uploadFile.size > MAX_SCAN_FILE_BYTES) {
          setOcrState({
            status: "error",
            fileName: rawFile.name,
            file: null,
            idempotencyKey: null,
            message: t("scanner.errorTooLargeAfterOptimize"),
            authExpired: false,
            retryable: false,
          });
          return;
        }

        setOcrState({
          status: "processing",
          stage: "uploading",
          fileName: uploadFile.name,
          file: uploadFile,
          idempotencyKey,
        });

        let job: LocalOcrPageScanJobDTO | null = null;
        try {
          job = await enqueueScanPageOcrJob(uploadFile, {
            fileName: uploadFile.name,
            bookId,
            childId,
            idempotencyKey,
            signal: controller.signal,
          });
        } catch (enqueueError) {
          if (
            generation !== ocrGenerationRef.current ||
            controller.signal.aborted ||
            (enqueueError instanceof Error &&
              enqueueError.name === "AbortError")
          ) {
            return;
          }
          const shouldFallbackToSync =
            isServiceError(enqueueError) &&
            (enqueueError.status === 404 ||
              enqueueError.status === 405 ||
              enqueueError.status === 501);
          if (!shouldFallbackToSync) {
            throw enqueueError;
          }
        }

        if (
          generation !== ocrGenerationRef.current ||
          controller.signal.aborted
        ) {
          return;
        }

        if (!job) {
          // Graceful sync fallback when backend does not expose async `/jobs`.
          const result = await scanPageImageWithLocalOcr(uploadFile, {
            fileName: uploadFile.name,
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
            fileName: uploadFile.name,
            wasOptimized,
            result,
          });
          return;
        }

        activeJobIdRef.current = job.job_id;
        let currentJob = job;

        for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
          if (
            generation !== ocrGenerationRef.current ||
            controller.signal.aborted
          ) {
            return;
          }

          if (currentJob.status === "SUCCEEDED" && currentJob.result) {
            activeJobIdRef.current = null;
            setOcrState({
              status: "succeeded",
              fileName: uploadFile.name,
              wasOptimized,
              result: currentJob.result,
            });
            return;
          }

          if (
            currentJob.status === "DEAD_LETTER" ||
            currentJob.status === "CANCELLED"
          ) {
            activeJobIdRef.current = null;
            setOcrState({
              status: "error",
              fileName: uploadFile.name,
              file: uploadFile,
              idempotencyKey,
              message: describeAsyncJobFailure(currentJob, t),
              authExpired: false,
              retryable: currentJob.status !== "CANCELLED",
            });
            return;
          }

          setOcrState({
            status: "queued",
            jobId: currentJob.job_id,
            jobStatus:
              currentJob.status === "SUCCEEDED" ? "RUNNING" : currentJob.status,
            workerOnline: currentJob.worker_online,
            fileName: uploadFile.name,
            file: uploadFile,
            wasOptimized,
            idempotencyKey,
          });

          const pollDelay = currentJob.worker_online
            ? POLL_INTERVAL_WORKER_ONLINE_MS
            : POLL_INTERVAL_WORKER_OFFLINE_MS;
          await sleepWithAbort(pollDelay, controller.signal);

          if (
            generation !== ocrGenerationRef.current ||
            controller.signal.aborted
          ) {
            return;
          }

          currentJob = await getScanPageOcrJob(
            currentJob.job_id,
            controller.signal,
          );
        }

        activeJobIdRef.current = null;
        setOcrState({
          status: "error",
          fileName: uploadFile.name,
          file: uploadFile,
          idempotencyKey,
          message: t("scanner.errorQueuedTooLong"),
          authExpired: false,
          retryable: true,
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
          ? t("scanner.errorSessionExpired")
          : isServiceError(error)
            ? error.message
            : t("scanner.errorSubmitFailed");
        setOcrState({
          status: "error",
          fileName: uploadFile.name,
          file: uploadFile,
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
    [bookId, t],
  );

  const handleCancelOcr = useCallback(() => {
    ocrGenerationRef.current += 1;
    ocrAbortRef.current?.abort();
    ocrAbortRef.current = null;
    const jobIdToCancel = activeJobIdRef.current;
    activeJobIdRef.current = null;
    if (jobIdToCancel) {
      void cancelScanPageOcrJob(jobIdToCancel).catch(() => undefined);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (nativeCameraInputRef.current) nativeCameraInputRef.current.value = "";
    setOcrState({ status: "idle" });
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>, childId: string) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
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
          message: t("scanner.errorUnsupportedFormat"),
          authExpired: false,
          retryable: false,
        });
        return;
      }
      if (file.size <= 0 || file.size > MAX_RAW_CAMERA_FILE_BYTES) {
        setOcrState({
          status: "error",
          fileName: file.name,
          file: null,
          idempotencyKey: null,
          message:
            file.size <= 0
              ? t("scanner.errorEmptyFile")
              : t("scanner.errorFileTooLarge"),
          authExpired: false,
          retryable: false,
        });
        return;
      }
      void runLocalOcrUpload(file, createIdempotencyKey(), childId);
    },
    [runLocalOcrUpload, t],
  );

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[960px] px-4 py-8"
      >
        <span className="sr-only" role="status">
          {tc("verification.loading")}
        </span>
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title={tc("verification.errorTitle")} tone="error">
          {tc("verification.errorBody")}
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" />
          {tc("verification.retry")}
        </Button>
      </section>
    );
  }

  const child = childState.child;

  return (
    <section
      className={cn(
        "mx-auto flex w-full flex-col gap-5 sm:gap-6",
        cameraStarted ? "max-w-[1120px]" : "max-w-[960px]",
      )}
    >
      <header className="border-b border-border pb-4 sm:pb-5">
        <div>
          <p className="text-label font-semibold text-muted">
            {child.alias} · {tc("switcher.gradeLabel", { grade: child.grade })}
          </p>
          <h1 className="mt-1 text-2xl font-extrabold text-ink sm:text-heading">
            {t("scanner.heading")}
          </h1>
          <p className="mt-2 max-w-[720px] text-sm leading-6 text-muted sm:text-body sm:leading-7">
            {t("scanner.guide")}
          </p>
        </div>
      </header>

      <input
        ref={fileInputRef}
        accept={SCAN_ACCEPT_ATTRIBUTE}
        aria-label={t("scanner.uploadAria")}
        className="sr-only"
        data-testid="local-ocr-file-input"
        onChange={(event) => handleFileChange(event, child.id)}
        type="file"
      />

      <input
        ref={nativeCameraInputRef}
        accept="image/jpeg"
        aria-label={t("scanner.captureAria")}
        capture="environment"
        className="sr-only"
        data-testid="native-camera-ocr-input"
        onChange={(event) => handleFileChange(event, child.id)}
        type="file"
      />

      {ocrWorkerStatus === "offline" || ocrWorkerStatus === "unreachable" ? (
        <div
          className="flex flex-col gap-3 rounded-card border border-amber-300 bg-amber-50/80 p-4"
          data-testid="ocr-worker-offline-banner"
        >
          <StatusMessage
            title={
              ocrWorkerStatus === "offline"
                ? "Máy trạm OCR hiện đang ngoại tuyến"
                : "Máy chủ OCR đang khởi động hoặc tạm chưa phản hồi"
            }
            tone="warning"
          >
            {ocrWorkerStatus === "offline"
              ? "Tính năng quét trang sách cần máy trạm OCR (remote worker) đang kết nối để nhận diện chữ tiếng Việt. Ba mẹ vẫn có thể đọc toàn bộ sách trong Thư viện bằng Wi-Fi mà không cần bật máy tính."
              : "Chưa kiểm tra được trạng thái máy trạm OCR do máy chủ đang khởi động hoặc mạng chậm. Ba mẹ bấm kiểm tra lại sau vài giây, hoặc đọc sách trực tiếp trong Thư viện nhé."}
          </StatusMessage>
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11 sm:w-auto"
              onClick={() => {
                setOcrWorkerStatus("checking");
                setOcrCheckNonce((n) => n + 1);
              }}
              size="compact"
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              Kiểm tra lại kết nối OCR
            </Button>
          </div>
        </div>
      ) : null}

      {ocrState.status === "processing" ? (
        <div
          aria-live="polite"
          className="flex flex-col gap-4 rounded-card border border-border bg-white p-4 sm:p-6"
          role="status"
        >
          <div className="flex items-start gap-3">
            <Sparkles
              aria-hidden="true"
              className="mt-0.5 size-6 shrink-0 animate-spin text-primary"
            />
            <div className="min-w-0 flex-1">
              <span className="inline-flex rounded-full bg-sky px-2.5 py-0.5 text-xs font-bold text-primary">
                {ocrState.stage === "optimizing"
                  ? t("scanner.step1Title")
                  : t("scanner.step2Title")}
              </span>
              <p className="mt-1.5 text-base font-extrabold text-ink">
                {ocrState.stage === "optimizing"
                  ? t("scanner.step1Body")
                  : t("scanner.step2Body")}
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
            {t("scanner.cancelScan")}
          </Button>
        </div>
      ) : null}

      {ocrState.status === "queued" ? (
        <div
          aria-live="polite"
          className={cn(
            "flex flex-col gap-4 rounded-card border bg-white p-4 sm:p-6",
            ocrState.workerOnline
              ? "border-primary/30"
              : "border-amber-300 bg-amber-50/40",
          )}
          data-ocr-job-status={ocrState.jobStatus}
          data-testid="async-ocr-job-card"
          role="status"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              {ocrState.jobStatus === "CLAIMED" ||
              ocrState.jobStatus === "RUNNING" ? (
                <Sparkles
                  aria-hidden="true"
                  className="mt-0.5 size-6 shrink-0 animate-spin text-primary"
                />
              ) : (
                <Clock3
                  aria-hidden="true"
                  className="mt-0.5 size-6 shrink-0 text-amber-600"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex rounded-full bg-sky px-2.5 py-0.5 text-xs font-bold text-primary">
                    {ocrState.jobStatus === "CLAIMED" ||
                    ocrState.jobStatus === "RUNNING"
                      ? t("scanner.jobStatusRunning")
                      : ocrState.jobStatus === "FAILED_RETRYABLE"
                        ? t("scanner.jobStatusRetrying")
                        : t("scanner.jobStatusQueued")}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-bold",
                      ocrState.workerOnline
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : "border-amber-300 bg-amber-100 text-amber-950",
                    )}
                    data-testid="ocr-worker-online-badge"
                  >
                    {ocrState.workerOnline ? (
                      <>
                        <Wifi aria-hidden="true" className="size-3.5" />
                        {t("scanner.workerOnline")}
                      </>
                    ) : (
                      <>
                        <WifiOff aria-hidden="true" className="size-3.5" />
                        {t("scanner.workerOffline")}
                      </>
                    )}
                  </span>
                </div>
                <p className="mt-2 text-base font-extrabold text-ink">
                  {ocrState.jobStatus === "CLAIMED" ||
                  ocrState.jobStatus === "RUNNING"
                    ? t("scanner.jobHeadlineRunning")
                    : ocrState.jobStatus === "FAILED_RETRYABLE"
                      ? t("scanner.jobHeadlineRetrying")
                      : ocrState.workerOnline
                        ? t("scanner.jobHeadlineQueuedOnline")
                        : t("scanner.jobHeadlineQueuedOffline")}
                </p>
                <p className="mt-0.5 truncate text-sm text-muted">
                  {t("scanner.jobIdMeta", { fileName: ocrState.fileName })}
                  <code className="font-mono text-xs">{ocrState.jobId}</code>
                </p>
              </div>
            </div>
          </div>
          <Button
            className="min-h-12 sm:w-auto sm:self-start"
            onClick={handleCancelOcr}
            variant="secondary"
          >
            <X aria-hidden="true" className="size-5" />
            {t("scanner.cancelScan")}
          </Button>
        </div>
      ) : null}

      {ocrState.status === "error" ? (
        <div className="flex flex-col gap-3">
          <StatusMessage title={t("scanner.scanFailedTitle")} tone="error">
            {ocrState.message}
          </StatusMessage>
          <div className="flex flex-wrap gap-3">
            {ocrState.authExpired ? (
              <ButtonLink className="min-h-12 sm:w-auto" href="/login">
                {t("scanner.relogin")}
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
                {t("scanner.retryWithSameImage")}
              </Button>
            ) : null}
            <Button
              className="min-h-12 sm:w-auto"
              onClick={handleCancelOcr}
              variant="secondary"
            >
              {t("scanner.chooseAnotherImage")}
            </Button>
          </div>
        </div>
      ) : null}

      {ocrState.status === "succeeded" ? (
        <section
          aria-label={t("scanner.resultRegionAria")}
          className="flex flex-col gap-4 rounded-card border border-emerald-200 bg-white p-4 shadow-sm sm:p-6"
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
                  {t("scanner.resultTitle")}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {ocrState.result.message}
                </p>
              </div>
            </div>
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-800">
              {t("scanner.wordCountSummary", {
                count: formatNumber(ocrState.result.word_count),
              })}
              {ocrState.result.provenance.elapsed_ms} ms
            </span>
          </div>

          <div
            className="viread-learning-content max-h-60 overflow-y-auto rounded-2xl border border-border bg-cream p-4 text-base leading-relaxed whitespace-pre-wrap text-ink"
            data-testid="local-ocr-text"
            dir="ltr"
            lang="vi"
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
              {t("scanner.deviceLabel")}
              <strong className="text-ink">
                {ocrState.result.provenance.device.toUpperCase()}
              </strong>
            </span>
            <span>
              {t("scanner.taskIdLabel")}
              <code className="break-all text-ink">
                {ocrState.result.scan_job_id}
              </code>
            </span>
            {ocrState.result.request_id ? (
              <span>
                {t("scanner.requestIdLabel")}
                <code className="break-all text-ink">
                  {ocrState.result.request_id}
                </code>
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-3">
            {ocrState.result.matched &&
            ocrState.result.matched_book_id &&
            ocrState.result.matched_page ? (
              <Button
                className="min-h-14 w-full sm:w-auto"
                onClick={() =>
                  handleBookPageDetected(
                    ocrState.result.matched_book_id!,
                    ocrState.result.matched_page!,
                    ocrState.result.match_confidence,
                  )
                }
              >
                {t("scanner.openMatchedPage", {
                  page: formatNumber(ocrState.result.matched_page.page_number),
                })}
              </Button>
            ) : (
              <ButtonLink className="min-h-14 w-full sm:w-auto" href="/books">
                {t("scanner.openLibraryForReading")}
              </ButtonLink>
            )}
            <Button
              className="min-h-14 w-full sm:w-auto"
              onClick={() => fileInputRef.current?.click()}
              variant="secondary"
            >
              <FileImage aria-hidden="true" className="size-5" />
              {t("scanner.scanAnotherImage")}
            </Button>
          </div>
        </section>
      ) : null}

      {cameraUnavailable ? (
        <StatusMessage title={t("scanner.cameraNotReadyTitle")} tone="error">
          {t("scanner.cameraNotReadyBody")}
        </StatusMessage>
      ) : null}

      {cameraStarted ? (
        <CameraPreview
          bookId={bookId}
          enableScanner
          onCameraUnavailable={handleCameraUnavailable}
          onBookPageDetected={handleBookPageDetected}
          onPickDeviceImage={() => fileInputRef.current?.click()}
        />
      ) : (
        <div className="flex min-h-[340px] flex-col items-center justify-center gap-4 rounded-card bg-desk p-5 text-center sm:min-h-[380px] sm:p-6">
          <Camera
            aria-hidden="true"
            className="size-12 text-primary sm:size-14"
          />
          <div>
            <h2 className="text-xl font-extrabold text-ink sm:text-2xl">
              {t("scanner.cameraOffTitle")}
            </h2>
            <p className="mt-3 max-w-[620px] text-sm text-muted sm:mt-4 sm:text-body">
              {t("scanner.cameraOffBody")}
            </p>
          </div>
          <div className="grid w-full max-w-[680px] grid-cols-1 gap-3 sm:grid-cols-3">
            <Button
              className="min-h-14 w-full"
              onClick={() => {
                setCameraUnavailable(false);
                setCameraStarted(true);
              }}
            >
              <Camera aria-hidden="true" className="size-5" />
              {t("scanner.enableCameraToScan")}
            </Button>
            <Button
              className="min-h-14 w-full"
              disabled={
                ocrState.status === "processing" || ocrState.status === "queued"
              }
              onClick={() => nativeCameraInputRef.current?.click()}
              variant="secondary"
            >
              <Camera aria-hidden="true" className="size-5" />
              {t("scanner.captureNativeCamera")}
            </Button>
            <Button
              className="min-h-14 w-full"
              disabled={
                ocrState.status === "processing" || ocrState.status === "queued"
              }
              onClick={() => fileInputRef.current?.click()}
              variant="secondary"
            >
              <FileImage aria-hidden="true" className="size-5" />
              {t("scanner.selectImageButton")}
            </Button>
          </div>
        </div>
      )}

      {!cameraUnavailable ? (
        <div className="rounded-card bg-sky p-4">
          <h2 className="font-extrabold text-ink">
            {t("scanner.afterMatchTitle")}
          </h2>
          <p className="mt-2 text-sm text-muted sm:text-body">
            {t("scanner.afterMatchBody")}
          </p>
        </div>
      ) : null}

      {!cameraStarted || cameraUnavailable ? (
        <ButtonLink
          className="min-h-14 sm:max-w-[400px]"
          href="/books"
          variant="secondary"
        >
          {t("scanner.chooseBookFromLibrary")}
        </ButtonLink>
      ) : null}
    </section>
  );
}
