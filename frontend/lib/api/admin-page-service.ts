import type {
  AdminDocumentUploadResponseDTO,
  AdminPageImageUI,
  AdminPageListItemUI,
  AdminPageLifecycleDTO,
  AdminPageProcessingDTO,
  AdminPageRevisionDetailDTO,
  AdminPageUploadInputUI,
  AdminPageUploadProgressUI,
  StatusPatchDTO,
} from "@/types/admin";
import { z } from "zod";
import { requestApi, unavailableOperation } from "@/lib/api/api-client";
import { isServiceError, ServiceError } from "@/lib/api/service-error";
import { adminRevisionDetailSchema } from "@/lib/api/ocr-review-service";
import { translateRuntime } from "@/lib/i18n/runtime";

export const adminOcrJobStatusSchema = z.enum([
  "QUEUED",
  "CLAIMED",
  "RUNNING",
  "FAILED_RETRYABLE",
  "SUCCEEDED",
  "DEAD_LETTER",
  "CANCELLED",
]);

export const adminOcrJobSchema = z.object({
  id: z.string(),
  job_kind: z.string(),
  status: adminOcrJobStatusSchema,
  priority: z.number().optional(),
  book_id: z.string().nullable().optional(),
  page_id: z.string().nullable().optional(),
  revision_id: z.string().nullable().optional(),
  submission_id: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  queue_position: z.number().int().nonnegative().nullable().optional(),
  worker_id: z.string().nullable().optional(),
  worker_online: z.boolean().optional(),
  attempt_count: z.number().optional(),
  max_attempts: z.number().optional(),
  error_code: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  cancelled_reason: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});

export function notifyTasksChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("viread:tasks-changed"));
  }
}

export type AdminOcrJobDTO = z.infer<typeof adminOcrJobSchema>;

export class AdminOcrJobQueuedSignal extends Error {
  readonly kind = "ADMIN_OCR_JOB_QUEUED" as const;
  readonly job: AdminOcrJobDTO;

  constructor(job: AdminOcrJobDTO, message: string) {
    super(message);
    this.name = "AdminOcrJobQueuedSignal";
    this.job = job;
  }
}

export function isAdminOcrJobQueuedSignal(
  error: unknown,
): error is AdminOcrJobQueuedSignal {
  return (
    error instanceof AdminOcrJobQueuedSignal ||
    (typeof error === "object" &&
      error !== null &&
      "kind" in error &&
      (error as { kind?: unknown }).kind === "ADMIN_OCR_JOB_QUEUED")
  );
}

export function isActiveAdminOcrJobStatus(
  status: AdminOcrJobDTO["status"],
): boolean {
  return (
    status === "QUEUED" ||
    status === "CLAIMED" ||
    status === "RUNNING" ||
    status === "FAILED_RETRYABLE"
  );
}

export const adminDocumentJobsResponseSchema = z.object({
  book_id: z.uuid(),
  source_format: z.string(),
  total_source_pages: z.number().int().min(1).max(30),
  job_ids: z.array(z.string()),
  queued_count: z.number().int().nonnegative(),
  worker_online: z.boolean(),
  jobs: z.array(adminOcrJobSchema).optional(),
});

export type AdminDocumentJobsResponseDTO = z.infer<
  typeof adminDocumentJobsResponseSchema
>;

export async function getAdminOcrJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<AdminOcrJobDTO> {
  return requestApi(
    `/books/admin/ocr-jobs/${encodeURIComponent(jobId)}`,
    adminOcrJobSchema,
    signal,
    { method: "GET", bypassCache: true },
  );
}

export async function listAdminBookOcrJobs(
  bookId: string,
  signal?: AbortSignal,
): Promise<readonly AdminOcrJobDTO[]> {
  return requestApi(
    `/books/admin/catalog/${encodeURIComponent(bookId)}/ocr-jobs`,
    z.array(adminOcrJobSchema),
    signal,
    { method: "GET", bypassCache: true },
  );
}

