import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import {
  bookContentReportDetailSchema,
  bookQualityBookDetailSchema,
  bookQualityBookPageSchema,
  bookQualityFindingSchema,
  bookQualityReportAdminPageSchema,
  bookQualityScanDetailSchema,
  bookQualityScanSchema,
  type BookContentReportDetailDTO,
  type BookContentReportStatus,
  type BookQualityBookDetailDTO,
  type BookQualityBookPageDTO,
  type BookQualityFindingDTO,
  type BookQualityFindingStatus,
  type BookQualityReportAdminPageDTO,
  type BookQualityScanDTO,
  type BookQualityScanDetailDTO,
} from "@/types/book-content-quality";

export interface AdminBookContentQualityService {
  listReports(query?: {
    status?: BookContentReportStatus;
    issue_type?: string;
    book_id?: string;
    search?: string;
    created_after?: string;
    created_before?: string;
    limit?: number;
    offset?: number;
  }): Promise<BookQualityReportAdminPageDTO>;
  getReport(reportId: string): Promise<BookContentReportDetailDTO>;
  updateReportStatus(
    reportId: string,
    status: BookContentReportStatus,
    resolutionNote?: string,
  ): Promise<BookContentReportDetailDTO>;
  listBooks(query?: { search?: string; limit?: number; offset?: number }): Promise<BookQualityBookPageDTO>;
  getBook(bookId: string): Promise<BookQualityBookDetailDTO>;
  enqueueScan(bookId: string): Promise<BookQualityScanDTO>;
  listScans(bookId: string): Promise<BookQualityScanDTO[]>;
  getScan(scanId: string): Promise<BookQualityScanDetailDTO>;
  updateFinding(
    findingId: string,
    status: Exclude<BookQualityFindingStatus, "STALE">,
    reviewNote?: string,
  ): Promise<BookQualityFindingDTO>;
  retryPage(scanId: string, pageScanId: string): Promise<BookQualityScanDTO>;
}

export function createAdminBookContentQualityService(): AdminBookContentQualityService {
  return {
    listReports: (query) =>
      requestApi(
        `/books/admin/quality/reports${apiQuery({
          status: query?.status,
          issue_type: query?.issue_type,
          book_id: query?.book_id,
          search: query?.search,
          created_after: query?.created_after,
          created_before: query?.created_before,
          limit: query?.limit,
          offset: query?.offset,
        })}`,
        bookQualityReportAdminPageSchema,
      ),
    getReport: (reportId) =>
      requestApi(
        `/books/admin/quality/reports/${encodeURIComponent(reportId)}`,
        bookContentReportDetailSchema,
      ),
    updateReportStatus: (reportId, status, resolutionNote) =>
      requestApi(
        `/books/admin/quality/reports/${encodeURIComponent(reportId)}/status`,
        bookContentReportDetailSchema,
        undefined,
        {
          method: "PATCH",
          body: { status, resolution_note: resolutionNote?.trim() || undefined },
        },
      ),
    listBooks: (query) =>
      requestApi(
        `/books/admin/quality/books${apiQuery({
          search: query?.search,
          limit: query?.limit,
          offset: query?.offset,
        })}`,
        bookQualityBookPageSchema,
      ),
    getBook: (bookId) =>
      requestApi(
        `/books/admin/quality/books/${encodeURIComponent(bookId)}`,
        bookQualityBookDetailSchema,
      ),
    enqueueScan: (bookId) =>
      requestApi(
        `/books/admin/quality/books/${encodeURIComponent(bookId)}/scan`,
        bookQualityScanSchema,
        undefined,
        { method: "POST" },
      ),
    listScans: (bookId) =>
      requestApi(
        `/books/admin/quality/books/${encodeURIComponent(bookId)}/scans`,
        z.array(bookQualityScanSchema),
      ),
    getScan: (scanId) =>
      requestApi(
        `/books/admin/quality/scans/${encodeURIComponent(scanId)}`,
        bookQualityScanDetailSchema,
      ),
    updateFinding: (findingId, status, reviewNote) =>
      requestApi(
        `/books/admin/quality/findings/${encodeURIComponent(findingId)}`,
        bookQualityFindingSchema,
        undefined,
        { method: "PATCH", body: { status, review_note: reviewNote?.trim() || undefined } },
      ),
    retryPage: (scanId, pageScanId) =>
      requestApi(
        `/books/admin/quality/scans/${encodeURIComponent(scanId)}/pages/${encodeURIComponent(pageScanId)}/retry`,
        bookQualityScanSchema,
        undefined,
        { method: "POST" },
      ),
  };
}
