import { createElement, type ReactNode } from "react";
import { vi } from "vitest";
import {
  AdminServicesContext,
  type AdminServices,
} from "@/components/providers/admin-services-provider";
import { ServiceError } from "@/lib/api/service-error";
import type {
  AdminBookDTO,
  AdminBookListItemUI,
  AdminPageListItemUI,
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
} from "@/types/admin";
import type {
  AdminAiWorkflowDTO,
  AdminPageVerificationReadinessDTO,
} from "@/lib/api/ocr-review-service";
import type { BookContentRightsProfileDTO } from "@/types/book-content-quality";

export const ADMIN_BOOK_ID = "81000000-0000-4000-8000-000000000001";
export const ADMIN_PAGE_ID = "83000000-0000-4000-8000-000000000001";
export const ADMIN_R1_ID = "84000000-0000-4000-8000-000000000001";
export const ADMIN_R2_ID = "84000000-0000-4000-8000-000000000002";
const createdAt = "2026-10-01T00:00:00Z";
const workflowFixture: AdminAiWorkflowDTO = {
  workflow_id: "85000000-0000-4000-8000-000000000001",
  page_id: ADMIN_PAGE_ID,
  book_id: ADMIN_BOOK_ID,
  page_revision_id: ADMIN_R2_ID,
  status: "READY_FOR_ADMIN_REVIEW",
  stage: "READY_FOR_ADMIN_REVIEW",
  progress: { completed_chunks: 1, total_chunks: 1 },
  attempts: 1,
  error_code: null,
  original_ocr_hash: "a".repeat(64),
  admin_input_hash: "b".repeat(64),
  image_hash: "e".repeat(64),
  proofread_text: "Nội dung đã sửa bằng AI",
  proofread_output_hash: "c".repeat(64),
  corrections: [],
  uncertain_word_indices: [],
  proofread_metadata: {},
  safety_metadata: {},
  candidate_history: [],
  safety_history: [],
  review_history: [],
  candidate_text: "Nội dung đã sửa bằng AI",
  candidate_hash: "c".repeat(64),
  candidate_version: 1,
  safety_input_hash: "c".repeat(64),
  hash_match: true,
  suitability: "SUITABLE",
  safety_status: "PROVISIONAL",
  image_safety_status: "NOT_REVIEWED",
  image_safety_reviewed_at: null,
  image_safety_review_note: null,
  rights_profile_id: null,
  rights_profile_version: null,
  rights_profile_hash: null,
  findings: [],
  provider_events: [],
  ocr_approved_at: null,
  final_approved_text_hash: null,
  created_at: createdAt,
  updated_at: createdAt,
};

