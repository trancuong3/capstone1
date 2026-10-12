import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminBookService } from "@/lib/api/admin-book-service";
import { createAdminPageService } from "@/lib/api/admin-page-service";
import { createAuditService } from "@/lib/api/audit-service";
import { createOcrReviewService } from "@/lib/api/ocr-review-service";
import { createRevisionService } from "@/lib/api/revision-service";
import {
  apiFetchFixture,
  installApiFetchFixture,
  requestedApiUrl,
} from "@/test/fixtures/api-test-fixture";
import {
  ADMIN_BOOK_ID,
  ADMIN_PAGE_ID,
  ADMIN_R1_ID,
  ADMIN_R2_ID,
  adminBookListItemFixture,
  adminR1Fixture,
  adminR2Fixture,
} from "@/test/fixtures/admin-service-fixture";
import type { AdminPageProcessingDTO } from "@/types/admin";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));
beforeEach(() => installApiFetchFixture());
afterEach(() => vi.unstubAllGlobals());

const processing: AdminPageProcessingDTO = {
  page_id: ADMIN_PAGE_ID,
  page_revision_id: ADMIN_R2_ID,
  revision_no: 2,
  verification_status: "NEEDS_REVIEW",
  lifecycle_status: "ACTIVE",
  ocr_preview_metadata: {},
  verified_at: null,
  current_verified_revision_id: ADMIN_R1_ID,
};
describe("Admin real API boundaries (migrated from legacy mutable store tests)", () => {
  it("reads immutable historical revisions without synthesizing newer OCR or advancing pointers", async () => {
    apiFetchFixture
      .mockResolvedValueOnce(Response.json(adminR1Fixture))
      .mockResolvedValueOnce(Response.json(adminR2Fixture));
    const before = structuredClone(adminR1Fixture);
    const ocr = createOcrReviewService();
    expect(await ocr.getRevision(ADMIN_PAGE_ID, ADMIN_R1_ID)).toEqual(
      adminR1Fixture,
    );
    expect(await ocr.getRevision(ADMIN_PAGE_ID, ADMIN_R2_ID)).toEqual(
      adminR2Fixture,
    );
    expect(adminR1Fixture).toEqual(before);
    expect(
      apiFetchFixture.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });

  it("preserves backend catalog eligibility while a newer revision needs review", async () => {
    apiFetchFixture.mockResolvedValueOnce(
      Response.json([adminBookListItemFixture]),
    );
    const listed = await createAdminBookService().list();
    expect(listed[0].parent_catalog_eligible).toBe(true);
    expect(listed[0].needs_review_count).toBe(1);
  });

  it("reloads stored processing state without locally completing OCR", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json(processing));
    expect(await createAdminPageService().reload(ADMIN_PAGE_ID)).toEqual(
      processing,
    );
    expect(requestedApiUrl().pathname).toBe(
      `/books/admin/pages/${ADMIN_PAGE_ID}/processing`,
    );
    expect(processing.current_verified_revision_id).toBe(ADMIN_R1_ID);
    expect(apiFetchFixture.mock.calls[0][1]?.method).toBe("GET");
  });

  it("preserves current-revision markers supplied by backend history", async () => {
    const history = [adminR2Fixture, adminR1Fixture].map((revision) => ({
      page_revision_id: revision.page_revision_id,
      revision_no: revision.revision_no,
      verification_status: revision.verification_status,
      created_at: revision.created_at,
      is_current_verified: revision.page_revision_id === ADMIN_R2_ID,
    }));
    apiFetchFixture.mockResolvedValueOnce(Response.json(history));
    expect(await createRevisionService().list(ADMIN_PAGE_ID)).toEqual(history);
  });

  it.each([
    {
      name: "reprocess",
      call: () => createRevisionService().reprocess(ADMIN_PAGE_ID),
    },
    {
      name: "verify",
      call: () =>
        createRevisionService().verify(ADMIN_PAGE_ID, {
          page_revision_id: ADMIN_R1_ID,
          corrected_text: "Test",
          words: adminR1Fixture.words,
        }),
    },
    {
      name: "edit draft",
      call: () =>
        createOcrReviewService().saveDraft(
          ADMIN_PAGE_ID,
          ADMIN_R1_ID,
          "Test",
          [],
        ),
    },
    {
      name: "upload",
      call: () => createAdminPageService().upload(ADMIN_BOOK_ID, []),
    },
    {
      name: "page lifecycle",
      call: () =>
        createAdminPageService().updateStatus(ADMIN_PAGE_ID, {
          status: "RETIRED",
        }),
    },
    {
      name: "book lifecycle",
      call: () =>
        createAdminBookService().updateStatus(ADMIN_BOOK_ID, {
          status: "RETIRED",
        }),
    },
    {
      name: "create book",
      call: () =>
        createAdminBookService().create({
          title: "Test",
          author: null,
          min_grade: 1,
          max_grade: 3,
        }),
    },
    {
      name: "update book",
      call: () =>
        createAdminBookService().update(ADMIN_BOOK_ID, {
          title: "Test",
          author: null,
          min_grade: 1,
          max_grade: 3,
        }),
    },
  ])(
    "returns 501 for unavailable $name without writes or fake success",
    async ({ call }) => {
      await expect(call()).rejects.toMatchObject({
        code: "NETWORK_ERROR",
        status: 501,
        retryable: false,
      });
      expect(apiFetchFixture).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...adminR1Fixture, page_id: ADMIN_BOOK_ID },
    { ...adminR1Fixture, page_revision_id: ADMIN_R2_ID },
    {
      ...adminR1Fixture,
      words: [{ ...adminR1Fixture.words[0], bbox: [120, 50, 30, 20] }],
    },
  ])(
    "rejects mismatched revision identities and malformed normalized boxes",
    async (payload) => {
      apiFetchFixture.mockResolvedValueOnce(Response.json(payload));
      await expect(
        createOcrReviewService().getRevision(ADMIN_PAGE_ID, ADMIN_R1_ID),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    },
  );

  it("reads the current page lifecycle from backend without mutating older revisions", async () => {
    const original = structuredClone(adminR1Fixture);
    const retired = { ...adminR1Fixture, lifecycle_status: "RETIRED" as const };
    apiFetchFixture.mockResolvedValueOnce(Response.json(retired));
    expect(
      await createOcrReviewService().getRevision(ADMIN_PAGE_ID, ADMIN_R1_ID),
    ).toEqual(retired);
    expect(adminR1Fixture).toEqual(original);
  });

  it("forwards exact lifecycle filters and retains retired catalog entries", async () => {
    const retired = {
      ...adminBookListItemFixture,
      book: {
        ...adminBookListItemFixture.book,
        lifecycle_status: "RETIRED" as const,
      },
      parent_catalog_eligible: false,
    };
    apiFetchFixture.mockResolvedValueOnce(Response.json([retired]));
    expect(
      await createAdminBookService().list({ lifecycle_status: "RETIRED" }),
    ).toEqual([retired]);
    expect(requestedApiUrl().searchParams.get("lifecycle_status")).toBe(
      "RETIRED",
    );
  });

  it("reads backend-sanitized audit data and forwards the cursor and bound", async () => {
    const page = {
      items: [
        {
          id: ADMIN_R1_ID,
          actor_id: null,
          resource_id: ADMIN_BOOK_ID,
          action: "book.read",
          resource_type: "book",
          request_id: null,
          created_at: "2026-10-01T00:00:00Z",
          metadata: {},
        },
      ],
      next_cursor: "opaque-next",
    };
    apiFetchFixture.mockResolvedValueOnce(Response.json(page));
    expect(
      await createAuditService().list({ limit: 2, cursor: "opaque-current" }),
    ).toEqual(page);
    expect(requestedApiUrl().searchParams.get("limit")).toBe("2");
    expect(requestedApiUrl().searchParams.get("cursor")).toBe("opaque-current");
  });
});
