import type {
  AdminBookCreateDTO,
  AdminBookDTO,
  AdminBookListItemUI,
  AdminBookQueryUI,
  AdminBookUpdateDTO,
  StatusPatchDTO,
} from "@/types/admin";
import { z } from "zod";
import {
  apiQuery,
  requestApi,
  unavailableOperation,
} from "@/lib/api/api-client";
import { bookDtoSchema } from "@/lib/api/book-service";

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
            book: bookDtoSchema,
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
        bookDtoSchema
          .extend({ next_page_number: z.number().int().positive().optional() })
          .refine((book) => book.id === bookId),
      ),
    create: (request) =>
      requestApi("/books/admin/catalog", bookDtoSchema, undefined, {
        method: "POST",
        body: {
          title: request.title.trim(),
          author: request.author?.trim() || null,
          min_grade: request.min_grade,
          max_grade: request.max_grade,
        },
      }),
    update: unavailableOperation,
    updateStatus: unavailableOperation,
  };
}