export const adminBookFixture: AdminBookDTO = {
  id: ADMIN_BOOK_ID,
  name: "Tên sách kiểm thử",
  title: "Tiêu đề kiểm thử",
  author: "Tác giả kiểm thử",
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
};
export const adminBookListItemFixture: AdminBookListItemUI = {
  book: adminBookFixture,
  page_count: 3,
  processing_count: 1,
  needs_review_count: 1,
  verified_count: 1,
  parent_catalog_eligible: true,
};
export const adminR1Fixture: AdminPageRevisionDetailDTO = {
  page_id: ADMIN_PAGE_ID,
  page_revision_id: ADMIN_R1_ID,
  revision_no: 1,
  verification_status: "VERIFIED",
  lifecycle_status: "ACTIVE",
  original_ocr_text: "Nội dung OCR gốc",
  draft_text: "Nội dung revision đầu tiên",
  words: [
    {
      word_index: 0,
      line_index: 0,
      text: "Nội",
      normalized_text: "nội",
      bbox: [0.1, 0.1, 0.2, 0.05],
      ocr_confidence: 0.95,
      ocr_review_status: "verified",
      ocr_score_source: null,
    },
  ],
  ocr_metadata: {},
  created_at: createdAt,
  verified_at: createdAt,
  verified_by: "10000000-0000-4000-8000-000000000002",
};
export const adminR2Fixture: AdminPageRevisionDetailDTO = {
  ...adminR1Fixture,
  page_revision_id: ADMIN_R2_ID,
  revision_no: 2,
  draft_text: "Nội dung revision hiện hành",
  created_at: "2026-10-02T00:00:00Z",
  verified_at: "2026-10-02T00:00:00Z",
};
const adminPageFixture: AdminPageListItemUI = {
  book_id: ADMIN_BOOK_ID,
  page_number: 1,
  processing: {
    page_id: ADMIN_PAGE_ID,
    page_revision_id: ADMIN_R2_ID,
    revision_no: 2,
    verification_status: "VERIFIED",
    lifecycle_status: "ACTIVE",
    ocr_preview_metadata: {},
    verified_at: adminR2Fixture.verified_at,
    current_verified_revision_id: ADMIN_R2_ID,
  },
};
const revisionHistory: readonly AdminRevisionSummaryUI[] = [
  adminR2Fixture,
  adminR1Fixture,
].map((revision) => ({
  page_revision_id: revision.page_revision_id,
  revision_no: revision.revision_no,
  verification_status: revision.verification_status,
  created_at: revision.created_at,
  is_current_verified: revision.page_revision_id === ADMIN_R2_ID,
}));
function unavailable() {
  return new ServiceError({
    code: "NETWORK_ERROR",
    message: "Test operation unavailable",
    status: 501,
    request_id: "test-request",
    retryable: false,
  });
}

const defaultRightsProfileFixture: BookContentRightsProfileDTO = {
  id: "86000000-0000-4000-8000-000000000001",
  book_id: ADMIN_BOOK_ID,
  page_id: null,
  scope: "BOOK",
  status: "REVIEWED",
  source_name: "Nhà xuất bản kiểm thử",
  rights_holder: "Tác giả kiểm thử",
  usage_basis: "WRITTEN_LICENSE",
  evidence_url: "https://example.test/license",
  evidence_reference: "HD-2026-01",
  notes: "Đã xác minh giấy phép sử dụng.",
  source_fingerprint: "f".repeat(64),
  profile_version: 1,
  reference_check_status: "NO_MATCH_IN_ALLOWED_CORPUS",
  reference_check_evidence: [],
  reviewed_by: "10000000-0000-4000-8000-000000000002",
  reviewed_by_name: "Test Admin",
  reviewed_at: createdAt,
  history: [],
  updated_at: createdAt,
};

export function createReadyVerificationReadiness(
  overrides: Partial<AdminPageVerificationReadinessDTO> = {},
): AdminPageVerificationReadinessDTO {
  return {
    page_id: ADMIN_PAGE_ID,
    page_revision_id: ADMIN_R2_ID,
    workflow_id: workflowFixture.workflow_id,
    ready_to_verify: true,
    blockers: [],
    proofreading_status: "COMPLETED",
    uncertain_word_count: 0,
    uncertain_resolved: true,
    child_safety_status: "CONFIRMED",
    child_safety_scope: "TEXT",
    child_safety_coverage_complete: true,
    image_safety_status: "NOT_REVIEWED",
    image_safety_required: false,
    page_content_type: "CONTENT",
    rights_status: "REVIEWED",
    rights_scope: "BOOK",
    rights_profile_version: 1,
    ...overrides,
  };
}

