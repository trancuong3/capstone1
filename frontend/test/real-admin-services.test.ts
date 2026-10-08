import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminBookService } from "@/lib/api/admin-book-service";
import { createAdminPageService } from "@/lib/api/admin-page-service";
import { createRevisionService } from "@/lib/api/revision-service";
import { createOcrReviewService } from "@/lib/api/ocr-review-service";
import { createAuditService } from "@/lib/api/audit-service";
import { createHealthService } from "@/lib/api/health-service";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const bookId = "22222222-2222-4222-8222-222222222222";
const pageId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-10-08T00:00:00Z";
const book = {
  id: bookId,
  title: "Real retired book",
  author: null,
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "RETIRED",
};
const processing = {
  page_id: pageId,
  page_revision_id: revisionId,
  revision_no: 2,
  verification_status: "VERIFIED",
  lifecycle_status: "ACTIVE",
  ocr_preview_metadata: {},
  verified_at: timestamp,
  current_verified_revision_id: revisionId,
};
const page = { book_id: bookId, page_number: 2, processing };
const image = {
  page_id: pageId,
  page_number: 2,
  preview_url: "https://example.test/image.png",
  width: 800,
  height: 1000,
};
const detail = {
  ...processing,
  draft_text: "Real text",
  words: [],
  ocr_metadata: {},
  created_at: timestamp,
  verified_by: null,
};
const auditEntry = {
  id: revisionId,
  actor_id: null,
  resource_id: null,
  action: "book.read",
  resource_type: "book",
  request_id: null,
  created_at: timestamp,
  metadata: {},
};
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("real Admin adapters", () => {
  it.each([
    "00000000-0000-0000-0000-000000000101",
    "11111111-1111-1111-1111-111111111111",
  ])("preserves PostgreSQL book UUID %s in catalog and detail", async (id) => {
    const storedBook = { ...book, id };
    const row = {
      book: storedBook,
      page_count: 1,
      processing_count: 0,
      needs_review_count: 0,
      verified_count: 1,
      parent_catalog_eligible: false,
    };
    fetchMock
      .mockResolvedValueOnce(Response.json([row]))
      .mockResolvedValueOnce(Response.json(storedBook));
    const service = createAdminBookService();
    expect(await service.list()).toEqual([row]);
    expect(await service.get(id)).toEqual(storedBook);
    expect(fetchMock.mock.calls[1][0]).toContain(`/books/admin/catalog/${id}`);
  });
  it.each([
    "not-a-uuid",
    "00000000000000000000000000000101",
    "00000000-0000-0000-0000-00000000010g",
    101,
  ])("still rejects malformed book ID %s", async (id) => {
    fetchMock.mockResolvedValue(
      Response.json([
        {
          book: { ...book, id },
          page_count: 1,
          processing_count: 0,
          needs_review_count: 0,
          verified_count: 1,
          parent_catalog_eligible: false,
        },
      ]),
    );
    await expect(createAdminBookService().list()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("reads retired admin books and encodes exact filters", async () => {
    const row = {
      book,
      page_count: 2,
      processing_count: 0,
      needs_review_count: 1,
      verified_count: 1,
      parent_catalog_eligible: false,
    };
    fetchMock.mockResolvedValue(Response.json([row]));
    expect(
      await createAdminBookService().list({
        search: "A & B",
        lifecycle_status: "RETIRED",
        verification_status: "VERIFIED",
      }),
    ).toEqual([row]);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/books/admin/catalog");
    expect(url.searchParams.get("search")).toBe("A & B");
    expect(url.searchParams.get("lifecycle_status")).toBe("RETIRED");
    expect(url.searchParams.get("verification_status")).toBe("VERIFIED");
  });
  it("reads book metadata from the admin route", async () => {
    fetchMock.mockResolvedValue(Response.json(book));
    expect(await createAdminBookService().get(bookId)).toEqual(book);
  });
  it("rejects a book belonging to a different requested ID", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...book, id: pageId }));
    await expect(createAdminBookService().get(bookId)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("reads pages with real processing values", async () => {
    fetchMock.mockResolvedValue(Response.json([page]));
    expect(await createAdminPageService().list(bookId)).toEqual([page]);
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/books/admin/catalog/${bookId}/pages`,
    );
  });
  it("rejects pages from another book", async () => {
    fetchMock.mockResolvedValue(
      Response.json([{ ...page, book_id: revisionId }]),
    );
    await expect(createAdminPageService().list(bookId)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("reads original image and processing endpoints", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(image))
      .mockResolvedValueOnce(Response.json(processing));
    expect(await createAdminPageService().getImage(pageId)).toEqual(image);
    expect(await createAdminPageService().reload(pageId)).toEqual(processing);
  });
  it.each([
    "bucket/image.png",
    "https://user:password@example.test/image",
    "javascript:alert(1)",
  ])("rejects unsafe image URL %s", async (preview_url) => {
    fetchMock.mockResolvedValue(Response.json({ ...image, preview_url }));
    await expect(
      createAdminPageService().getImage(pageId),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
  it("rejects image and processing IDs that differ from the request", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ ...image, page_id: bookId }))
      .mockResolvedValueOnce(Response.json({ ...processing, page_id: bookId }));
    await expect(
      createAdminPageService().getImage(pageId),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(createAdminPageService().reload(pageId)).rejects.toMatchObject(
      { code: "NETWORK_ERROR" },
    );
  });
  it("reads revision summaries without changing status or version", async () => {
    const summary = {
      page_revision_id: revisionId,
      revision_no: 2,
      verification_status: "VERIFIED",
      created_at: timestamp,
      is_current_verified: true,
    };
    fetchMock.mockResolvedValue(Response.json([summary]));
    expect(await createRevisionService().list(pageId)).toEqual([summary]);
  });
  it("reads nullable stored text, not generated OCR text", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...detail, draft_text: null }));
    expect(
      (await createOcrReviewService().getRevision(pageId, revisionId))
        .draft_text,
    ).toBeNull();
  });
  it.each([
    { page_id: bookId },
    { page_revision_id: bookId },
    { revision_no: "R2" },
  ])("rejects mismatched revision contracts %s", async (overrides) => {
    fetchMock.mockResolvedValue(Response.json({ ...detail, ...overrides }));
    await expect(
      createOcrReviewService().getRevision(pageId, revisionId),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
  it("rejects pixel bounding boxes rather than guessing normalization", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...detail,
        words: [
          {
            word_index: 0,
            line_index: 0,
            text: "Real",
            normalized_text: "real",
            bbox: [120, 50, 50, 20],
            ocr_confidence: null,
          },
        ],
      }),
    );
    await expect(
      createOcrReviewService().getRevision(pageId, revisionId),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
  it.each(["id", "actor_id", "resource_id"] as const)(
    "preserves PostgreSQL audit UUID in %s",
    async (field) => {
      const storedId = "00000000-0000-0000-0000-000000000201";
      const result = {
        items: [{ ...auditEntry, [field]: storedId }],
        next_cursor: null,
      };
      fetchMock.mockResolvedValue(Response.json(result));
      expect(await createAuditService().list()).toEqual(result);
    },
  );
  it.each([
    { field: "id", value: "not-a-uuid" },
    { field: "actor_id", value: 101 },
    { field: "resource_id", value: "00000000-0000-0000-0000-00000000020g" },
    { field: "id", value: null },
  ])(
    "rejects invalid audit identifier $field=$value",
    async ({ field, value }) => {
      fetchMock.mockResolvedValue(
        Response.json({
          items: [{ ...auditEntry, [field]: value }],
          next_cursor: null,
        }),
      );
      await expect(createAuditService().list()).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });
    },
  );
  it("reads audit nullable actors and forwards filters and cursor", async () => {
    const result = {
      items: [
        {
          id: revisionId,
          actor_id: null,
          resource_id: null,
          action: "book.read",
          resource_type: "book",
          request_id: null,
          created_at: timestamp,
          metadata: {},
        },
      ],
      next_cursor: "page-3",
    };
    fetchMock.mockResolvedValue(Response.json(result));
    expect(
      await createAuditService().list({
        action: "book.read",
        resource_type: "book",
        cursor: "page-2",
        limit: 10,
      }),
    ).toEqual(result);
    const query = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
    expect(query.get("cursor")).toBe("page-2");
    expect(query.get("action")).toBe("book.read");
  });
  it("reads actual backend health snapshot", async () => {
    const result = {
      overall_status: "DEGRADED",
      checked_at: timestamp,
      services: [
        {
          id: "database",
          label: "Database",
          status: "UNAVAILABLE",
          checked_at: timestamp,
          safe_message: "Không thể kết nối.",
        },
      ],
    };
    fetchMock.mockResolvedValue(Response.json(result));
    expect(await createHealthService().get()).toEqual(result);
    expect(fetchMock.mock.calls[0][0]).toContain("/system/admin/health");
  });
  it.each([401, 403, 404, 501, 503])(
    "preserves HTTP %s with a safe generic message",
    async (status) => {
      fetchMock.mockResolvedValue(
        Response.json({ detail: "private token sql" }, { status }),
      );
      await expect(createAdminBookService().list()).rejects.toMatchObject({
        status,
        message: "Có lỗi xảy ra. Vui lòng thử lại sau.",
      });
    },
  );
  it("retains write interfaces but never fetches or reports fake success", async () => {
    const books = createAdminBookService();
    const pages = createAdminPageService();
    const revisions = createRevisionService();
    const operations = [
      books.create({ title: "X", author: null, min_grade: 1, max_grade: 3 }),
      books.update(bookId, {
        title: "X",
        author: null,
        min_grade: 1,
        max_grade: 3,
      }),
      books.updateStatus(bookId, { status: "RETIRED" }),
      pages.upload(bookId, []),
      pages.updateStatus(pageId, { status: "RETIRED" }),
      revisions.verify(pageId, {
        page_revision_id: revisionId,
        corrected_text: "X",
        words: [],
      }),
      revisions.reprocess(pageId),
      createOcrReviewService().saveDraft(pageId, revisionId, "X", []),
    ];
    await Promise.all(
      operations.map((operation) =>
        expect(operation).rejects.toMatchObject({ status: 501 }),
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
