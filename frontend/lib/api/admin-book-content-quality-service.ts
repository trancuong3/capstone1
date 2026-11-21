import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import {
  createAdminUserBooksQualityApi,
  type AdminUserBooksQualityApi,
} from "@/lib/api/parent-private-book-service";
import {
  bookContentReportDetailSchema,
  bookContentRightsProfileSchema,
  bookQualityBookDetailSchema,
  bookQualityBookDecisionReadSchema,
  bookQualityBookPageSchema,
  bookQualityFindingSchema,
  bookQualityReportAdminPageSchema,
  bookQualityScanDetailSchema,
  bookQualityScanSchema,
  type BookContentReportDetailDTO,
  type BookContentReportStatus,
  type BookContentRightsProfileDTO,
  type BookContentRightsProfileUpsert,
  type BookQualityBookDetailDTO,
  type BookQualityBookDecisionReadDTO,
  type BookQualityBookDecisionRequest,
  type BookApprovalStatus,
  type BookQualityBookPageDTO,
  type BookQualityFindingDTO,
  type BookQualityFindingStatus,
  type BookQualityIssueFilter,
  type BookQualityReportAdminPageDTO,
  type BookQualityScanDTO,
  type BookQualityScanDetailDTO,
} from "@/types/book-content-quality";

export interface AdminBookContentQualityService {
  listReports(query?: {
    status?: BookContentReportStatus;
    issue_type?: string;
    scope?: "BOOK" | "PAGE";
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
    issue_filter?: BookQualityIssueFilter;
    limit?: number;
    offset?: number;
  }): Promise<BookQualityBookPageDTO>;
  getBook(bookId: string): Promise<BookQualityBookDetailDTO>;
  getRightsProfile(
    bookId: string,
    pageId?: string | null,
  ): Promise<BookContentRightsProfileDTO>;
  upsertRightsProfile(
    bookId: string,
    payload: BookContentRightsProfileUpsert,
    pageId?: string | null,
  ): Promise<BookContentRightsProfileDTO>;
  runRightsOverlapCheck(bookId: string): Promise<BookContentRightsProfileDTO>;
  updateExpectedPageCount(
    bookId: string,
    expectedPageCount: number | null,
  ): Promise<{ book_id: string; expected_page_count: number | null }>;
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
  listUserBooks?: AdminUserBooksQualityApi["listUserBooks"];
  getUserBookSubmission?: AdminUserBooksQualityApi["getUserBookSubmission"];
  decideUserBookSubmission?: AdminUserBooksQualityApi["decideUserBookSubmission"];
  suspendUserBook?: AdminUserBooksQualityApi["suspendUserBook"];
}

const expectedPageCountResponseSchema = z.object({
  book_id: z.guid(),
  expected_page_count: z.number().int().positive().nullable(),
});

export function createAdminBookContentQualityService(): AdminBookContentQualityService {
  const userBooks = createAdminUserBooksQualityApi();
  return {
    listReports: (query) =>
      requestApi(
        `/books/admin/quality/reports${apiQuery({
          status: query?.status,
          issue_type: query?.issue_type,
          scope: query?.scope,
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
          issue_filter: query?.issue_filter,
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
    getRightsProfile: (bookId, pageId) =>
      requestApi(
        `/books/admin/quality/books/${encodeURIComponent(bookId)}/rights-profile${apiQuery({
          page_id: pageId ?? undefined,
        })}`,
        bookContentRightsProfileSchema,
      ),
    upsertRightsProfile: (bookId, payload, pageId) =>
      requestApi(
        `/books/admin/quality/books/${encodeURIComponent(bookId)}/rights-profile${apiQuery({
          page_id: pageId ?? undefined,
        })}`,
        bookContentRightsProfileSchema,
        undefined,
        { method: "PUT", body: payload },
      ),
    runRightsOverlapCheck: (bookId) =>
      requestApi(
        `/books/admin/quality/books/${encodeURIComponent(bookId)}/rights-profile/overlap-check`,
        bookContentRightsProfileSchema,
        undefined,
        { method: "POST" },
      ),
    updateExpectedPageCount: (bookId, expectedPageCount) =>
      requestApi(
        `/books/admin/quality/books/${encodeURIComponent(bookId)}/expected-page-count`,
        expectedPageCountResponseSchema,
        undefined,
        {
          method: "PATCH",
          body: { expected_page_count: expectedPageCount },
        },
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
    ...userBooks,
  };
}
