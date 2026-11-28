import { z } from "zod";
import { requestApi } from "@/lib/api/api-client";
import {
  readingPageDtoSchema,
  sessionPageProgressSchema,
} from "@/lib/api/reading-service";
import { getApiBaseUrl } from "@/lib/supabase/config";
import type { ReadingPageDTO } from "@/types/reading";

export interface PageMatchService {
  retryCurrentPage(sessionId: string): Promise<ReadingPageDTO>;
  selectPage(
    sessionId: string,
    selectedPageId: string,
  ): Promise<ReadingPageDTO>;
}

export const cameraSpotlightPointSchema = z.tuple([z.number(), z.number()]);

export const cameraSpotlightLineSchema = z.object({
  line_index: z.number().int().nonnegative(),
  text: z.string(),
  word_count: z.number().int().positive(),
  points: z.array(cameraSpotlightPointSchema).length(4),
});

export type CameraSpotlightLineDTO = z.infer<typeof cameraSpotlightLineSchema>;

export const cameraPageMatchSchema = z.object({
  framing_valid: z.boolean(),
  matched: z.boolean(),
  book_id: z.string().optional().nullable(), // Hỗ trợ book_id trả về khi quét tổng quát
  status_code: z.enum([
    "INVALID_IMAGE",
    "TOO_DARK",
    "TOO_BLURRY",
    "OUT_OF_FRAME",
    "FRAME_OK",
    "MATCHED",
    "LOW_CONFIDENCE",
  ]),
  message: z.string(),
  confidence: z.number().min(0).max(1),
  matched_page: readingPageDtoSchema.nullable(),
  homography_matrix: z.array(z.number()).length(9).nullable().optional(),
  page_quad: z
    .array(cameraSpotlightPointSchema)
    .length(4)
    .nullable()
    .optional(),
  spotlight_lines: z.array(cameraSpotlightLineSchema).optional(),
});

export type CameraPageMatchDTO = z.infer<typeof cameraPageMatchSchema>;

export const localOcrWordSchema = z.object({
  word_index: z.number().int().nonnegative(),
  line_index: z.number().int().nonnegative(),
  text: z.string(),
  normalized_text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  ocr_confidence: z.number().min(0).max(1).nullable().optional(),
});

export const localOcrProvenanceSchema = z.object({
  engine: z.string(),
  device: z.enum(["cuda", "cpu", "unknown"]),
  engine_statuses: z.record(z.string(), z.string()),
  model_profile: z.string().nullable().optional(),
  checkpoint_sha256: z.string().nullable().optional(),
  model_load_status: z.string().nullable().optional(),
  cloud_ocr_used: z.boolean(),
  elapsed_ms: z.number().int().nonnegative(),
});

export const localOcrPageScanSchema = z.object({
  scan_job_id: z.string(),
  request_id: z.string(),
  idempotency_key: z.string().nullable().optional(),
  status: z.literal("SUCCEEDED"),
  ocr_text: z.string(),
  word_count: z.number().int().nonnegative(),
  words: z.array(localOcrWordSchema),
  provenance: localOcrProvenanceSchema,
  matched: z.boolean(),
  matched_book_id: z.string().nullable().optional(),
  matched_book_title: z.string().nullable().optional(),
  match_confidence: z.number().min(0).max(1),
  matched_page: readingPageDtoSchema.nullable(),
  message: z.string(),
});

export type LocalOcrPageScanDTO = z.infer<typeof localOcrPageScanSchema>;

export const localOcrScanJobStatusSchema = z.enum([
  "QUEUED",
  "CLAIMED",
  "RUNNING",
  "FAILED_RETRYABLE",
  "SUCCEEDED",
  "DEAD_LETTER",
  "CANCELLED",
]);

export type LocalOcrScanJobStatus = z.infer<typeof localOcrScanJobStatusSchema>;

