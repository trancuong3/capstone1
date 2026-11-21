import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import {
  adminUserBookDecisionResponseSchema,
  adminUserBookQueuePageSchema,
  adminUserBookSubmissionDetailSchema,
  parentAddPageResponseSchema,
  parentPageSubmissionSchema,
  parentPrivateBookDetailSchema,
  parentPrivateBookSummarySchema,
  parentSubmitPagesResponseSchema,
  type AdminUserBookDecisionResponseDTO,
  type AdminUserBookDecisionType,
  type AdminUserBookQueueFilter,
  type AdminUserBookQueuePageDTO,
  type AdminUserBookSubmissionDetailDTO,
  type ParentAddPageResponseDTO,
  type ParentPageSubmissionDTO,
  type ParentPrivateBookDetailDTO,
  type ParentPrivateBookSummaryDTO,
  type ParentSubmitPagesResponseDTO,
  type SourceUsageType,
} from "@/types/parent-private-book";

export interface CreateParentPrivateBookInput {
  readonly title: string;
  readonly author?: string | null;
  readonly min_grade: number;
  readonly max_grade: number;
  readonly source_type: SourceUsageType;
  readonly source_note?: string | null;
}

export interface SubmitPrivateBookPageInput {
  readonly file: File;
  readonly idempotency_key: string;
  readonly source_type: SourceUsageType;
  readonly source_note?: string | null;
  readonly target_page_number?: number | null;
}

export interface EditPrivateSubmissionInput {
  readonly candidate_text?: string;
  readonly source_type?: SourceUsageType;
  readonly source_note?: string | null;
  readonly expected_lock_version?: number;
  readonly auto_recheck?: boolean;
}

export interface RequestAdminReviewInput {
  readonly expected_submission_version: number;
  readonly expected_candidate_hash: string;
  readonly source_type?: SourceUsageType;
  readonly source_note?: string | null;
  readonly request_note?: string | null;
}

export interface AddPrivatePageInput {
  readonly expected_submission_version: number;
  readonly expected_candidate_hash: string;
  readonly target_page_number?: number | null;
  readonly accept_spelling?: boolean;
}

export interface ParentPrivateBookService {
  list(readyOnly?: boolean): Promise<ParentPrivateBookSummaryDTO[]>;
  get(bookId: string): Promise<ParentPrivateBookDetailDTO>;
  create(
    input: CreateParentPrivateBookInput,
  ): Promise<ParentPrivateBookSummaryDTO>;
  submitPages(
    bookId: string,
    input: SubmitPrivateBookPageInput,
  ): Promise<ParentSubmitPagesResponseDTO>;
  getSubmission(
    bookId: string,
    submissionId: string,
  ): Promise<ParentPageSubmissionDTO>;
  acceptSpelling(
    bookId: string,
    submissionId: string,
    expectedSubmissionVersion: number,
    expectedCandidateHash: string,
  ): Promise<ParentPageSubmissionDTO>;
  editSubmission(
    bookId: string,
    submissionId: string,
    input: EditPrivateSubmissionInput,
  ): Promise<ParentPageSubmissionDTO>;
  replaceSubmissionFile(
    bookId: string,
    submissionId: string,
    file: File,
    sourceType?: SourceUsageType,
    sourceNote?: string | null,
  ): Promise<ParentPageSubmissionDTO>;
  retrySubmission(
    bookId: string,
    submissionId: string,
    stage?: "AUTO" | "OCR" | "PROOFREADING" | "TOOL_CHECK",
  ): Promise<ParentPageSubmissionDTO>;
  cancelSubmission(bookId: string, submissionId: string): Promise<void>;
  requestAdminReview(
    bookId: string,
    submissionId: string,
    input: RequestAdminReviewInput,
  ): Promise<ParentPageSubmissionDTO>;
  addPage(
    bookId: string,
    submissionId: string,
    input: AddPrivatePageInput,
  ): Promise<ParentAddPageResponseDTO>;
}

const cancelResponseSchema = z.object({
  status: z.string(),
  submission_id: z.string(),
});

const suspendResponseSchema = z.object({
  book_id: z.string(),
  moderation_status: z.literal("SUSPENDED"),
  suspended_at: z.string(),
  reason: z.string(),
  audit_log_id: z.string(),
});

