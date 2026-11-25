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
  worker_id: z.string().nullable().optional(),
  attempt_count: z.number().optional(),
  max_attempts: z.number().optional(),
  error_code: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  cancelled_reason: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});

export type AdminOcrJobDTO = z.infer<typeof adminOcrJobSchema>;

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
    { method: "GET" },
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
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const maxAttempts = options.maxAttempts ?? 60;
  let current = initialJob;
  options.onTick?.(current);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (
      current.status === "SUCCEEDED" ||
      current.status === "DEAD_LETTER" ||
      current.status === "CANCELLED"
    ) {
      return current;
    }
    if (options.signal?.aborted) {
      throw new DOMException("OCR job polling cancelled", "AbortError");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("OCR job polling cancelled", "AbortError"));
      };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, pollIntervalMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    current = await getAdminOcrJob(current.id, options.signal);
    options.onTick?.(current);
  }
  return current;
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
        "Tác vụ OCR chưa hoàn tất. Hãy kiểm tra máy chủ OCR Windows rồi thử lại.",
    });
  }
  if (job.status !== "SUCCEEDED") {
    throw new ServiceError({
      code: "NETWORK_ERROR",
      status: 503,
      request_id: job.id,
      retryable: true,
      message:
        "Ảnh trang đã được xếp hàng chờ máy chủ OCR Windows xử lý. Bạn có thể làm mới lại sau khi máy chủ OCR hoàn tất.",
    });
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
    notes.push(`bỏ qua ${response.skipped_empty_count} trang trắng`);
  }
  if (response.failed_pages_count > 0) {
    notes.push(`lỗi ${response.failed_pages_count} trang`);
  }
  const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  return `Đã tạo ${response.created_pages_count} trang · Cần duyệt${suffix}`;
}

export function createAdminPageService(options?: {
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
}): AdminPageService {
  const pollIntervalMs = options?.pollIntervalMs ?? 1_500;
  const maxPollAttempts = options?.maxPollAttempts ?? 60;
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
        const finalJob = await pollAdminOcrJob(job, {
          pollIntervalMs,
          maxAttempts: maxPollAttempts,
        });
        return fetchRevisionForCompletedJob(pageId, finalJob);
      } catch (error) {
        if (!isAsyncRouteUnsupported(error)) throw error;
        return requestApi(
          `/books/admin/pages/${encodeURIComponent(pageId)}/reupload-ocr`,
          adminRevisionDetailSchema.refine((item) => item.page_id === pageId),
          undefined,
          { method: "POST", body: form },
        );
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
              if (!enqueued.worker_online) {
                onProgress?.({
                  client_id: page.client_id,
                  file_name: page.file_name,
                  progress_percent: 100,
                  status: "PROCESSING",
                  created_pages_count: enqueued.queued_count,
                  skipped_empty_count: 0,
                  failed_pages_count: 0,
                  summary_message: `Đã xếp hàng ${enqueued.queued_count} trang chờ máy chủ OCR Windows bật`,
                });
              } else {
                let completedCount = 0;
                let failedCount = 0;
                const jobsToPoll =
                  enqueued.jobs && enqueued.jobs.length > 0
                    ? enqueued.jobs
                    : enqueued.job_ids.map(
                        (id): AdminOcrJobDTO => ({
                          id,
                          job_kind: "ADMIN_PAGE_UPLOAD",
                          status: "QUEUED",
                        }),
                      );
                for (const jobItem of jobsToPoll) {
                  const settled = await pollAdminOcrJob(jobItem, {
                    pollIntervalMs,
                    maxAttempts: maxPollAttempts,
                  });
                  if (settled.status === "SUCCEEDED") {
                    completedCount += 1;
                  } else if (
                    settled.status === "DEAD_LETTER" ||
                    settled.status === "CANCELLED"
                  ) {
                    failedCount += 1;
                  }
                  const doneSoFar = completedCount + failedCount;
                  const pct =
                    jobsToPoll.length > 0
                      ? Math.min(
                          99,
                          Math.round((doneSoFar / jobsToPoll.length) * 100),
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
                }
                const pendingCount = Math.max(
                  0,
                  enqueued.queued_count - completedCount - failedCount,
                );
                onProgress?.({
                  client_id: page.client_id,
                  file_name: page.file_name,
                  progress_percent: 100,
                  status: "PROCESSING",
                  created_pages_count: completedCount,
                  skipped_empty_count: 0,
                  failed_pages_count: failedCount,
                  summary_message:
                    pendingCount > 0
                      ? `Hoàn tất ${completedCount}/${enqueued.queued_count} trang (${pendingCount} trang đang tiếp tục xếp hàng OCR)`
                      : `Đã hoàn tất OCR ${completedCount}/${enqueued.queued_count} trang · Cần duyệt`,
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
              onProgress?.({
                client_id: page.client_id,
                file_name: page.file_name,
                progress_percent: 35,
                status: "PROCESSING",
                summary_message:
                  job.status === "QUEUED"
                    ? "Đã xếp hàng chờ máy chủ OCR Windows xử lý"
                    : "Đang nhận diện OCR trang sách…",
              });
              const finalJob = await pollAdminOcrJob(job, {
                pollIntervalMs,
                maxAttempts: Math.min(maxPollAttempts, 20),
              });
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
                    "Tác vụ OCR trang sách chưa hoàn tất. Vui lòng thử lại.",
                });
              } else {
                onProgress?.({
                  client_id: page.client_id,
                  file_name: page.file_name,
                  progress_percent: 100,
                  status: "PROCESSING",
                  summary_message:
                    finalJob.status === "SUCCEEDED"
                      ? "Đã nhận diện OCR · Cần duyệt"
                      : "Đã xếp hàng an toàn chờ máy chủ OCR Windows hoàn tất",
                });
              }
            } catch (pageJobError) {
              if (!isAsyncRouteUnsupported(pageJobError)) throw pageJobError;
              await requestApi(
                `/books/admin/catalog/${encodeURIComponent(bookId)}/pages`,
                adminRevisionDetailSchema,
                undefined,
                { method: "POST", body: form },
              );
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
              : "Upload thất bại. Hãy kiểm tra Backend và thử lại.",
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