export const localOcrPageScanJobSchema = z.object({
  job_id: z.string(),
  status: localOcrScanJobStatusSchema,
  worker_online: z.boolean(),
  progress_pct: z.number().min(0).max(100).nullable().optional(),
  worker_phase: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  file_name: z.string().nullable().optional(),
  queue_position: z.number().int().positive().nullable().optional(),
  error_code: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  result: localOcrPageScanSchema.nullable().optional(),
});

export type LocalOcrPageScanJobDTO = z.infer<typeof localOcrPageScanJobSchema>;

export const localOcrPageScanJobListSchema = z.object({
  worker_online: z.boolean(),
  jobs: z.array(localOcrPageScanJobSchema),
});

export type LocalOcrPageScanJobListDTO = z.infer<
  typeof localOcrPageScanJobListSchema
>;

export type OcrWorkerHealthStatus = "ready" | "unavailable" | "unreachable";

export interface OcrWorkerHealthSnapshot {
  readonly status: OcrWorkerHealthStatus;
  readonly mode: string | null;
  readonly ready: boolean;
  readonly workerOnline: boolean;
  readonly queuedCount: number;
  readonly queueDepth: number;
  readonly probeDegraded: boolean;
}

function makeUnreachableSnapshot(): OcrWorkerHealthSnapshot {
  return {
    status: "unreachable",
    mode: null,
    ready: false,
    workerOnline: false,
    queuedCount: 0,
    queueDepth: 0,
    probeDegraded: false,
  };
}

