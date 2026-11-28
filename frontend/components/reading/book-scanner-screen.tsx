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
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useRouter } from "next/navigation";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button, ButtonLink } from "@/components/common/button";
import { OcrServiceStatusBanner } from "@/components/common/ocr-service-status-banner";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { CameraPreview } from "@/components/reading/camera-preview";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useOcrWorkerStatus } from "@/hooks/use-ocr-worker-status";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import {
  cancelScanPageOcrJob,
  enqueueScanPageOcrJob,
  getScanPageOcrJob,
  listScanPageOcrJobs,
  scanPageImageWithLocalOcr,
  type LocalOcrPageScanDTO,
  type LocalOcrPageScanJobDTO,
  type LocalOcrScanJobStatus,
} from "@/lib/api/page-match-service";
import { isServiceError } from "@/lib/api/service-error";
import {
  readStoredScanJobId,
  writeStoredScanJobId,
} from "@/lib/cache/scan-job-storage";
import { preprocessScanImage } from "@/lib/reading/scan-image-preprocess";
import { cn } from "@/lib/utils/cn";
import type { ReadingPageDTO } from "@/types/reading";

function dispatchTasksChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("viread:tasks-changed"));
  }
}

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

const POLL_INTERVAL_WORKER_ONLINE_MS = 2_000;
const POLL_INTERVAL_ONLINE_MAX_MS = 6_000;
const POLL_INTERVAL_WORKER_OFFLINE_MS = 12_000;
const POLL_INTERVAL_OFFLINE_MAX_MS = 15_000;
const MAX_ONLINE_POLL_ATTEMPTS = 120;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;
const QUEUED_JOBS_PAGE_SIZE = 5;

function formatQueuedTimeLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(parsed));
  } catch {
    return null;
  }
}

function isActiveScanJobStatus(
  status: LocalOcrScanJobStatus,
): status is Extract<
  LocalOcrScanJobStatus,
  "QUEUED" | "CLAIMED" | "RUNNING" | "FAILED_RETRYABLE"
> {
  return (
    status === "QUEUED" ||
    status === "CLAIMED" ||
    status === "RUNNING" ||
    status === "FAILED_RETRYABLE"
  );
}

function isTransientPollError(error: unknown): boolean {
  if (isServiceError(error)) {
    return (
      error.retryable ||
      error.status === 0 ||
      error.status === 429 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504
    );
  }
  return error instanceof TypeError;
}

