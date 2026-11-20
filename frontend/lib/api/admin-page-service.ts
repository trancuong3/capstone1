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
import { isServiceError } from "@/lib/api/service-error";
import { adminRevisionDetailSchema } from "@/lib/api/ocr-review-service";

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

export function createAdminPageService(): AdminPageService {
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
      return requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}/reupload-ocr`,
        adminRevisionDetailSchema.refine((item) => item.page_id === pageId),
        undefined,
        { method: "POST", body: form },
      );
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
          } else {
            await requestApi(
              `/books/admin/catalog/${encodeURIComponent(bookId)}/pages`,
              adminRevisionDetailSchema,
              undefined,
              { method: "POST", body: form },
            );
            // The endpoint returns only after OCR and database persistence complete.
            onProgress?.({
              client_id: page.client_id,
              file_name: page.file_name,
              progress_percent: 100,
              status: "PROCESSING",
            });
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
