import type {
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
  getImage(pageId: string): Promise<AdminPageImageUI>;
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

export function createAdminPageService(): AdminPageService {
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
    getImage: (pageId) =>
      requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}/image`,
        z
          .object({
            page_id: z.uuid(),
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
          .refine((image) => image.page_id === pageId),
      ),
    reload: (pageId) =>
      requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}/processing`,
        adminProcessingSchema.refine((item) => item.page_id === pageId),
      ),
    replaceImageAndReprocess: async (pageId, file) => {
      const form = new FormData();
      form.append("image", file, file.name);
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
          progress_percent: 0,
          status: "UPLOADING",
        });
        const form = new FormData();
        form.append("image", page.file, page.file_name);
        try {
          await requestApi(
            `/books/admin/catalog/${encodeURIComponent(bookId)}/pages`,
            adminRevisionDetailSchema,
            undefined,
            { method: "POST", body: form },
          );
          // The endpoint returns only after OCR and database persistence complete.
          onProgress?.({
            client_id: page.client_id,
            progress_percent: 100,
            status: "PROCESSING",
          });
        } catch (cause) {
          onProgress?.({
            client_id: page.client_id,
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