export function createParentPrivateBookService(): ParentPrivateBookService {
  return {
    list: (readyOnly = false) =>
      requestApi(
        `/books/my-books${apiQuery({ ready_only: readyOnly ? "true" : undefined })}`,
        z.array(parentPrivateBookSummarySchema),
      ),
    get: (bookId) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}`,
        parentPrivateBookDetailSchema,
      ),
    create: (input) =>
      requestApi("/books/my-books", parentPrivateBookSummarySchema, undefined, {
        method: "POST",
        body: {
          title: input.title,
          author: input.author?.trim() || null,
          min_grade: input.min_grade,
          max_grade: input.max_grade,
          source_type: input.source_type,
          source_note: input.source_note?.trim() || null,
        },
      }),
    submitPages: (bookId, input) => {
      const form = new FormData();
      form.append("file", input.file);
      form.append("idempotency_key", input.idempotency_key);
      form.append("source_type", input.source_type);
      if (input.source_note?.trim()) {
        form.append("source_note", input.source_note.trim());
      }
      if (input.target_page_number != null) {
        form.append("target_page_number", String(input.target_page_number));
      }
      return requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/submissions`,
        parentSubmitPagesResponseSchema,
        undefined,
        { method: "POST", body: form },
      );
    },
    getSubmission: (bookId, submissionId) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/submissions/${encodeURIComponent(submissionId)}`,
        parentPageSubmissionSchema,
      ),
    acceptSpelling: (
      bookId,
      submissionId,
      expectedSubmissionVersion,
      expectedCandidateHash,
    ) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/submissions/${encodeURIComponent(submissionId)}/accept-spelling`,
        parentPageSubmissionSchema,
        undefined,
        {
          method: "POST",
          body: {
            expected_submission_version: expectedSubmissionVersion,
            expected_candidate_hash: expectedCandidateHash,
          },
        },
      ),
    editSubmission: (bookId, submissionId, input) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/submissions/${encodeURIComponent(submissionId)}`,
        parentPageSubmissionSchema,
        undefined,
        { method: "PATCH", body: input },
      ),
    replaceSubmissionFile: (bookId, submissionId, file, sourceType, sourceNote) => {
      const form = new FormData();
      form.append("file", file);
      if (sourceType) form.append("source_type", sourceType);
      if (sourceNote?.trim()) form.append("source_note", sourceNote.trim());
      return requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/submissions/${encodeURIComponent(submissionId)}/file`,
        parentPageSubmissionSchema,
        undefined,
        { method: "PUT", body: form },
      );
    },
    retrySubmission: (bookId, submissionId, stage = "AUTO") =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/submissions/${encodeURIComponent(submissionId)}/retry`,
        parentPageSubmissionSchema,
        undefined,
        { method: "POST", body: { stage } },
      ),
    cancelSubmission: async (bookId, submissionId) => {
      await requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/submissions/${encodeURIComponent(submissionId)}`,
        cancelResponseSchema,
        undefined,
        { method: "DELETE" },
      );
    },
    requestAdminReview: (bookId, submissionId, input) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/submissions/${encodeURIComponent(submissionId)}/request-admin-review`,
        parentPageSubmissionSchema,
        undefined,
        { method: "POST", body: input },
      ),
    addPage: (bookId, submissionId, input) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/submissions/${encodeURIComponent(submissionId)}/add-page`,
        parentAddPageResponseSchema,
        undefined,
        { method: "POST", body: input },
      ),
  };
}

export interface AdminUserBooksQualityApi {
  listUserBooks(query?: {
    status?: AdminUserBookQueueFilter;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<AdminUserBookQueuePageDTO>;
  getUserBookSubmission(
    submissionId: string,
  ): Promise<AdminUserBookSubmissionDetailDTO>;
  decideUserBookSubmission(
    submissionId: string,
    payload: {
      decision: AdminUserBookDecisionType;
      reason: string;
      expected_submission_version: number;
      expected_snapshot_hash: string;
      expected_lock_version: number;
    },
  ): Promise<AdminUserBookDecisionResponseDTO>;
  suspendUserBook(bookId: string, reason: string): Promise<void>;
}

export function createAdminUserBooksQualityApi(): AdminUserBooksQualityApi {
  return {
    listUserBooks: (query) =>
      requestApi(
        `/books/admin/quality/user-books${apiQuery({
          status: query?.status,
          search: query?.search,
          limit: query?.limit,
          offset: query?.offset,
        })}`,
        adminUserBookQueuePageSchema,
      ),
    getUserBookSubmission: (submissionId) =>
      requestApi(
        `/books/admin/quality/user-books/submissions/${encodeURIComponent(submissionId)}`,
        adminUserBookSubmissionDetailSchema,
      ),
    decideUserBookSubmission: (submissionId, payload) =>
      requestApi(
        `/books/admin/quality/user-books/submissions/${encodeURIComponent(submissionId)}/decision`,
        adminUserBookDecisionResponseSchema,
        undefined,
        { method: "POST", body: payload },
      ),
    suspendUserBook: async (bookId, reason) => {
      await requestApi(
        `/books/admin/quality/user-books/${encodeURIComponent(bookId)}/suspend`,
        suspendResponseSchema,
        undefined,
        { method: "POST", body: { reason } },
      );
    },
  };
}
