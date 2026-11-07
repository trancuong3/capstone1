import { apiQuery, requestApi } from "@/lib/api/api-client";
import {
  bookContentReportDetailSchema,
  bookContentReportPageSchema,
  type BookContentIssueType,
  type BookContentReportDetailDTO,
  type BookContentReportPageDTO,
} from "@/types/book-content-quality";

export interface CreateBookContentReportRequest {
  readonly idempotency_key: string;
  readonly issue_type: BookContentIssueType;
  readonly description: string;
  readonly page_id?: string;
  readonly reported_text?: string;
  readonly suggested_correction?: string;
}

export interface BookContentReportService {
  create(
    bookId: string,
    request: CreateBookContentReportRequest,
  ): Promise<BookContentReportDetailDTO>;
  listMine(query?: {
    limit?: number;
    offset?: number;
  }): Promise<BookContentReportPageDTO>;
  getMine(reportId: string): Promise<BookContentReportDetailDTO>;
}

export function createBookContentReportService(): BookContentReportService {
  return {
    create: (bookId, request) =>
      requestApi(
        `/books/catalog/${encodeURIComponent(bookId)}/reports`,
        bookContentReportDetailSchema,
        undefined,
        {
          method: "POST",
          body: {
            idempotency_key: request.idempotency_key,
            issue_type: request.issue_type,
            description: request.description.trim(),
            page_id: request.page_id,
            reported_text: request.reported_text?.trim() || undefined,
            suggested_correction:
              request.suggested_correction?.trim() || undefined,
          },
        },
      ),
    listMine: (query) =>
      requestApi(
        `/books/reports/mine${apiQuery({
          limit: query?.limit,
          offset: query?.offset,
        })}`,
        bookContentReportPageSchema,
      ),
    getMine: (reportId) =>
      requestApi(
        `/books/reports/mine/${encodeURIComponent(reportId)}`,
        bookContentReportDetailSchema,
      ),
  };
}