function createBookContentQualityServiceFixture() {
  return {
    listReports: vi
      .fn<AdminServices["bookContentQuality"]["listReports"]>()
      .mockRejectedValue(unavailable()),
    getReport: vi
      .fn<AdminServices["bookContentQuality"]["getReport"]>()
      .mockRejectedValue(unavailable()),
    updateReportStatus: vi
      .fn<AdminServices["bookContentQuality"]["updateReportStatus"]>()
      .mockRejectedValue(unavailable()),
    listBooks: vi
      .fn<AdminServices["bookContentQuality"]["listBooks"]>()
      .mockRejectedValue(unavailable()),
    getBook: vi
      .fn<AdminServices["bookContentQuality"]["getBook"]>()
      .mockRejectedValue(unavailable()),
    getRightsProfile: vi
      .fn<AdminServices["bookContentQuality"]["getRightsProfile"]>()
      .mockResolvedValue(defaultRightsProfileFixture),
    upsertRightsProfile: vi
      .fn<AdminServices["bookContentQuality"]["upsertRightsProfile"]>()
      .mockImplementation(async (bookId, payload, pageId) => ({
        ...defaultRightsProfileFixture,
        book_id: bookId,
        page_id: pageId ?? null,
        scope: pageId ? "PAGE_OVERRIDE" : "BOOK",
        status: payload.status,
        source_name: payload.source_name ?? null,
        rights_holder: payload.rights_holder ?? null,
        usage_basis: payload.usage_basis ?? null,
        evidence_url: payload.evidence_url ?? null,
        evidence_reference: payload.evidence_reference ?? null,
        notes: payload.notes ?? null,
        profile_version: defaultRightsProfileFixture.profile_version + 1,
      })),
    runRightsOverlapCheck: vi
      .fn<AdminServices["bookContentQuality"]["runRightsOverlapCheck"]>()
      .mockResolvedValue(defaultRightsProfileFixture),
    updateExpectedPageCount: vi
      .fn<AdminServices["bookContentQuality"]["updateExpectedPageCount"]>()
      .mockImplementation(async (bookId, expectedPageCount) => ({
        book_id: bookId,
        expected_page_count: expectedPageCount,
      })),
    decideBook: vi
      .fn<AdminServices["bookContentQuality"]["decideBook"]>()
      .mockRejectedValue(unavailable()),
    enqueueScan: vi
      .fn<AdminServices["bookContentQuality"]["enqueueScan"]>()
      .mockRejectedValue(unavailable()),
    listScans: vi
      .fn<AdminServices["bookContentQuality"]["listScans"]>()
      .mockRejectedValue(unavailable()),
    getScan: vi
      .fn<AdminServices["bookContentQuality"]["getScan"]>()
      .mockRejectedValue(unavailable()),
    updateFinding: vi
      .fn<AdminServices["bookContentQuality"]["updateFinding"]>()
      .mockRejectedValue(unavailable()),
    retryPage: vi
      .fn<AdminServices["bookContentQuality"]["retryPage"]>()
      .mockRejectedValue(unavailable()),
    listUserBooks: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      summary: {},
      limit: 30,
      offset: 0,
    }),
    getUserBookSubmission: vi.fn().mockRejectedValue(unavailable()),
    decideUserBookSubmission: vi.fn().mockRejectedValue(unavailable()),
    suspendUserBook: vi.fn().mockRejectedValue(unavailable()),
  } satisfies AdminServices["bookContentQuality"];
}

function createMetadataQualityServiceFixture() {
  const get = vi
    .fn<AdminServices["metadataQuality"]["get"]>()
    .mockResolvedValue({
      summary: {
        total_books: 0,
        books_with_issues: 0,
        missing_title: 0,
        missing_author: 0,
        invalid_grade_range: 0,
        possible_duplicate_groups: 0,
        books_in_duplicate_groups: 0,
        checked_at: createdAt,
      },
      items: [],
      total: 0,
      limit: 10,
      offset: 0,
    });
  return { get } satisfies AdminServices["metadataQuality"];
}

