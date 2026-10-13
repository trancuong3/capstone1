import type {
  AdminPageImageUI,
  AdminPageListItemUI,
  AdminPageProcessingDTO,
  AdminPageUploadInputUI,
  AdminPageUploadProgressUI,
  StatusPatchDTO,
} from "@/types/admin";
import { z } from "zod";
import { requestApi, unavailableOperation } from "@/lib/api/api-client";
import { adminRevisionDetailSchema } from "@/lib/api/ocr-review-service";

export interface AdminPageService {
  list(bookId: string): Promise<readonly AdminPageListItemUI[]>;
  getImage(pageId: string): Promise<AdminPageImageUI>;
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
    upload: async (bookId, pages, onProgress) => {
      for (const page of pages) {
        onProgress?.({
          client_id: page.client_id,
          progress_percent: 0,
          status: "UPLOADING",
        });
        const form = new FormData();
        form.append("image", page.file, page.file_name);
        form.append("page_number", String(page.page_number));
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
        } catch {
          onProgress?.({
            client_id: page.client_id,
            progress_percent: 0,
            status: "FAILED",
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
  };
}
