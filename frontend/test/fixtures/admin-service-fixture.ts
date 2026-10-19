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

export const ADMIN_BOOK_ID = "81000000-0000-4000-8000-000000000001";
export const ADMIN_PAGE_ID = "83000000-0000-4000-8000-000000000001";
export const ADMIN_R1_ID = "84000000-0000-4000-8000-000000000001";
export const ADMIN_R2_ID = "84000000-0000-4000-8000-000000000002";
const createdAt = "2026-10-01T00:00:00Z";

export const adminBookFixture: AdminBookDTO = {
  id: ADMIN_BOOK_ID,
  title: "Sách kiểm thử",
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
  draft_text: "Nội dung revision đầu tiên",
  words: [
    {
      word_index: 0,
      line_index: 0,
      text: "Nội",
      normalized_text: "nội",
      bbox: [0.1, 0.1, 0.2, 0.05],
      ocr_confidence: 0.95,
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

// Test-only responses/spies, not a mutable store or a runtime adapter.
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
    metadataQuality: {
      get: vi
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
        }),
    },
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