export async function cancelAdminOcrJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<AdminOcrJobDTO> {
  const job = await requestApi(
    `/books/admin/ocr-jobs/${encodeURIComponent(jobId)}`,
    adminOcrJobSchema,
    signal,
    { method: "DELETE" },
  );
  notifyTasksChanged();
  return job;
}

export async function retryAdminOcrJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<AdminOcrJobDTO> {
  const job = await requestApi(
    `/books/admin/ocr-jobs/${encodeURIComponent(jobId)}/retry`,
    adminOcrJobSchema,
    signal,
    { method: "POST" },
  );
  notifyTasksChanged();
  return job;
}

function isTransientAdminPollError(error: unknown): boolean {
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

function waitAdminPollDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("OCR job polling cancelled", "AbortError"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("OCR job polling cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForVisibleTab(signal?: AbortSignal): Promise<void> {
  if (
    typeof document === "undefined" ||
    document.visibilityState !== "hidden"
  ) {
    return Promise.resolve();
  }
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("OCR job polling cancelled", "AbortError"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      signal?.removeEventListener("abort", onAbort);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") {
        cleanup();
        resolve();
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("OCR job polling cancelled", "AbortError"));
    };
    document.addEventListener("visibilitychange", onVisibility);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTerminalOcrJobStatus(status: AdminOcrJobDTO["status"]): boolean {
  return (
    status === "SUCCEEDED" || status === "DEAD_LETTER" || status === "CANCELLED"
  );
}

export async function pollAdminOcrJob(
  initialJob: AdminOcrJobDTO,
  options: {
    readonly pollIntervalMs?: number;
    readonly maxAttempts?: number;
    readonly signal?: AbortSignal;
    readonly onTick?: (job: AdminOcrJobDTO) => void;
  } = {},
): Promise<AdminOcrJobDTO> {
  const baseIntervalMs = options.pollIntervalMs ?? 1_500;
  const maxIntervalMs = Math.max(
    baseIntervalMs,
    Math.min(8_000, baseIntervalMs * 5),
  );
  const maxAttempts = options.maxAttempts ?? 100;
  let current = initialJob;
  let consecutiveErrors = 0;
  options.onTick?.(current);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isTerminalOcrJobStatus(current.status)) {
      return current;
    }
    if (
      current.worker_online === false &&
      (current.status === "QUEUED" || current.status === "FAILED_RETRYABLE")
    ) {
      return current;
    }
    if (options.signal?.aborted) {
      throw new DOMException("OCR job polling cancelled", "AbortError");
    }
    const backoffStep = Math.min(4, Math.floor(attempt / 4));
    const delayMs = Math.min(
      maxIntervalMs,
      Math.round(baseIntervalMs * Math.pow(1.4, backoffStep)),
    );
    await waitAdminPollDelay(delayMs, options.signal);
    await waitForVisibleTab(options.signal);
    try {
      current = await getAdminOcrJob(current.id, options.signal);
      consecutiveErrors = 0;
      options.onTick?.(current);
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      consecutiveErrors += 1;
      if (!isTransientAdminPollError(error) || consecutiveErrors > 3) {
        throw error;
      }
    }
  }
  return current;
}

