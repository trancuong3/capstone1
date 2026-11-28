import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import {
  adminFlow2CandidateDecisionResponseSchema,
  adminFlow2CandidatePageSchema,
  adminUserBookDecisionResponseSchema,
  adminUserBookQueuePageSchema,
  adminUserBookSubmissionDetailSchema,
  parentAddPageResponseSchema,
  parentDeletePrivateBookResponseSchema,
  parentDeletePrivatePageResponseSchema,
  parentOcrContributionStateSchema,
  parentPageSubmissionSchema,
  parentPrivateBookDetailSchema,
  parentPrivateBookPageSchema,
  parentPrivateBookSummarySchema,
  parentStoryweaverResponseSchema,
  parentSubmitPagesResponseSchema,
  type AdminFlow2CandidateDecisionResponseDTO,
  type AdminFlow2CandidatePageDTO,
  type AdminUserBookDecisionResponseDTO,
  type AdminUserBookDecisionType,
  type AdminUserBookQueueFilter,
  type AdminUserBookQueuePageDTO,
  type AdminUserBookSubmissionDetailDTO,
  type Flow2CandidateStatus,
  type Flow2RejectionCode,
  type ParentAddPageResponseDTO,
  type ParentDeletePrivateBookResponseDTO,
  type ParentDeletePrivatePageResponseDTO,
  type ParentOcrContributionStateDTO,
  type ParentPageSubmissionDTO,
  type ParentPrivateBookDetailDTO,
  type ParentPrivateBookPageDTO,
  type ParentPrivateBookSummaryDTO,
  type ParentStoryweaverInput,
  type ParentStoryweaverResponseDTO,
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

export interface UpdateParentPrivateBookInput {
  readonly title?: string;
  readonly author?: string | null;
  readonly min_grade?: number;
  readonly max_grade?: number;
  readonly source_type?: SourceUsageType;
  readonly source_note?: string | null;
}

export interface EditPrivatePageInput {
  readonly candidate_text?: string;
  readonly page_number?: number;
  readonly source_type?: SourceUsageType;
  readonly source_note?: string | null;
  readonly auto_recheck?: boolean;
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

export interface ParentPrivateBookListPageQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly readyOnly?: boolean;
  readonly search?: string;
}

export interface ParentPrivateBookService {
  list(
    readyOnly?: boolean,
    signal?: AbortSignal,
  ): Promise<ParentPrivateBookSummaryDTO[]>;
  listPage(
    query?: ParentPrivateBookListPageQuery,
    signal?: AbortSignal,
  ): Promise<ParentPrivateBookPageDTO>;
  get(
    bookId: string,
    signal?: AbortSignal,
  ): Promise<ParentPrivateBookDetailDTO>;
  create(
    input: CreateParentPrivateBookInput,
  ): Promise<ParentPrivateBookSummaryDTO>;
  update(
    bookId: string,
    input: UpdateParentPrivateBookInput,
  ): Promise<ParentPrivateBookSummaryDTO>;
  delete(bookId: string): Promise<ParentDeletePrivateBookResponseDTO>;
  editCommittedPage(
    bookId: string,
    pageId: string,
    input: EditPrivatePageInput,
  ): Promise<ParentPageSubmissionDTO>;
  replaceCommittedPageFile(
    bookId: string,
    pageId: string,
    file: File,
    sourceType?: SourceUsageType,
    sourceNote?: string | null,
  ): Promise<ParentPageSubmissionDTO>;
  deleteCommittedPage(
    bookId: string,
    pageId: string,
  ): Promise<ParentDeletePrivatePageResponseDTO>;
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
  createStoryweaverBook?(
    input: ParentStoryweaverInput,
    signal?: AbortSignal,
  ): Promise<ParentStoryweaverResponseDTO>;
  getOcrContribution?(bookId: string): Promise<ParentOcrContributionStateDTO>;
  updateOcrContribution?(
    bookId: string,
    input: {
      enabled: boolean;
      rights_confirmed?: boolean;
      notice_version?: string;
      revoke_reason?: string | null;
    },
  ): Promise<ParentOcrContributionStateDTO>;
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
    list: (readyOnly = false, signal) =>
      requestApi(
        `/books/my-books${apiQuery({ ready_only: readyOnly ? "true" : undefined })}`,
        z.array(parentPrivateBookSummarySchema),
        signal,
      ),
    listPage: (query, signal) =>
      requestApi(
        `/books/my-books/paged${apiQuery({
          limit: query?.limit,
          offset: query?.offset,
          ready_only: query?.readyOnly ? "true" : undefined,
          search: query?.search?.trim() || undefined,
        })}`,
        parentPrivateBookPageSchema,
        signal,
      ),
    get: (bookId, signal) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}`,
        parentPrivateBookDetailSchema,
        signal,
        { method: "GET", bypassCache: true },
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
    createStoryweaverBook: (input, signal) =>
      requestApi(
        "/books/my-books/storyweaver",
        parentStoryweaverResponseSchema,
        signal,
        {
          method: "POST",
          timeoutMs: 60_000,
          body: {
            child_id: input.child_id ?? null,
            title: input.title?.trim() || null,
            theme: input.theme.trim(),
            page_count: input.page_count,
            target_grade: input.target_grade ?? null,
            style_mode: input.style_mode,
            custom_words: input.custom_words ? [...input.custom_words] : [],
          },
        },
      ),
    update: (bookId, input) => {
      const body: Record<string, unknown> = {};
      if (input.title !== undefined) body.title = input.title.trim();
      if (input.author !== undefined)
        body.author = input.author?.trim() || null;
      if (input.min_grade !== undefined) body.min_grade = input.min_grade;
      if (input.max_grade !== undefined) body.max_grade = input.max_grade;
      if (input.source_type !== undefined) body.source_type = input.source_type;
      if (input.source_note !== undefined)
        body.source_note = input.source_note?.trim() || null;
      return requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}`,
        parentPrivateBookSummarySchema,
        undefined,
        { method: "PATCH", body },
      );
    },
    delete: (bookId) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}`,
        parentDeletePrivateBookResponseSchema,
        undefined,
        { method: "DELETE" },
      ),
    editCommittedPage: (bookId, pageId, input) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}`,
        parentPageSubmissionSchema,
        undefined,
        { method: "PATCH", body: input },
      ),
    replaceCommittedPageFile: (
      bookId,
      pageId,
      file,
      sourceType,
      sourceNote,
    ) => {
      const form = new FormData();
      form.append("file", file);
      if (sourceType) form.append("source_type", sourceType);
      if (sourceNote?.trim()) form.append("source_note", sourceNote.trim());
      return requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}/file`,
        parentPageSubmissionSchema,
        undefined,
        { method: "PUT", body: form },
      );
    },
    deleteCommittedPage: (bookId, pageId) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}`,
        parentDeletePrivatePageResponseSchema,
        undefined,
        { method: "DELETE" },
      ),
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
        undefined,
        { method: "GET", bypassCache: true },
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
    replaceSubmissionFile: (
      bookId,
      submissionId,
      file,
      sourceType,
      sourceNote,
    ) => {
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
    getOcrContribution: (bookId) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/ocr-contribution`,
        parentOcrContributionStateSchema,
      ),
    updateOcrContribution: (bookId, input) =>
      requestApi(
        `/books/my-books/${encodeURIComponent(bookId)}/ocr-contribution`,
        parentOcrContributionStateSchema,
        undefined,
        { method: "PUT", body: input },
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
  listFlow2Candidates?(query?: {
    status?: Flow2CandidateStatus | "";
    book_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<AdminFlow2CandidatePageDTO>;
  decideFlow2Candidate?(
    candidateId: string,
    payload: {
      decision: "APPROVE" | "REJECT";
      verified_label?: string | null;
      rejection_code?: Flow2RejectionCode | null;
      reason?: string | null;
    },
  ): Promise<AdminFlow2CandidateDecisionResponseDTO>;
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
    listFlow2Candidates: (query) =>
      requestApi(
        `/books/admin/quality/user-books/flow2-candidates${apiQuery({
          status: query?.status || undefined,
          book_id: query?.book_id,
          limit: query?.limit,
          offset: query?.offset,
        })}`,
        adminFlow2CandidatePageSchema,
      ),
    decideFlow2Candidate: (candidateId, payload) =>
      requestApi(
        `/books/admin/quality/user-books/flow2-candidates/${encodeURIComponent(candidateId)}/decision`,
        adminFlow2CandidateDecisionResponseSchema,
        undefined,
        { method: "POST", body: payload },
      ),
  };
}