export function createAdminServiceFixture() {
  return {
    auth: {
      signIn: vi.fn<AdminServices["auth"]["signIn"]>().mockResolvedValue({
        actor_id: "10000000-0000-4000-8000-000000000002",
        role: "admin",
        display_name: "Test Admin",
      }),
      signOut: vi
        .fn<AdminServices["auth"]["signOut"]>()
        .mockResolvedValue(undefined),
    },
    bookContentQuality: createBookContentQualityServiceFixture(),
    metadataQuality: createMetadataQualityServiceFixture(),
    books: {
      list: vi
        .fn<AdminServices["books"]["list"]>()
        .mockResolvedValue([adminBookListItemFixture]),
      get: vi
        .fn<AdminServices["books"]["get"]>()
        .mockResolvedValue(adminBookFixture),
      create: vi
        .fn<AdminServices["books"]["create"]>()
        .mockRejectedValue(unavailable()),
      update: vi
        .fn<AdminServices["books"]["update"]>()
        .mockRejectedValue(unavailable()),
      updateStatus: vi
        .fn<AdminServices["books"]["updateStatus"]>()
        .mockRejectedValue(unavailable()),
    },
    pages: {
      list: vi
        .fn<AdminServices["pages"]["list"]>()
        .mockResolvedValue([adminPageFixture]),
      getImage: vi.fn<AdminServices["pages"]["getImage"]>().mockResolvedValue({
        page_id: ADMIN_PAGE_ID,
        page_number: 1,
        preview_url: "https://example.com/test-page.png",
        width: 600,
        height: 800,
      }),
      replaceImageAndReprocess: vi
        .fn<AdminServices["pages"]["replaceImageAndReprocess"]>()
        .mockRejectedValue(unavailable()),
      upload: vi
        .fn<AdminServices["pages"]["upload"]>()
        .mockRejectedValue(unavailable()),
      reload: vi
        .fn<AdminServices["pages"]["reload"]>()
        .mockResolvedValue(adminPageFixture.processing),
      updateStatus: vi
        .fn<AdminServices["pages"]["updateStatus"]>()
        .mockRejectedValue(unavailable()),
      retire: vi
        .fn<AdminServices["pages"]["retire"]>()
        .mockRejectedValue(unavailable()),
    },
    parents: {
      list: vi
        .fn<AdminServices["parents"]["list"]>()
        .mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 }),
      getById: vi
        .fn<AdminServices["parents"]["getById"]>()
        .mockRejectedValue(unavailable()),
      create: vi
        .fn<AdminServices["parents"]["create"]>()
        .mockRejectedValue(unavailable()),
      update: vi
        .fn<AdminServices["parents"]["update"]>()
        .mockRejectedValue(unavailable()),
      deactivate: vi
        .fn<AdminServices["parents"]["deactivate"]>()
        .mockRejectedValue(unavailable()),
    },
    ocr: {
      getRevision: vi
        .fn<AdminServices["ocr"]["getRevision"]>()
        .mockImplementation(async (_pageId, revisionId) => {
          if (revisionId === ADMIN_R1_ID) return adminR1Fixture;
          if (revisionId === ADMIN_R2_ID) return adminR2Fixture;
          throw new ServiceError({
            code: "RESOURCE_NOT_FOUND",
            message: "Test revision not found",
            status: 404,
            request_id: "test-request",
            retryable: false,
          });
        }),
      saveDraft: vi
        .fn<AdminServices["ocr"]["saveDraft"]>()
        .mockRejectedValue(unavailable()),
      aiCorrectText: vi
        .fn<AdminServices["ocr"]["aiCorrectText"]>()
        .mockResolvedValue("Nội dung đã sửa bằng AI"),
      runCombinedWorkflow: vi
        .fn<AdminServices["ocr"]["runCombinedWorkflow"]>()
        .mockResolvedValue(workflowFixture),
      getLatestWorkflow: vi
        .fn<AdminServices["ocr"]["getLatestWorkflow"]>()
        .mockResolvedValue(null),
      updateWorkflowCandidate: vi
        .fn<AdminServices["ocr"]["updateWorkflowCandidate"]>()
        .mockImplementation(
          async (_pageId, _workflowId, version, candidateText) => ({
            ...workflowFixture,
            candidate_text: candidateText,
            candidate_hash: "d".repeat(64),
            candidate_version: version + 1,
            safety_input_hash: null,
            hash_match: false,
            suitability: null,
            safety_status: "STALE",
            findings: [],
            status: "CHILD_SAFETY_SCANNING",
            stage: "CHILD_SAFETY_SCANNING",
          }),
        ),
      decideWorkflowSafety: vi
        .fn<AdminServices["ocr"]["decideWorkflowSafety"]>()
        .mockImplementation(async (_pageId, _workflowId, _hash, confirmed) => ({
          ...workflowFixture,
          safety_status: confirmed ? "CONFIRMED" : "PROVISIONAL",
        })),
      retryWorkflow: vi
        .fn<AdminServices["ocr"]["retryWorkflow"]>()
        .mockResolvedValue({
          ...workflowFixture,
          status: "QUEUED",
          stage: "CHILD_SAFETY_SCANNING",
        }),
      getVerificationReadiness: vi
        .fn<AdminServices["ocr"]["getVerificationReadiness"]>()
        .mockImplementation(async (pageId, revisionId, workflowId) =>
          createReadyVerificationReadiness({
            page_id: pageId,
            page_revision_id: revisionId,
            workflow_id: workflowId ?? null,
            ready_to_verify: Boolean(workflowId),
            blockers: workflowId
              ? []
              : [
                  {
                    code: "PROOFREADING_REQUIRED",
                    stage: "PROOFREADING",
                    message:
                      "Cần chạy AI chỉnh sửa và rà chính tả cho revision này trước khi xác minh.",
                  },
                ],
            proofreading_status: workflowId ? "COMPLETED" : "NOT_STARTED",
            child_safety_status: workflowId ? "CONFIRMED" : "NOT_STARTED",
          }),
        ),
      resolveUncertainWords: vi
        .fn<AdminServices["ocr"]["resolveUncertainWords"]>()
        .mockImplementation(async (_pageId, _workflowId, _hash, note) => ({
          ...workflowFixture,
          uncertain_word_indices: [],
          review_history: [
            {
              event: "UNCERTAIN_WORDS_RESOLVED",
              note,
              created_at: createdAt,
            },
          ],
        })),
      reviewImageSafety: vi
        .fn<AdminServices["ocr"]["reviewImageSafety"]>()
        .mockImplementation(async (_pageId, _workflowId, status, note) => ({
          ...workflowFixture,
          image_safety_status: status,
          image_safety_reviewed_at: createdAt,
          image_safety_review_note: note,
        })),
      updatePageContentType: vi
        .fn<AdminServices["ocr"]["updatePageContentType"]>()
        .mockImplementation(async (pageId, contentType) => ({
          page_id: pageId,
          content_type: contentType,
        })),
    },
    revisions: {
      list: vi
        .fn<AdminServices["revisions"]["list"]>()
        .mockResolvedValue(revisionHistory),
      createDraft: vi
        .fn<AdminServices["revisions"]["createDraft"]>()
        .mockRejectedValue(unavailable()),
      verify: vi
        .fn<AdminServices["revisions"]["verify"]>()
        .mockRejectedValue(unavailable()),
      reprocess: vi
        .fn<AdminServices["revisions"]["reprocess"]>()
        .mockRejectedValue(unavailable()),
    },
    audit: {
      list: vi
        .fn<AdminServices["audit"]["list"]>()
        .mockResolvedValue({ items: [], next_cursor: null }),
    },
    health: {
      get: vi.fn<AdminServices["health"]["get"]>().mockResolvedValue({
        overall_status: "HEALTHY",
        checked_at: createdAt,
        services: [],
      }),
    },
  } satisfies AdminServices;
}

export function withAdminFixture(children: ReactNode, services: AdminServices) {
  return createElement(
    AdminServicesContext.Provider,
    { value: services },
    children,
  );
}
