import type {
  BookCatalogQuery,
  BookDetailDTO,
  BookListItemDTO,
  BookPagePreviewDTO,
} from "@/types/book";
import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";

export interface BookService {
  list(query?: BookCatalogQuery): Promise<BookListItemDTO[]>;
  get(bookId: string): Promise<BookDetailDTO>;
  listPages(bookId: string): Promise<BookPagePreviewDTO[]>;
}

export const bookDtoSchema = z.object({
  // PostgreSQL/Pydantic UUIDs do not require RFC version/variant bits.
  // Keep the canonical hex format and the stored ID without rewriting it.
  id: z.guid(),
  title: z.string(),
  author: z.string().nullable(),
  min_grade: z.number().int().min(1).max(5),
  max_grade: z.number().int().min(1).max(5),
  lifecycle_status: z.enum(["ACTIVE", "RETIRED"]),
});

const parentBookSchema = bookDtoSchema.refine(
  (book) =>
    book.lifecycle_status === "ACTIVE" && book.min_grade <= book.max_grade,
);
const previewSchema = z.object({
  page_id: z.uuid(),
  page_number: z.number().int().positive(),
  lifecycle_status: z.literal("ACTIVE"),
  current_verified_revision_id: z.uuid(),
  preview_url: z.url().refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }),
});

export function createBookService(): BookService {
  return {
    list: (query) =>
      requestApi(
        `/books/catalog${apiQuery({ search: query?.search, author: query?.author, grade: query?.grade })}`,
        z.array(parentBookSchema),
      ),
    get: (bookId) =>
      requestApi(
        `/books/catalog/${encodeURIComponent(bookId)}`,
        parentBookSchema,
      ),
    listPages: (bookId) =>
      requestApi(
        `/books/catalog/${encodeURIComponent(bookId)}/preview`,
        z.array(previewSchema),
      ),
  };
}