export async function pollAdminBookOcrJobsBatch(
  bookId: string,
  initialJobs: readonly AdminOcrJobDTO[],
  options: {
    readonly pollIntervalMs?: number;
    readonly maxAttempts?: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (summary: {
      readonly completedCount: number;
      readonly failedCount: number;
      readonly totalCount: number;
    }) => void;
  } = {},
): Promise<readonly AdminOcrJobDTO[]> {
  const baseIntervalMs = options.pollIntervalMs ?? 1_500;
  const maxIntervalMs = Math.max(
    baseIntervalMs,
    Math.min(8_000, baseIntervalMs * 5),
  );
  const maxAttempts = options.maxAttempts ?? 60;
  const jobMap = new Map<string, AdminOcrJobDTO>();
  for (const job of initialJobs) {
    jobMap.set(job.id, job);
  }
  const targetIds = new Set(jobMap.keys());
  let batchRouteSupported = true;
  let consecutiveErrors = 0;

  const report = () => {
    let completedCount = 0;
    let failedCount = 0;
    for (const job of jobMap.values()) {
      if (job.status === "SUCCEEDED") completedCount += 1;
      else if (job.status === "DEAD_LETTER" || job.status === "CANCELLED") {
        failedCount += 1;
      }
    }
    options.onProgress?.({
      completedCount,
      failedCount,
      totalCount: jobMap.size,
    });
    return completedCount + failedCount >= jobMap.size;
  };

  const allPendingOffline = () => {
    const pending = Array.from(jobMap.values()).filter(
      (job) => !isTerminalOcrJobStatus(job.status),
    );
    return (
      pending.length > 0 &&
      pending.every(
        (job) =>
          job.worker_online === false &&
          (job.status === "QUEUED" || job.status === "FAILED_RETRYABLE"),
      )
    );
  };

  if (report() || allPendingOffline()) return Array.from(jobMap.values());

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new DOMException("OCR job polling cancelled", "AbortError");
    }
    const backoffStep = Math.min(4, Math.floor(attempt / 4));
    const delayMs = Math.min(
      maxIntervalMs,
      Math.round(baseIntervalMs * Math.pow(1.4, backoffStep)),
    );
    await waitAdminPollDelay(delayMs, options.signal);
    await waitForVisibleTab(options.signal);

    try {
      if (batchRouteSupported) {
        try {
          const latestList = await listAdminBookOcrJobs(bookId, options.signal);
          for (const item of latestList) {
            if (targetIds.has(item.id)) {
              jobMap.set(item.id, item);
            }
          }
          consecutiveErrors = 0;
        } catch (batchErr) {
          if (isAsyncRouteUnsupported(batchErr)) {
            batchRouteSupported = false;
          } else {
            throw batchErr;
          }
        }
      }
      if (!batchRouteSupported) {
        const pending = Array.from(jobMap.values()).filter(
          (item) => !isTerminalOcrJobStatus(item.status),
        );
        const refreshed = await Promise.all(
          pending.map((item) => getAdminOcrJob(item.id, options.signal)),
        );
        for (const item of refreshed) {
          jobMap.set(item.id, item);
        }
        consecutiveErrors = 0;
      }
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      consecutiveErrors += 1;
      if (!isTransientAdminPollError(error) || consecutiveErrors > 3) {
        throw error;
      }
      continue;
    }

    if (report() || allPendingOffline()) {
      return Array.from(jobMap.values());
    }
  }
  return Array.from(jobMap.values());
}

