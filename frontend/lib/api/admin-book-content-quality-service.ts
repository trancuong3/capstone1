import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import {
  bookContentReportDetailSchema,
  bookQualityBookDetailSchema,
  bookQualityBookDecisionReadSchema,
  bookQualityBookPageSchema,
  bookQualityFindingSchema,
  bookQualityReportAdminPageSchema,
  bookQualityScanDetailSchema,
  bookQualityScanSchema,
  bookRightsEvidenceSchema,
  type BookContentReportDetailDTO,
  type BookContentReportStatus,
  type BookQualityBookDetailDTO,
  type BookQualityBookDecisionReadDTO,
  type BookQualityBookDecisionRequest,
  type BookApprovalStatus,
  type BookQualityBookPageDTO,
  type BookQualityFindingDTO,
  type BookQualityFindingStatus,
  type BookQualityReportAdminPageDTO,
  type BookQualityScanDTO,
  type BookQualityScanDetailDTO,
  type BookRightsEvidenceDTO,
  type BookRightsEvidenceUpsertRequest,
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
  listBooks(query?: {
    search?: string;
    approval_status?: BookApprovalStatus;
    alert_filter?: "CHILD_SAFETY" | "COPYRIGHT" | "BOTH";
    limit?: number;
    offset?: number;
  }): Promise<BookQualityBookPageDTO>;
  getBook(bookId: string): Promise<BookQualityBookDetailDTO>;
  getBookRights?(
    bookId: string,
    pageId?: string,
  ): Promise<BookRightsEvidenceDTO>;
  upsertBookRights?(
    bookId: string,
    payload: BookRightsEvidenceUpsertRequest,
  ): Promise<BookRightsEvidenceDTO>;
  decideBook(
    bookId: string,
    decision: BookQualityBookDecisionRequest,
  ): Promise<BookQualityBookDecisionReadDTO>;
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
          body: {
            status,
            resolution_note: resolutionNote?.trim() || undefined,
          },
        },
      ),
    listBooks: (query) =>
      requestApi(
        `/books/admin/quality/books${apiQuery({
          search: query?.search,
          approval_status: query?.approval_status,
          alert_filter: query?.alert_filter,
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
    getBookRights: (bookId, pageId) =>
      requestApi(
        `/books/admin/quality/books/${encodeURIComponent(bookId)}/rights${apiQuery({ page_id: pageId })}`,
        bookRightsEvidenceSchema,
      ),
    upsertBookRights: (bookId, payload) =>
      requestApi(
        `/books/admin/quality/books/${encodeURIComponent(bookId)}/rights`,
        bookRightsEvidenceSchema,
        undefined,
        { method: "PUT", body: payload },
      ),
    decideBook: (bookId, decision) =>
      requestApi(
        `/books/admin/quality/books/${encodeURIComponent(bookId)}/decision`,
        bookQualityBookDecisionReadSchema,
        undefined,
        { method: "POST", body: decision },
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
        {
          method: "PATCH",
          body: { status, review_note: reviewNote?.trim() || undefined },
        },
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