function waitUntilVisible(signal: AbortSignal): Promise<void> {
  if (
    typeof document === "undefined" ||
    document.visibilityState !== "hidden"
  ) {
    return Promise.resolve();
  }
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      signal.removeEventListener("abort", onAbort);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") {
        cleanup();
        resolve();
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    document.addEventListener("visibilitychange", onVisibility);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function sleepWithAbortOrWake(
  ms: number,
  signal: AbortSignal,
  registerWake?: (wake: (() => void) | null) => void,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      registerWake?.(null);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const wakeNow = () => {
      cleanup();
      resolve();
    };
    const timer = window.setTimeout(wakeNow, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    registerWake?.(wakeNow);
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
      readonly progressPct: number | null;
      readonly workerPhase: string | null;
      readonly fileName: string;
      readonly file: File | null;
      readonly wasOptimized: boolean;
      readonly idempotencyKey: string | null;
      readonly createdAt: string | null;
      readonly queuePosition: number | null;
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
  const authRuntime = useAuthRuntime();
  const actorUserId =
    authRuntime.session?.user?.id ?? authRuntime.initialUserId ?? null;
  const t = useTranslations("ocr");
  const tc = useTranslations("child");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const [cameraStarted, setCameraStarted] = useState(false);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);
  const [ocrState, setOcrState] = useState<LocalOcrScanState>({
    status: "idle",
  });
  const [queuedJobs, setQueuedJobs] = useState<
    readonly LocalOcrPageScanJobDTO[]
  >([]);
  const [queuedJobsPage, setQueuedJobsPage] = useState(1);
  const [checkingQueueNow, setCheckingQueueNow] = useState(false);

  const queuedJobsRef = useRef<readonly LocalOcrPageScanJobDTO[]>([]);
  useEffect(() => {
    queuedJobsRef.current = queuedJobs;
  }, [queuedJobs]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);
  const ocrAbortRef = useRef<AbortController | null>(null);
  const pollWakeRef = useRef<(() => void) | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const activeJobWorkerOnlineRef = useRef<boolean>(false);
  const ocrGenerationRef = useRef(0);
  const startPollingQueuedJobRef = useRef<
    ((job: LocalOcrPageScanJobDTO) => void) | null
  >(null);

  const refreshQueuedJobs = useCallback(async () => {
    try {
      const listed = await listScanPageOcrJobs({ activeOnly: true, limit: 10 });
      const activeItems = listed.jobs.filter((job) =>
        isActiveScanJobStatus(job.status),
      );
      setQueuedJobs(activeItems);
    } catch {
      // Older backend or isolated test mock without GET /reading/scan-page-ocr/jobs: stay quiet.
    }
  }, []);

  const ocrWorker = useOcrWorkerStatus({
    onRecovered: () => {
      pollWakeRef.current?.();
      void refreshQueuedJobs();
    },
  });

  useEffect(() => {
    return () => {
      // Stop local polling cleanly on unmount. Keep offline-queued jobs durably
      // saved across reloads/navigation; only cancel an abandoned live interactive
      // scan when the OCR worker is online.
      ocrGenerationRef.current += 1;
      ocrAbortRef.current?.abort();
      ocrAbortRef.current = null;
      pollWakeRef.current = null;
      const jobIdToCancel = activeJobIdRef.current;
      const wasWorkerOnline = activeJobWorkerOnlineRef.current;
      activeJobIdRef.current = null;
      activeJobWorkerOnlineRef.current = false;
      if (jobIdToCancel && wasWorkerOnline) {
        void cancelScanPageOcrJob(jobIdToCancel).catch(() => undefined);
      }
    };
  }, []);

  const upsertQueuedJob = useCallback((job: LocalOcrPageScanJobDTO) => {
    setQueuedJobs((current) => {
      if (!isActiveScanJobStatus(job.status)) {
        return current.filter((item) => item.job_id !== job.job_id);
      }
      const exists = current.some((item) => item.job_id === job.job_id);
      if (!exists) return [job, ...current];
      return current.map((item) => (item.job_id === job.job_id ? job : item));
    });
  }, []);

  const pollScanJobLoop = useCallback(
    async (
      initialJob: LocalOcrPageScanJobDTO,
      options: {
        readonly generation: number;
        readonly controller: AbortController;
        readonly fileName: string;
        readonly file: File | null;
        readonly wasOptimized: boolean;
        readonly idempotencyKey: string | null;
      },
    ) => {
      const { generation, controller, file, wasOptimized, idempotencyKey } =
        options;
      activeJobIdRef.current = initialJob.job_id;
      activeJobWorkerOnlineRef.current = initialJob.worker_online;
      writeStoredScanJobId(actorUserId, initialJob.job_id);
      let currentJob = initialJob;
      let onlineAttempts = 0;
      let offlineAttempts = 0;

      while (true) {
        if (
          generation !== ocrGenerationRef.current ||
          controller.signal.aborted
        ) {
          return;
        }

        const resolvedFileName =
          currentJob.file_name || options.fileName || "book-page.jpg";
        activeJobWorkerOnlineRef.current = currentJob.worker_online;
        upsertQueuedJob(currentJob);

        if (currentJob.status === "SUCCEEDED" && currentJob.result) {
          activeJobIdRef.current = null;
          activeJobWorkerOnlineRef.current = false;
          writeStoredScanJobId(actorUserId, null);
          dispatchTasksChanged();
          void refreshQueuedJobs();
          setOcrState({
            status: "succeeded",
            fileName: resolvedFileName,
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
          activeJobWorkerOnlineRef.current = false;
          writeStoredScanJobId(actorUserId, null);
          dispatchTasksChanged();
          const remaining = queuedJobsRef.current.filter(
            (item) => item.job_id !== currentJob.job_id,
          );
          if (currentJob.status === "CANCELLED" && remaining.length > 0) {
            startPollingQueuedJobRef.current?.(remaining[0]);
            return;
          }
          void refreshQueuedJobs();
          setOcrState({
            status: "error",
            fileName: resolvedFileName,
            file,
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
          progressPct: currentJob.progress_pct ?? null,
          workerPhase: currentJob.worker_phase ?? null,
          fileName: resolvedFileName,
          file,
          wasOptimized,
          idempotencyKey,
          createdAt: currentJob.created_at ?? null,
          queuePosition: currentJob.queue_position ?? null,
        });

        let pollDelay: number;
        if (currentJob.worker_online) {
          onlineAttempts += 1;
          offlineAttempts = 0;
          if (onlineAttempts > MAX_ONLINE_POLL_ATTEMPTS) {
            activeJobIdRef.current = null;
            activeJobWorkerOnlineRef.current = false;
            setOcrState({
              status: "error",
              fileName: resolvedFileName,
              file,
              idempotencyKey,
              message: t("scanner.errorQueuedTooLong"),
              authExpired: false,
              retryable: true,
            });
            return;
          }
          const backoffStep = Math.min(3, Math.floor((onlineAttempts - 1) / 3));
          pollDelay = Math.min(
            POLL_INTERVAL_ONLINE_MAX_MS,
            Math.round(
              POLL_INTERVAL_WORKER_ONLINE_MS * Math.pow(1.4, backoffStep),
            ),
          );
        } else {
          // Laptop OCR worker is offline: keep the job durably queued forever without erroring,
          // and poll politely every 12-15s (pausing on hidden tabs) to protect Render DB.
          onlineAttempts = 0;
          offlineAttempts += 1;
          pollDelay =
            offlineAttempts <= 2
              ? POLL_INTERVAL_WORKER_OFFLINE_MS
              : POLL_INTERVAL_OFFLINE_MAX_MS;
        }

        await sleepWithAbortOrWake(pollDelay, controller.signal, (wake) => {
          pollWakeRef.current = wake;
        });
        await waitUntilVisible(controller.signal);

        if (
          generation !== ocrGenerationRef.current ||
          controller.signal.aborted
        ) {
          return;
        }

        let transientFailures = 0;
        while (true) {
          try {
            currentJob = await getScanPageOcrJob(
              currentJob.job_id,
              controller.signal,
            );
            setCheckingQueueNow(false);
            void refreshQueuedJobs();
            break;
          } catch (pollErr) {
            if (
              generation !== ocrGenerationRef.current ||
              controller.signal.aborted ||
              (pollErr instanceof Error && pollErr.name === "AbortError")
            ) {
              throw pollErr;
            }
            transientFailures += 1;
            if (
              !isTransientPollError(pollErr) ||
              transientFailures > MAX_CONSECUTIVE_POLL_ERRORS
            ) {
              throw pollErr;
            }
            const retryDelay = Math.min(
              POLL_INTERVAL_OFFLINE_MAX_MS,
              POLL_INTERVAL_WORKER_ONLINE_MS *
                Math.pow(2, transientFailures - 1),
            );
            await sleepWithAbortOrWake(
              retryDelay,
              controller.signal,
              (wake) => {
                pollWakeRef.current = wake;
              },
            );
            await waitUntilVisible(controller.signal);
          }
        }
      }
    },
    [actorUserId, refreshQueuedJobs, t, upsertQueuedJob],
  );

  const startPollingQueuedJob = useCallback(
    (job: LocalOcrPageScanJobDTO) => {
      ocrAbortRef.current?.abort();
      const controller = new AbortController();
      ocrAbortRef.current = controller;
      const generation = ++ocrGenerationRef.current;
      void pollScanJobLoop(job, {
        generation,
        controller,
        fileName: job.file_name || "book-page.jpg",
        file: null,
        wasOptimized: false,
        idempotencyKey: null,
      }).catch(() => undefined);
    },
    [pollScanJobLoop],
  );

  useEffect(() => {
    startPollingQueuedJobRef.current = startPollingQueuedJob;
  }, [startPollingQueuedJob]);

  // Keep remaining queued pages updated when active card is showing a finished/idle state.
  useEffect(() => {
    if (
      queuedJobs.length === 0 ||
      ocrState.status === "queued" ||
      ocrState.status === "processing"
    ) {
      return;
    }
    const intervalMs = ocrWorker.isReady
      ? POLL_INTERVAL_WORKER_ONLINE_MS * 2
      : POLL_INTERVAL_WORKER_OFFLINE_MS;
    let timerId: number | null = null;
    let disposed = false;

    const scheduleNext = () => {
      if (disposed) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      timerId = window.setTimeout(() => {
        if (disposed) return;
        void refreshQueuedJobs().finally(() => {
          if (!disposed) {
            scheduleNext();
          }
        });
      }, intervalMs);
    };

    const onVisibility = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      if (!disposed && document.visibilityState !== "hidden") {
        void refreshQueuedJobs().finally(() => {
          if (!disposed) {
            scheduleNext();
          }
        });
      }
    };

    scheduleNext();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      disposed = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [
    ocrState.status,
    ocrWorker.isReady,
    queuedJobs.length,
    refreshQueuedJobs,
  ]);

  // Restore parent's active queued LOCAL_PAGE_SCAN jobs across page reloads.
  const childReadyId =
    childState.status === "ready" ? childState.child.id : null;
  useEffect(() => {
    if (!childReadyId) return;
    let active = true;
    const restoreController = new AbortController();

    async function restoreQueuedScans() {
      try {
        const listed = await listScanPageOcrJobs({
          activeOnly: true,
          limit: 10,
          signal: restoreController.signal,
        });
        if (!active || restoreController.signal.aborted) return;
        const activeItems = listed.jobs.filter((job) =>
          isActiveScanJobStatus(job.status),
        );
        setQueuedJobs(activeItems);

        if (activeItems.length > 0 && ocrGenerationRef.current === 0) {
          startPollingQueuedJob(activeItems[0]);
          return;
        }

        const storedJobId = readStoredScanJobId(actorUserId);
        if (storedJobId && ocrGenerationRef.current === 0) {
          const savedJob = await getScanPageOcrJob(
            storedJobId,
            restoreController.signal,
          );
          if (!active || restoreController.signal.aborted) return;
          if (savedJob.status === "SUCCEEDED" && savedJob.result) {
            writeStoredScanJobId(actorUserId, null);
            setOcrState({
              status: "succeeded",
              fileName: savedJob.file_name || "book-page.jpg",
              wasOptimized: false,
              result: savedJob.result,
            });
          } else if (
            savedJob.status === "DEAD_LETTER" ||
            savedJob.status === "CANCELLED"
          ) {
            writeStoredScanJobId(actorUserId, null);
          }
        }
      } catch {
        // Older backend or isolated test mock without GET /reading/scan-page-ocr/jobs: stay quiet.
      }
    }

    void restoreQueuedScans();
    return () => {
      active = false;
      restoreController.abort();
    };
  }, [actorUserId, childReadyId, pollScanJobLoop, startPollingQueuedJob]);

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

        upsertQueuedJob(job);
        dispatchTasksChanged();

        await pollScanJobLoop(job, {
          generation,
          controller,
          fileName: uploadFile.name,
          file: uploadFile,
          wasOptimized,
          idempotencyKey,
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
        setCheckingQueueNow(false);
      }
    },
    [bookId, pollScanJobLoop, t, upsertQueuedJob],
  );

  const handleCheckQueuedNow = useCallback(() => {
    setCheckingQueueNow(true);
    void ocrWorker.recheckNow();
    if (pollWakeRef.current) {
      pollWakeRef.current();
      void refreshQueuedJobs();
    } else {
      void refreshQueuedJobs().finally(() => setCheckingQueueNow(false));
    }
  }, [ocrWorker, refreshQueuedJobs]);

  const handleCancelSpecificQueuedJob = useCallback(
    (jobId: string) => {
      const remaining = queuedJobsRef.current.filter(
        (item) => item.job_id !== jobId,
      );
      setQueuedJobs(remaining);
      void cancelScanPageOcrJob(jobId)
        .catch(() => undefined)
        .finally(() => {
          dispatchTasksChanged();
        });
      if (activeJobIdRef.current === jobId) {
        ocrGenerationRef.current += 1;
        ocrAbortRef.current?.abort();
        ocrAbortRef.current = null;
        pollWakeRef.current = null;
        activeJobIdRef.current = null;
        activeJobWorkerOnlineRef.current = false;
        writeStoredScanJobId(actorUserId, null);
        if (remaining.length > 0) {
          startPollingQueuedJob(remaining[0]);
        } else {
          setOcrState({ status: "idle" });
        }
      }
    },
    [actorUserId, startPollingQueuedJob],
  );

  const handleCancelOcr = useCallback(() => {
    ocrGenerationRef.current += 1;
    ocrAbortRef.current?.abort();
    ocrAbortRef.current = null;
    pollWakeRef.current = null;
    const jobIdToCancel = activeJobIdRef.current;
    activeJobIdRef.current = null;
    activeJobWorkerOnlineRef.current = false;
    writeStoredScanJobId(actorUserId, null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (nativeCameraInputRef.current) nativeCameraInputRef.current.value = "";
    if (jobIdToCancel) {
      const remaining = queuedJobsRef.current.filter(
        (item) => item.job_id !== jobIdToCancel,
      );
      setQueuedJobs(remaining);
      void cancelScanPageOcrJob(jobIdToCancel)
        .catch(() => undefined)
        .finally(() => {
          dispatchTasksChanged();
        });
      if (remaining.length > 0) {
        startPollingQueuedJob(remaining[0]);
        return;
      }
    }
    setOcrState({ status: "idle" });
  }, [actorUserId, startPollingQueuedJob]);

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

  const isScanProcessing = ocrState.status === "processing";
  const isScanQueued = ocrState.status === "queued";
  const isScanQueuedOffline =
    isScanQueued &&
    !ocrState.workerOnline &&
    (ocrState.jobStatus === "QUEUED" ||
      ocrState.jobStatus === "FAILED_RETRYABLE");

  const scanRealPercent = isScanProcessing
    ? ocrState.stage === "optimizing"
      ? 15
      : 35
    : isScanQueued
      ? isScanQueuedOffline
        ? 2
        : typeof ocrState.progressPct === "number" &&
            Number.isFinite(ocrState.progressPct)
          ? ocrState.progressPct
          : ocrState.jobStatus === "RUNNING"
            ? 55
            : ocrState.jobStatus === "CLAIMED"
              ? 30
              : ocrState.jobStatus === "FAILED_RETRYABLE"
                ? 15
                : 12
      : null;

  const scanProgressStages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.preparing") },
      { atPct: 22, label: tCommon("aiProgress.uploading") },
      { atPct: 45, label: tCommon("aiProgress.ocrExtracting") },
      { atPct: 82, label: tCommon("aiProgress.finalizing") },
    ],
    [tCommon],
  );

  const scanResetKey = isScanQueued
    ? `queued:${ocrState.jobId}:${isScanQueuedOffline ? "offline" : "online"}`
    : isScanProcessing
      ? `processing:${ocrState.idempotencyKey}`
      : ocrState.status;

  const scanProgress = useAiProgress({
    active: isScanProcessing || isScanQueued,
    realPercent: scanRealPercent,
    progressMode: isScanQueuedOffline ? "measured" : "staged",
    stages: scanProgressStages,
    expectedDurationMs: 14_000,
    completed: ocrState.status === "succeeded",
    failed: ocrState.status === "error",
    resetKey: scanResetKey,
  });

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
  const hideOfflineBannerForActiveQueuedCard =
    ocrState.status === "queued" && !ocrState.workerOnline;
  const listedQueuedJobs =
    ocrState.status === "queued"
      ? queuedJobs.filter((item) => item.job_id !== ocrState.jobId)
      : queuedJobs;
  const queuedJobsTotalPages = Math.max(
    1,
    Math.ceil(listedQueuedJobs.length / QUEUED_JOBS_PAGE_SIZE),
  );
  const safeQueuedJobsPage = Math.min(
    Math.max(1, queuedJobsPage),
    queuedJobsTotalPages,
  );
  const visibleListedQueuedJobs = listedQueuedJobs.slice(
    (safeQueuedJobsPage - 1) * QUEUED_JOBS_PAGE_SIZE,
    safeQueuedJobsPage * QUEUED_JOBS_PAGE_SIZE,
  );

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

      {!(hideOfflineBannerForActiveQueuedCard && !ocrWorker.justRecovered) ? (
        <OcrServiceStatusBanner
          isChecking={ocrWorker.isChecking}
          justRecovered={ocrWorker.justRecovered}
          onDismissRecovered={ocrWorker.dismissRecoveredNotice}
          onRecheck={handleCheckQueuedNow}
          queuedCount={
            queuedJobs.length > 0 ? queuedJobs.length : ocrWorker.queueDepth
          }
          status={ocrWorker.status}
          variant="parent"
        />
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
          <AiProgressBar
            active
            elapsedSeconds={scanProgress.elapsedSeconds}
            label={
              ocrState.stage === "optimizing"
                ? tCommon("aiProgress.preparing")
                : tCommon("aiProgress.uploading")
            }
            percent={scanProgress.percent}
            size="md"
            testId="scanner-processing-progress"
          />
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
                {!ocrState.workerOnline &&
                (ocrState.jobStatus === "QUEUED" ||
                  ocrState.jobStatus === "FAILED_RETRYABLE") ? (
                  <p className="mt-1 text-sm text-amber-900/90">
                    {t("scanner.jobSubtitleQueuedOffline")}
                  </p>
                ) : null}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-muted">
                  {ocrState.queuePosition ? (
                    <span data-testid="ocr-queue-position">
                      {t("scanner.queuePositionLabel", {
                        position: formatNumber(ocrState.queuePosition),
                      })}
                    </span>
                  ) : null}
                  {formatQueuedTimeLabel(ocrState.createdAt) ? (
                    <span data-testid="ocr-queue-created-at">
                      {t("scanner.savedAtLabel", {
                        time: formatQueuedTimeLabel(ocrState.createdAt)!,
                      })}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-sm text-muted">
                  {ocrState.fileName}
                </p>
              </div>
            </div>
          </div>
          <AiProgressBar
            active={!isScanQueuedOffline}
            detail={
              ocrState.queuePosition
                ? t("scanner.queuePositionLabel", {
                    position: formatNumber(ocrState.queuePosition),
                  })
                : undefined
            }
            elapsedSeconds={
              isScanQueuedOffline ? undefined : scanProgress.elapsedSeconds
            }
            label={
              isScanQueuedOffline
                ? tCommon("aiProgress.waitingWorker")
                : (scanProgress.stageLabel ??
                  tCommon("aiProgress.ocrExtracting"))
            }
            percent={scanProgress.percent}
            size="md"
            testId="scanner-queued-progress"
            tone={isScanQueuedOffline ? "warning" : "primary"}
          />
          <div className="flex flex-wrap gap-2.5">
            <Button
              className="min-h-12 sm:w-auto"
              data-testid="check-queued-ocr-now"
              disabled={checkingQueueNow}
              onClick={handleCheckQueuedNow}
              variant="secondary"
            >
              <RefreshCw
                aria-hidden="true"
                className={cn("size-4", checkingQueueNow && "animate-spin")}
              />
              {t("scanner.checkQueueNow")}
            </Button>
            {!ocrState.workerOnline ? (
              <Button
                className="min-h-12 sm:w-auto"
                data-testid="scan-another-while-queued"
                onClick={() => fileInputRef.current?.click()}
                variant="secondary"
              >
                <FileImage aria-hidden="true" className="size-4" />
                {t("scanner.scanAnotherPageQueued")}
              </Button>
            ) : null}
            <Button
              className="min-h-12 sm:w-auto"
              data-testid="cancel-queued-ocr-job"
              onClick={handleCancelOcr}
              variant="secondary"
            >
              <X aria-hidden="true" className="size-5" />
              {ocrState.workerOnline
                ? t("scanner.cancelScan")
                : t("scanner.cancelQueuedTask")}
            </Button>
          </div>
        </div>
      ) : null}

      {listedQueuedJobs.length > 0 ? (
        <div
          className="flex flex-col gap-3 rounded-card border border-amber-300/90 bg-amber-50/50 p-4"
          data-testid="queued-scan-jobs-list"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-bold text-ink">
              {ocrState.status === "queued"
                ? t("scanner.queuedListHeading", {
                    count: formatNumber(queuedJobs.length),
                  })
                : t(
                    "scanner.queuedListStandaloneHeading",
                    {
                      count: formatNumber(listedQueuedJobs.length),
                    },
                    "Các trang đang lưu trong hàng chờ ({count} trang)",
                  )}
            </p>
            {ocrState.status !== "queued" ? (
              <Button
                className="min-h-9 sm:w-auto"
                data-testid="check-queued-list-now"
                disabled={checkingQueueNow}
                onClick={handleCheckQueuedNow}
                size="compact"
                variant="secondary"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={cn("size-3.5", checkingQueueNow && "animate-spin")}
                />
                {t("scanner.checkQueueNow")}
              </Button>
            ) : null}
          </div>
          <ul className="space-y-1.5">
            {visibleListedQueuedJobs.map((item) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border bg-white/90 px-3 py-2 text-xs"
                key={item.job_id}
              >
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-ink">
                    {item.file_name || "book-page.jpg"}
                  </span>
                  {item.queue_position ? (
                    <span className="ms-2 text-muted">
                      #{formatNumber(item.queue_position)}
                    </span>
                  ) : null}
                  {formatQueuedTimeLabel(item.created_at) ? (
                    <span className="ms-2 text-muted">
                      · {formatQueuedTimeLabel(item.created_at)}
                    </span>
                  ) : null}
                </div>
                <button
                  className="inline-flex min-h-8 items-center gap-1 rounded-control border border-border px-2.5 font-semibold text-muted hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
                  onClick={() => handleCancelSpecificQueuedJob(item.job_id)}
                  type="button"
                >
                  <X aria-hidden="true" className="size-3.5" />
                  {t("scanner.cancelQueuedTask")}
                </button>
              </li>
            ))}
          </ul>
          <PaginationBar
            compact
            onPageChange={setQueuedJobsPage}
            page={safeQueuedJobsPage}
            pageSize={QUEUED_JOBS_PAGE_SIZE}
            total={listedQueuedJobs.length}
          />
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
                ocrState.status === "processing" ||
                (ocrState.status === "queued" && ocrState.workerOnline)
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
                ocrState.status === "processing" ||
                (ocrState.status === "queued" && ocrState.workerOnline)
              }
              onClick={() => fileInputRef.current?.click()}
              variant="secondary"
            >
              <FileImage aria-hidden="true" className="size-5" />
              {ocrWorker.status === "unavailable"
                ? t(
                    "scanner.selectImageOfflineQueue",
                    undefined,
                    "Chụp / Tải ảnh vào hàng chờ OCR",
                  )
                : t("scanner.selectImageButton")}
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