function isAsyncRouteUnsupported(error: unknown): boolean {
  return (
    isServiceError(error) &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

async function fetchRevisionForCompletedJob(
  pageId: string,
  job: AdminOcrJobDTO,
): Promise<AdminPageRevisionDetailDTO> {
  if (job.status === "DEAD_LETTER" || job.status === "CANCELLED") {
    throw new ServiceError({
      code: "NETWORK_ERROR",
      status: 503,
      request_id: job.id,
      retryable: job.status !== "CANCELLED",
      message:
        job.error_message ||
        translateRuntime("admin.pageUploadRuntime.ocrTaskIncomplete"),
    });
  }
  if (job.status !== "SUCCEEDED") {
    throw new AdminOcrJobQueuedSignal(
      job,
      translateRuntime("admin.pageUploadRuntime.ocrTaskQueuedWindows"),
    );
  }
  const targetPageId = job.page_id ?? pageId;
  if (job.revision_id) {
    return requestApi(
      `/books/admin/pages/${encodeURIComponent(targetPageId)}/revisions/${encodeURIComponent(job.revision_id)}`,
      adminRevisionDetailSchema.refine((item) => item.page_id === targetPageId),
    );
  }
  const processing = await requestApi(
    `/books/admin/pages/${encodeURIComponent(targetPageId)}/processing`,
    adminProcessingSchema.refine((item) => item.page_id === targetPageId),
  );
  return requestApi(
    `/books/admin/pages/${encodeURIComponent(targetPageId)}/revisions/${encodeURIComponent(processing.page_revision_id)}`,
    adminRevisionDetailSchema.refine((item) => item.page_id === targetPageId),
  );
}

export interface AdminPageService {
  list(bookId: string): Promise<readonly AdminPageListItemUI[]>;
  listOcrJobs?(
    bookId: string,
    signal?: AbortSignal,
  ): Promise<readonly AdminOcrJobDTO[]>;
  cancelOcrJob?(jobId: string, signal?: AbortSignal): Promise<AdminOcrJobDTO>;
  retryOcrJob?(jobId: string, signal?: AbortSignal): Promise<AdminOcrJobDTO>;
  getImage(pageId: string, revisionId?: string): Promise<AdminPageImageUI>;
  replaceImageAndReprocess(
    pageId: string,
    file: File,
  ): Promise<AdminPageRevisionDetailDTO>;
  upload(
    bookId: string,
    pages: readonly AdminPageUploadInputUI[],
    onProgress?: (progress: AdminPageUploadProgressUI) => void,
  ): Promise<readonly AdminPageListItemUI[]>;
  reload(pageId: string): Promise<AdminPageProcessingDTO>;
  updateStatus(
    pageId: string,
    request: StatusPatchDTO,
  ): Promise<AdminPageProcessingDTO>;
  retire(pageId: string): Promise<AdminPageLifecycleDTO>;
}

export const adminProcessingSchema = z.object({
  page_id: z.uuid(),
  page_revision_id: z.uuid(),
  revision_no: z.number().int().positive(),
  verification_status: z.enum(["PROCESSING", "NEEDS_REVIEW", "VERIFIED"]),
  lifecycle_status: z.enum(["ACTIVE", "RETIRED"]),
  ocr_preview_metadata: z.record(z.string(), z.unknown()),
  verified_at: z.iso.datetime({ offset: true }).nullable(),
  current_verified_revision_id: z.uuid().nullable(),
});

export const adminDocumentPageResultSchema = z.object({
  source_page: z.number().int().min(1).max(30),
  status: z.enum(["SUCCEEDED", "SKIPPED_EMPTY", "FAILED"]),
  page_id: z.uuid().nullable(),
  page_number: z.number().int().positive().nullable(),
  revision: adminRevisionDetailSchema.nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
});

export function createAdminDocumentUploadResponseSchema(bookId: string) {
  return z
    .object({
      book_id: z.uuid(),
      file_name: z.string(),
      source_format: z.enum([
        "JPEG",
        "PNG",
        "WEBP",
        "BMP",
        "TIFF",
        "PDF",
        "DOCX",
      ]),
      total_source_pages: z.number().int().min(1).max(30),
      created_pages_count: z.number().int().nonnegative(),
      skipped_empty_count: z.number().int().nonnegative(),
      failed_pages_count: z.number().int().nonnegative(),
      pages: z.array(adminDocumentPageResultSchema),
    })
    .refine(
      (res) =>
        res.book_id === bookId &&
        res.pages.length === res.total_source_pages &&
        res.created_pages_count +
          res.skipped_empty_count +
          res.failed_pages_count ===
          res.total_source_pages,
    );
}

const standardImageTypes = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function isDocumentUpload(page: AdminPageUploadInputUI): boolean {
  return (
    page.upload_kind === "document" || !standardImageTypes.has(page.mime_type)
  );
}

function formatDocumentSummary(
  response: AdminDocumentUploadResponseDTO,
): string {
  const notes: string[] = [];
  if (response.skipped_empty_count > 0) {
    notes.push(
      translateRuntime("admin.pageUploadRuntime.skippedEmptyNote", {
        count: response.skipped_empty_count,
      }),
    );
  }
  if (response.failed_pages_count > 0) {
    notes.push(
      translateRuntime("admin.pageUploadRuntime.failedPagesNote", {
        count: response.failed_pages_count,
      }),
    );
  }
  const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  return translateRuntime("admin.pageUploadRuntime.createdPagesSummary", {
    count: response.created_pages_count,
    suffix,
  });
}

export function createAdminPageService(options?: {
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
}): AdminPageService {
  const pollIntervalMs = options?.pollIntervalMs ?? 1_500;
  const maxPollAttempts = options?.maxPollAttempts ?? 100;
  const uploadIds = new WeakMap<File, string>();
  function uploadIdFor(file: File): string {
    let id = uploadIds.get(file);
    if (!id) {
      id = crypto.randomUUID();
      uploadIds.set(file, id);
    }
    return id;
  }
  return {
    list: (bookId) =>
      requestApi(
        `/books/admin/catalog/${encodeURIComponent(bookId)}/pages`,
        z
          .array(
            z.object({
              book_id: z.uuid(),
              page_number: z.number().int().positive(),
              processing: adminProcessingSchema,
              text_preview: z.string().nullable().optional(),
            }),
          )
          .refine((items) => items.every((item) => item.book_id === bookId)),
      ),
    listOcrJobs: (bookId, signal) => listAdminBookOcrJobs(bookId, signal),
    cancelOcrJob: (jobId, signal) => cancelAdminOcrJob(jobId, signal),
    retryOcrJob: (jobId, signal) => retryAdminOcrJob(jobId, signal),
    getImage: (pageId, revisionId) =>
      requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}/image${revisionId ? `?revision_id=${encodeURIComponent(revisionId)}` : ""}`,
        z
          .object({
            page_id: z.uuid(),
            page_revision_id: z.uuid().nullable().optional(),
            page_number: z.number().int().positive(),
            preview_url: z.url().refine((value) => {
              try {
                const url = new URL(value);
                return (
                  ["http:", "https:"].includes(url.protocol) &&
                  !url.username &&
                  !url.password
                );
              } catch {
                return false;
              }
            }),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .refine(
            (image) =>
              image.page_id === pageId &&
              (!revisionId || image.page_revision_id === revisionId),
          ),
      ),
    reload: (pageId) =>
      requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}/processing`,
        adminProcessingSchema.refine((item) => item.page_id === pageId),
      ),
    replaceImageAndReprocess: async (pageId, file) => {
      const form = new FormData();
      form.append("image", file, file.name);
      form.append("upload_id", uploadIdFor(file));
      try {
        const job = await requestApi(
          `/books/admin/pages/${encodeURIComponent(pageId)}/reupload-ocr/jobs`,
          adminOcrJobSchema,
          undefined,
          { method: "POST", body: form },
        );
        notifyTasksChanged();
        const finalJob = await pollAdminOcrJob(job, {
          pollIntervalMs,
          maxAttempts: maxPollAttempts,
        });
        notifyTasksChanged();
        return fetchRevisionForCompletedJob(pageId, finalJob);
      } catch (error) {
        if (!isAsyncRouteUnsupported(error)) throw error;
        const detail = await requestApi(
          `/books/admin/pages/${encodeURIComponent(pageId)}/reupload-ocr`,
          adminRevisionDetailSchema.refine((item) => item.page_id === pageId),
          undefined,
          { method: "POST", body: form },
        );
        notifyTasksChanged();
        return detail;
      }
    },
    upload: async (bookId, pages, onProgress) => {
      for (const page of pages) {
        onProgress?.({
          client_id: page.client_id,
          file_name: page.file_name,
          progress_percent: 0,
          status: "UPLOADING",
        });
        const form = new FormData();
        const documentMode = isDocumentUpload(page);
        form.append(
          documentMode ? "document" : "image",
          page.file,
          page.file_name,
        );
        form.append("upload_id", uploadIdFor(page.file));
        try {
          if (documentMode) {
            try {
              const enqueued = await requestApi(
                `/books/admin/catalog/${encodeURIComponent(bookId)}/documents/jobs`,
                adminDocumentJobsResponseSchema.refine(
                  (res) => res.book_id === bookId,
                ),
                undefined,
                { method: "POST", body: form },
              );
              notifyTasksChanged();
              if (!enqueued.worker_online) {
                onProgress?.({
                  client_id: page.client_id,
                  file_name: page.file_name,
                  progress_percent: 0,
                  status: "QUEUED_OFFLINE",
                  queued_offline: true,
                  created_pages_count: enqueued.queued_count,
                  skipped_empty_count: 0,
                  failed_pages_count: 0,
                  summary_message: translateRuntime(
                    "admin.pageUploadRuntime.queuedDocPagesForWorker",
                    { count: enqueued.queued_count },
                  ),
                });
              } else {
                const jobsToPoll =
                  enqueued.jobs && enqueued.jobs.length > 0
                    ? enqueued.jobs
                    : enqueued.job_ids.map((id): AdminOcrJobDTO => ({
                        id,
                        job_kind: "ADMIN_PAGE_UPLOAD",
                        status: "QUEUED",
                      }));
                const settledJobs = await pollAdminBookOcrJobsBatch(
                  bookId,
                  jobsToPoll,
                  {
                    pollIntervalMs,
                    maxAttempts: maxPollAttempts,
                    onProgress: ({
                      completedCount,
                      failedCount,
                      totalCount,
                    }) => {
                      const doneSoFar = completedCount + failedCount;
                      const pct =
                        totalCount > 0
                          ? Math.min(
                              99,
                              Math.round((doneSoFar / totalCount) * 100),
                            )
                          : 100;
                      onProgress?.({
                        client_id: page.client_id,
                        file_name: page.file_name,
                        progress_percent: pct,
                        status: "PROCESSING",
                        created_pages_count: completedCount,
                        failed_pages_count: failedCount,
                      });
                    },
                  },
                );
                notifyTasksChanged();
                const completedCount = settledJobs.filter(
                  (j) => j.status === "SUCCEEDED",
                ).length;
                const failedCount = settledJobs.filter(
                  (j) => j.status === "DEAD_LETTER" || j.status === "CANCELLED",
                ).length;
                const pendingCount = Math.max(
                  0,
                  enqueued.queued_count - completedCount - failedCount,
                );
                const pendingOffline =
                  pendingCount > 0 &&
                  settledJobs.some(
                    (j) =>
                      j.worker_online === false &&
                      (j.status === "QUEUED" ||
                        j.status === "FAILED_RETRYABLE"),
                  );
                onProgress?.({
                  client_id: page.client_id,
                  file_name: page.file_name,
                  progress_percent: pendingOffline ? 0 : 100,
                  status: pendingOffline ? "QUEUED_OFFLINE" : "PROCESSING",
                  queued_offline: pendingOffline || undefined,
                  created_pages_count: completedCount,
                  skipped_empty_count: 0,
                  failed_pages_count: failedCount,
                  summary_message:
                    pendingCount > 0
                      ? translateRuntime(
                          "admin.pageUploadRuntime.docPagesPartialProgress",
                          {
                            completed: completedCount,
                            total: enqueued.queued_count,
                            pending: pendingCount,
                          },
                        )
                      : translateRuntime(
                          "admin.pageUploadRuntime.docPagesComplete",
                          {
                            completed: completedCount,
                            total: enqueued.queued_count,
                          },
                        ),
                });
              }
            } catch (docError) {
              if (!isAsyncRouteUnsupported(docError)) throw docError;
              const summary = await requestApi(
                `/books/admin/catalog/${encodeURIComponent(bookId)}/documents`,
                createAdminDocumentUploadResponseSchema(bookId),
                undefined,
                { method: "POST", body: form },
              );
              notifyTasksChanged();
              onProgress?.({
                client_id: page.client_id,
                file_name: page.file_name,
                progress_percent: 100,
                status: "PROCESSING",
                created_pages_count: summary.created_pages_count,
                skipped_empty_count: summary.skipped_empty_count,
                failed_pages_count: summary.failed_pages_count,
                summary_message: formatDocumentSummary(summary),
              });
            }
          } else {
            try {
              const job = await requestApi(
                `/books/admin/catalog/${encodeURIComponent(bookId)}/pages/jobs`,
                adminOcrJobSchema,
                undefined,
                { method: "POST", body: form },
              );
              notifyTasksChanged();
              if (
                job.worker_online === false &&
                (job.status === "QUEUED" || job.status === "FAILED_RETRYABLE")
              ) {
                onProgress?.({
                  client_id: page.client_id,
                  file_name: page.file_name,
                  progress_percent: 0,
                  status: "QUEUED_OFFLINE",
                  queued_offline: true,
                  summary_message: translateRuntime(
                    "admin.pageUploadRuntime.singlePageWaitingWorker",
                  ),
                });
              } else {
                onProgress?.({
                  client_id: page.client_id,
                  file_name: page.file_name,
                  progress_percent: 35,
                  status: "PROCESSING",
                  summary_message:
                    job.status === "QUEUED"
                      ? translateRuntime(
                          "admin.pageUploadRuntime.singlePageQueued",
                        )
                      : translateRuntime(
                          "admin.pageUploadRuntime.singlePageRecognizing",
                        ),
                });
                const finalJob = await pollAdminOcrJob(job, {
                  pollIntervalMs,
                  maxAttempts: maxPollAttempts,
                });
                notifyTasksChanged();
                if (
                  finalJob.status === "DEAD_LETTER" ||
                  finalJob.status === "CANCELLED"
                ) {
                  onProgress?.({
                    client_id: page.client_id,
                    file_name: page.file_name,
                    progress_percent: 0,
                    status: "FAILED",
                    error_message:
                      finalJob.error_message ||
                      translateRuntime(
                        "admin.pageUploadRuntime.singlePageFailed",
                      ),
                  });
                } else if (finalJob.status !== "SUCCEEDED") {
                  onProgress?.({
                    client_id: page.client_id,
                    file_name: page.file_name,
                    progress_percent: 0,
                    status: "QUEUED_OFFLINE",
                    queued_offline: true,
                    summary_message: translateRuntime(
                      "admin.pageUploadRuntime.singlePageWaitingWorker",
                    ),
                  });
                } else {
                  onProgress?.({
                    client_id: page.client_id,
                    file_name: page.file_name,
                    progress_percent: 100,
                    status: "PROCESSING",
                    summary_message: translateRuntime(
                      "admin.pageUploadRuntime.singlePageSucceeded",
                    ),
                  });
                }
              }
            } catch (pageJobError) {
              if (!isAsyncRouteUnsupported(pageJobError)) throw pageJobError;
              await requestApi(
                `/books/admin/catalog/${encodeURIComponent(bookId)}/pages`,
                adminRevisionDetailSchema,
                undefined,
                { method: "POST", body: form },
              );
              notifyTasksChanged();
              onProgress?.({
                client_id: page.client_id,
                file_name: page.file_name,
                progress_percent: 100,
                status: "PROCESSING",
              });
            }
          }
        } catch (cause) {
          onProgress?.({
            client_id: page.client_id,
            file_name: page.file_name,
            progress_percent: 0,
            status: "FAILED",
            error_message: isServiceError(cause)
              ? cause.message
              : translateRuntime(
                  "admin.pageUploadRuntime.uploadFailedCheckBackend",
                ),
          });
        }
      }
      return requestApi(
        `/books/admin/catalog/${encodeURIComponent(bookId)}/pages`,
        z
          .array(
            z.object({
              book_id: z.uuid(),
              page_number: z.number().int().positive(),
              processing: adminProcessingSchema,
            }),
          )
          .refine((items) => items.every((item) => item.book_id === bookId)),
      );
    },
    updateStatus: unavailableOperation,
    retire: (pageId) =>
      requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}`,
        z
          .object({
            page_id: z.uuid(),
            book_id: z.uuid(),
            page_number: z.number().int().positive(),
            lifecycle_status: z.literal("RETIRED"),
          })
          .refine((item) => item.page_id === pageId),
        undefined,
        { method: "DELETE" },
      ),
  };
}
