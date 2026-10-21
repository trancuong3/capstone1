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
  adminBookFixture,
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

  it("creates a book through the API and validates the returned book", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json(adminBookFixture));
    const created = await createAdminBookService().create({
      name: "  Tên sách kiểm thử  ",
      title: "  Sách kiểm thử  ",
      author: "  ",
      min_grade: 1,
      max_grade: 3,
    });
    expect(created).toEqual(adminBookFixture);
    expect(requestedApiUrl().pathname).toBe("/books/admin/catalog");
    expect(apiFetchFixture.mock.calls[0][1]?.method).toBe("POST");
    const body = JSON.parse(String(apiFetchFixture.mock.calls[0][1]?.body));
    expect(body).toEqual({
      name: "Tên sách kiểm thử",
      title: "Sách kiểm thử",
      author: null,
      min_grade: 1,
      max_grade: 3,
    });
  });

  it("uploads a file as multipart and then reloads pages from the API", async () => {
    const file = new File(["image bytes for transport test"], "page.png", {
      type: "image/png",
    });
    const pageList = [
      {
        book_id: ADMIN_BOOK_ID,
        page_number: 1,
        processing,
      },
    ];
    apiFetchFixture
      .mockResolvedValueOnce(
        Response.json({
          ...adminR2Fixture,
          verification_status: "NEEDS_REVIEW",
          verified_at: null,
          verified_by: null,
        }),
      )
      .mockResolvedValueOnce(Response.json(pageList));
    const result = await createAdminPageService().upload(ADMIN_BOOK_ID, [
      {
        client_id: "1-page.png",
        file_name: file.name,
        mime_type: "image/png",
        size_bytes: file.size,
        page_number: 1,
        file,
      },
    ]);
    expect(result).toEqual(pageList);
    expect(apiFetchFixture).toHaveBeenCalledTimes(2);
    expect(requestedApiUrl(0).pathname).toBe(
      `/books/admin/catalog/${ADMIN_BOOK_ID}/pages`,
    );
    const uploadInit = apiFetchFixture.mock.calls[0][1] as RequestInit;
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect((uploadInit.body as FormData).get("page_number")).toBe("1");
    expect((uploadInit.body as FormData).get("image")).toMatchObject({
      name: "page.png",
    });
    expect(
      (uploadInit.headers as Record<string, string>)["Content-Type"],
    ).toBeUndefined();
    expect(requestedApiUrl(1).pathname).toBe(
      `/books/admin/catalog/${ADMIN_BOOK_ID}/pages`,
    );
  });

  it("saves a validated draft without reporting it as verified", async () => {
    const draft = {
      ...adminR2Fixture,
      verification_status: "NEEDS_REVIEW" as const,
      draft_text: "Nội dung đã sửa",
      verified_at: null,
      verified_by: null,
    };
    apiFetchFixture.mockResolvedValueOnce(Response.json(draft));
    const saved = await createOcrReviewService().saveDraft(
      ADMIN_PAGE_ID,
      ADMIN_R2_ID,
      "Nội dung đã sửa",
      adminR2Fixture.words,
    );
    expect(saved).toEqual(draft);
    expect(requestedApiUrl().pathname).toBe(
      `/books/admin/pages/${ADMIN_PAGE_ID}/revisions/${ADMIN_R2_ID}/draft`,
    );
    const init = apiFetchFixture.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({
      draft_text: "Nội dung đã sửa",
      words: [{ word_index: 0, bbox: [0.1, 0.1, 0.2, 0.05] }],
    });
  });

  it("verifies and reprocesses through the backend rather than mutating local revision state", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json(adminR1Fixture));
    const verified = await createRevisionService().verify(ADMIN_PAGE_ID, {
      page_revision_id: ADMIN_R1_ID,
      corrected_text: adminR1Fixture.draft_text ?? "",
      words: adminR1Fixture.words,
    });
    expect(verified).toEqual(adminR1Fixture);
    expect(requestedApiUrl().pathname).toBe(
      `/books/admin/pages/${ADMIN_PAGE_ID}/verify`,
    );
    expect(apiFetchFixture.mock.calls[0][1]?.method).toBe("POST");

    apiFetchFixture.mockResolvedValueOnce(
      Response.json({
        ...adminR2Fixture,
        verification_status: "NEEDS_REVIEW",
        verified_at: null,
        verified_by: null,
        revision_no: 3,
      }),
    );
    const reprocessed = await createRevisionService().reprocess(ADMIN_PAGE_ID);
    expect(reprocessed.revision_no).toBe(3);
    expect(requestedApiUrl(1).pathname).toBe(
      `/books/admin/pages/${ADMIN_PAGE_ID}/reprocess`,
    );
    expect(apiFetchFixture.mock.calls[1][1]?.method).toBe("POST");
  });

  it("keeps unsupported page lifecycle updates unavailable", async () => {
    await expect(
      createAdminPageService().updateStatus(ADMIN_PAGE_ID, {
        status: "RETIRED",
      }),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      status: 501,
      retryable: false,
    });
    expect(apiFetchFixture).not.toHaveBeenCalled();
  });

  it("updates book metadata through the backend API", async () => {
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({ ...adminBookFixture, title: "Updated title" }),
    );
    const updated = await createAdminBookService().update(ADMIN_BOOK_ID, {
      name: "Tên sách kiểm thử",
      title: "  Updated title  ",
      author: "  Author  ",
      min_grade: 2,
      max_grade: 4,
    });

    expect(updated.name).toBe("Tên sách kiểm thử");
    expect(updated.title).toBe("Updated title");
    expect(requestedApiUrl().pathname).toBe(
      `/books/admin/catalog/${ADMIN_BOOK_ID}`,
    );
    expect(apiFetchFixture.mock.calls[0][1]?.method).toBe("PUT");
    expect(JSON.parse(String(apiFetchFixture.mock.calls[0][1]?.body))).toEqual({
      name: "Tên sách kiểm thử",
      title: "Updated title",
      author: "Author",
      min_grade: 2,
      max_grade: 4,
    });
  });

  it("updates book lifecycle through the backend API", async () => {
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({ ...adminBookFixture, lifecycle_status: "RETIRED" }),
    );
    const updated = await createAdminBookService().updateStatus(ADMIN_BOOK_ID, {
      status: "RETIRED",
    });

    expect(updated.lifecycle_status).toBe("RETIRED");
    expect(requestedApiUrl().pathname).toBe(
      `/books/admin/catalog/${ADMIN_BOOK_ID}/status`,
    );
    expect(apiFetchFixture.mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(apiFetchFixture.mock.calls[0][1]?.body))).toEqual({
      status: "RETIRED",
    });
  });

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
