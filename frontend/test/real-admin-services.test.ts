import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminBookService } from "@/lib/api/admin-book-service";
import { createAdminPageService } from "@/lib/api/admin-page-service";
import { createRevisionService } from "@/lib/api/revision-service";
import { createOcrReviewService } from "@/lib/api/ocr-review-service";
import { createAuditService } from "@/lib/api/audit-service";
import { createHealthService } from "@/lib/api/health-service";

// Exercise Admin OCR writes through the real request adapter.
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
  name: "Real book name",
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
  it("reads book metadata and next page number from the admin route", async () => {
    const adminBookDetail = { ...book, next_page_number: 8 };
    fetchMock.mockResolvedValue(Response.json(adminBookDetail));
    expect(await createAdminBookService().get(bookId)).toEqual(adminBookDetail);
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

  it("uploads a replacement image for the existing page without sending a page number", async () => {
    fetchMock.mockResolvedValue(Response.json(detail));
    const file = new File(["new page image"], "page-1.png", { type: "image/png" });
    const result = await createAdminPageService().replaceImageAndReprocess(pageId, file);
    expect(result).toEqual(detail);
    expect(requestedApiUrl().pathname).toBe(
      `/books/admin/pages/${pageId}/reupload-ocr`,
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("image")).toMatchObject({ name: "page-1.png" });
    expect((init.body as FormData).get("page_number")).toBeNull();
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
  it("shows a mapped safe message for a known OCR configuration error", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { detail: "Supabase Storage is not configured" },
        { status: 503 },
      ),
    );
    await expect(createAdminBookService().list()).rejects.toMatchObject({
      status: 503,
      message: "Backend chưa cấu hình SUPABASE_STORAGE_BUCKET trong file .env.",
    });
  });

  it("shows the safe Storage bucket reason and includes its request ID", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          detail:
            "Supabase Storage bucket was not found; verify SUPABASE_STORAGE_BUCKET in the configured project",
        },
        {
          status: 503,
          headers: { "X-Request-ID": "request-test-123" },
        },
      ),
    );
    await expect(createAdminBookService().list()).rejects.toMatchObject({
      status: 503,
      request_id: "request-test-123",
      message:
        "Không tìm thấy bucket trong Supabase project đang cấu hình. Hãy kiểm tra đúng tên bucket và SUPABASE_URL. Mã yêu cầu: request-test-123.",
    });
  });

  it("creates a book through the protected Admin endpoint", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(book));
    const created = await createAdminBookService().create({
      name: "  Tên mèo nhỏ  ",
      title: "  Chú mèo nhỏ  ",
      author: "  ",
      min_grade: 1,
      max_grade: 3,
    });
    expect(created).toEqual(book);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/books/admin/catalog");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Tên mèo nhỏ",
      title: "Chú mèo nhỏ",
      author: null,
      min_grade: 1,
      max_grade: 3,
    });
  });

  it("uploads each page as multipart data and reloads the server page list", async () => {
    const needsReviewDetail = {
      ...detail,
      verification_status: "NEEDS_REVIEW",
      draft_text: "Chú mèo",
      words: [],
      verified_at: null,
      verified_by: null,
    };
    const file = new File(["valid-for-mock"], "page-2.png", {
      type: "image/png",
    });
    const input = {
      client_id: "2-page-2.png-14",
      file_name: file.name,
      mime_type: "image/png" as const,
      size_bytes: file.size,
      page_number: 2,
      width: 800,
      height: 1000,
      file,
    };
    fetchMock
      .mockResolvedValueOnce(Response.json(needsReviewDetail))
      .mockResolvedValueOnce(Response.json([page]));
    const progress: { status: string; progress_percent: number }[] = [];
    const result = await createAdminPageService().upload(
      bookId,
      [input],
      (item) => {
        progress.push({
          status: item.status,
          progress_percent: item.progress_percent,
        });
      },
    );
    expect(result).toEqual([page]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/books/admin/catalog/${bookId}/pages`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("page_number")).toBeNull();
    expect((init.body as FormData).get("image")).toMatchObject({
      name: "page-2.png",
    });
    expect(
      (init.headers as Record<string, string>)["Content-Type"],
    ).toBeUndefined();
    expect(progress).toEqual([
      { status: "UPLOADING", progress_percent: 0 },
      { status: "PROCESSING", progress_percent: 100 },
    ]);
  });

  it("shows a safe Storage reason for a failed page upload", async () => {
    const file = new File(["image-bytes"], "page-3.png", {
      type: "image/png",
    });
    const input = {
      client_id: "3-page-3.png-11",
      file_name: file.name,
      mime_type: "image/png" as const,
      size_bytes: file.size,
      page_number: 3,
      width: 800,
      height: 1000,
      file,
    };
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          {
            detail:
              "Server-side Supabase Storage credentials are not configured",
          },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json([page]));
    const progress: { status: string; error_message?: string }[] = [];

    expect(
      await createAdminPageService().upload(bookId, [input], (item) => {
        progress.push({
          status: item.status,
          error_message: item.error_message,
        });
      }),
    ).toEqual([page]);
    expect(progress[1]).toEqual({
      status: "FAILED",
      error_message:
        "Backend thiếu SUPABASE_SECRET_KEY hoặc SUPABASE_SERVICE_ROLE_KEY. Hãy cấu hình khóa chỉ ở môi trường Backend.",
    });
  });

  it("persists an OCR draft using the validated revision contract", async () => {
    const word = {
      word_index: 0,
      line_index: 0,
      text: "Chú",
      normalized_text: "chú",
      bbox: [0.1, 0.2, 0.2, 0.05] as const,
      ocr_confidence: 0.82,
    };
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...detail,
        verification_status: "NEEDS_REVIEW",
        draft_text: "Chú",
        words: [word],
        verified_at: null,
        verified_by: null,
      }),
    );
    const saved = await createOcrReviewService().saveDraft(
      pageId,
      revisionId,
      "Chú",
      [word],
    );
    expect(saved.draft_text).toBe("Chú");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      `/books/admin/pages/${pageId}/revisions/${revisionId}/draft`,
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({
      draft_text: "Chú",
      words: [{ word_index: 0, bbox: [0.1, 0.2, 0.2, 0.05] }],
    });
  });

  it("verifies a revision and can request a new immutable OCR revision", async () => {
    const word = {
      word_index: 0,
      line_index: 0,
      text: "Chú",
      normalized_text: "chú",
      bbox: [0.1, 0.2, 0.2, 0.05] as const,
      ocr_confidence: 0.82,
    };
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...detail,
        verification_status: "VERIFIED",
        draft_text: "Chú",
        words: [word],
        verified_at: timestamp,
        verified_by: "11111111-1111-4111-8111-111111111111",
      }),
    );
    const verified = await createRevisionService().verify(pageId, {
      page_revision_id: revisionId,
      corrected_text: "Chú",
      words: [word],
    });
    expect(verified.verification_status).toBe("VERIFIED");
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(verifyUrl).toContain(`/books/admin/pages/${pageId}/verify`);
    expect(verifyInit.method).toBe("POST");

    const nextRevisionId = "55555555-5555-4555-8555-555555555555";
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...detail,
        page_revision_id: nextRevisionId,
        revision_no: 3,
        verification_status: "NEEDS_REVIEW",
        draft_text: "Chú",
        words: [word],
        verified_at: null,
        verified_by: null,
      }),
    );
    const next = await createRevisionService().reprocess(pageId);
    expect(next.page_revision_id).toBe(nextRevisionId);
    expect(next.revision_no).toBe(3);
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/books/admin/pages/${pageId}/reprocess`,
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("updates metadata and lifecycle through the real book API adapters", async () => {
    const books = createAdminBookService();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...book,
        title: "Updated title",
        min_grade: 2,
        max_grade: 4,
      }),
    );

    const updated = await books.update(bookId, {
      name: "Real book name",
      title: "  Updated title  ",
      author: "  Author  ",
      min_grade: 2,
      max_grade: 4,
    });

    expect(updated.name).toBe("Real book name");
    expect(updated.title).toBe("Updated title");
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/books/admin/catalog/${bookId}`,
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      name: "Real book name",
      title: "Updated title",
      author: "Author",
      min_grade: 2,
      max_grade: 4,
    });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      Response.json({ ...book, lifecycle_status: "RETIRED" }),
    );
    const retired = await books.updateStatus(bookId, { status: "RETIRED" });

    expect(retired.lifecycle_status).toBe("RETIRED");
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/books/admin/catalog/${bookId}/status`,
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      status: "RETIRED",
    });
  });

  it("keeps unsupported page lifecycle updates unavailable", async () => {
    await expect(
      createAdminPageService().updateStatus(pageId, { status: "RETIRED" }),
    ).rejects.toMatchObject({ status: 501 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