export async function fetchOcrWorkerHealth(
  signal?: AbortSignal,
): Promise<OcrWorkerHealthSnapshot> {
  if (typeof fetch !== "function") {
    return makeUnreachableSnapshot();
  }
  try {
    const response = await fetch(`${getApiBaseUrl()}/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      signal,
    });
    if (!response.ok) {
      return makeUnreachableSnapshot();
    }
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object") {
      return makeUnreachableSnapshot();
    }
    const ocr = (raw as Record<string, unknown>).ocr;
    if (!ocr || typeof ocr !== "object" || Array.isArray(ocr)) {
      return makeUnreachableSnapshot();
    }
    const rec = ocr as Record<string, unknown>;
    const mode =
      typeof rec.mode === "string" && rec.mode.trim() ? rec.mode.trim() : null;
    const ready = rec.ready === true;
    const hasExplicitReady = typeof rec.ready === "boolean";
    const probeDegraded = rec.probe_degraded === true;
    const workers = Array.isArray(rec.workers) ? rec.workers : [];
    const anyReadyWorkerOnline = workers.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return false;
      }
      const worker = item as Record<string, unknown>;
      if (!worker.online || worker.ready === false) {
        return false;
      }
      const workerStatus =
        typeof worker.status === "string"
          ? worker.status.trim().toUpperCase()
          : "";
      if (
        workerStatus === "DEGRADED" ||
        workerStatus === "STARTING" ||
        workerStatus === "OFFLINE"
      ) {
        return false;
      }
      return true;
    });
    const workerOnline = hasExplicitReady
      ? ready
      : mode === "remote_worker"
        ? anyReadyWorkerOnline
        : false;
    const queueObj =
      rec.queue && typeof rec.queue === "object"
        ? (rec.queue as Record<string, unknown>)
        : null;
    const queueDepth =
      typeof queueObj?.queued === "number" && Number.isFinite(queueObj.queued)
        ? Math.max(0, Math.floor(queueObj.queued))
        : 0;
    const status: OcrWorkerHealthStatus = probeDegraded
      ? "unreachable"
      : workerOnline
        ? "ready"
        : "unavailable";
    return {
      status,
      mode,
      ready,
      workerOnline,
      queuedCount: queueDepth,
      queueDepth,
      probeDegraded,
    };
  } catch {
    return makeUnreachableSnapshot();
  }
}

export async function enqueueScanPageOcrJob(
  file: Blob,
  options: {
    readonly fileName?: string;
    readonly bookId?: string;
    readonly childId?: string;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<LocalOcrPageScanJobDTO> {
  const formData = new FormData();
  formData.append("file", file, options.fileName || "book-page.jpg");
  if (options.bookId) formData.append("book_id", options.bookId);
  if (options.childId) formData.append("child_id", options.childId);
  if (options.idempotencyKey) {
    formData.append("idempotency_key", options.idempotencyKey);
  }
  return requestApi(
    "/reading/scan-page-ocr/jobs",
    localOcrPageScanJobSchema,
    options.signal,
    {
      method: "POST",
      body: formData,
    },
  );
}

export async function listScanPageOcrJobs(
  options: {
    readonly activeOnly?: boolean;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<LocalOcrPageScanJobListDTO> {
  const params = new URLSearchParams();
  params.set("active_only", options.activeOnly === false ? "false" : "true");
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    params.set(
      "limit",
      String(Math.max(1, Math.min(20, Math.floor(options.limit)))),
    );
  }
  return requestApi(
    `/reading/scan-page-ocr/jobs?${params.toString()}`,
    localOcrPageScanJobListSchema,
    options.signal,
    { method: "GET", bypassCache: true },
  );
}

export async function getScanPageOcrJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<LocalOcrPageScanJobDTO> {
  return requestApi(
    `/reading/scan-page-ocr/jobs/${encodeURIComponent(jobId)}`,
    localOcrPageScanJobSchema,
    signal,
    { method: "GET", bypassCache: true },
  );
}

export async function cancelScanPageOcrJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<LocalOcrPageScanJobDTO> {
  return requestApi(
    `/reading/scan-page-ocr/jobs/${encodeURIComponent(jobId)}`,
    localOcrPageScanJobSchema,
    signal,
    { method: "DELETE" },
  );
}

export async function scanPageImageWithLocalOcr(
  file: Blob,
  options: {
    readonly fileName?: string;
    readonly bookId?: string;
    readonly childId?: string;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<LocalOcrPageScanDTO> {
  const formData = new FormData();
  formData.append("file", file, options.fileName || "book-page.jpg");
  if (options.bookId) formData.append("book_id", options.bookId);
  if (options.childId) formData.append("child_id", options.childId);
  if (options.idempotencyKey) {
    formData.append("idempotency_key", options.idempotencyKey);
  }
  return requestApi(
    "/reading/scan-page-ocr",
    localOcrPageScanSchema,
    options.signal,
    {
      method: "POST",
      body: formData,
    },
  );
}

/**
 * Gửi frame ảnh chụp từ camera lên ViRead Vision Backend để kiểm tra khung
 * và nhận diện trang sách thuộc cuốn `bookId`.
 */
export async function scanCameraFrameForBook(
  bookId: string,
  imageBlob: Blob,
  signal?: AbortSignal,
): Promise<CameraPageMatchDTO> {
  const formData = new FormData();
  formData.append("file", imageBlob, "camera-frame.jpg");

  return requestApi(
    `/reading/books/${encodeURIComponent(bookId)}/match-page`,
    cameraPageMatchSchema,
    signal,
    {
      method: "POST",
      body: formData,
    },
  );
}

export async function scanCameraFrameGlobal(
  imageBlob: Blob,
  signal?: AbortSignal,
): Promise<CameraPageMatchDTO> {
  const formData = new FormData();
  formData.append("file", imageBlob, "camera-frame.jpg");

  return requestApi("/reading/match-page", cameraPageMatchSchema, signal, {
    method: "POST",
    body: formData,
  });
}

export function createPageMatchService(): PageMatchService {
  return {
    async retryCurrentPage(sessionId: string): Promise<ReadingPageDTO> {
      return requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/page`,
        readingPageDtoSchema,
      );
    },

    async selectPage(
      sessionId: string,
      selectedPageId: string,
    ): Promise<ReadingPageDTO> {
      await requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/navigate`,
        sessionPageProgressSchema,
        undefined,
        {
          method: "POST",
          body: { target_page_id: selectedPageId },
        },
      );
      return requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/page`,
        readingPageDtoSchema,
      );
    },
  };
}
