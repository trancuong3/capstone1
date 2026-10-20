import type {
  AdminBookCreateDTO,
  AdminBookDTO,
  AdminBookListItemUI,
  AdminBookQueryUI,
  AdminBookUpdateDTO,
  StatusPatchDTO,
} from "@/types/admin";
import { z } from "zod";
import { apiQuery, requestApi } from "@/lib/api/api-client";
const adminBookDtoSchema = z.object({
  id: z.guid(),
  title: z.string(),
  author: z.string().nullable(),
  min_grade: z.number().int(),
  max_grade: z.number().int(),
  lifecycle_status: z.enum(["ACTIVE", "RETIRED"]),
});

export interface AdminBookService {
  list(query?: AdminBookQueryUI): Promise<readonly AdminBookListItemUI[]>;
  get(bookId: string): Promise<AdminBookDTO>;
  create(request: AdminBookCreateDTO): Promise<AdminBookDTO>;
  update(bookId: string, request: AdminBookUpdateDTO): Promise<AdminBookDTO>;
  updateStatus(bookId: string, request: StatusPatchDTO): Promise<AdminBookDTO>;
}

export function createAdminBookService(): AdminBookService {
  return {
    list: (query) =>
      requestApi(
        `/books/admin/catalog${apiQuery({ search: query?.search, lifecycle_status: query?.lifecycle_status, verification_status: query?.verification_status })}`,
        z.array(
          z.object({
            book: adminBookDtoSchema,
            page_count: z.number().int().nonnegative(),
            processing_count: z.number().int().nonnegative(),
            needs_review_count: z.number().int().nonnegative(),
            verified_count: z.number().int().nonnegative(),
            parent_catalog_eligible: z.boolean(),
          }),
        ),
      ),
    get: (bookId) =>
      requestApi(
        `/books/admin/catalog/${encodeURIComponent(bookId)}`,
        adminBookDtoSchema
          .extend({ next_page_number: z.number().int().positive().optional() })
          .refine((book) => book.id === bookId),
      ),
    create: (request) =>
      requestApi("/books/admin/catalog", adminBookDtoSchema, undefined, {
        method: "POST",
        body: {
          title: request.title.trim(),
          author: request.author?.trim() || null,
          min_grade: request.min_grade,
          max_grade: request.max_grade,
        },
      }),
    update: (bookId, request) =>
      requestApi(
        `/books/admin/catalog/${encodeURIComponent(bookId)}`,
        adminBookDtoSchema.refine((book) => book.id === bookId),
        undefined,
        {
          method: "PUT",
          body: {
            title: request.title.trim(),
            author: request.author?.trim() || null,
            min_grade: request.min_grade,
            max_grade: request.max_grade,
          },
        },
      ),
    updateStatus: (bookId, request) =>
      requestApi(
        `/books/admin/catalog/${encodeURIComponent(bookId)}/status`,
        adminBookDtoSchema.refine((book) => book.id === bookId),
        undefined,
        { method: "PATCH", body: { status: request.status } },
      ),
  };
}
