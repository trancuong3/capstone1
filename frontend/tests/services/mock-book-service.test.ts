import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBookService } from "@/lib/api/book-service";
import {
  apiFetchFixture,
  installApiFetchFixture,
  requestedApiUrl,
} from "@/test/fixtures/api-test-fixture";
import {
  bookFixture,
  pagePreviewFixture,
  TEST_BOOK_ID,
} from "@/test/fixtures/report-data-fixture";

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

describe("BookService real API contract (migrated from legacy mock tests)", () => {
  it("returns validated ACTIVE catalog data without generating records", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json([bookFixture]));
    expect(await createBookService().list()).toEqual([bookFixture]);
    expect(requestedApiUrl().pathname).toBe("/books/catalog");
    apiFetchFixture.mockResolvedValueOnce(Response.json([]));
    expect(await createBookService().list()).toEqual([]);
  });

  it("forwards encoded search, author and grade to the backend", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json([bookFixture]));
    await createBookService().list({
      search: "A & B",
      author: "Tác giả",
      grade: 2,
    });
    const url = requestedApiUrl();
    expect(url.searchParams.get("search")).toBe("A & B");
    expect(url.searchParams.get("author")).toBe("Tác giả");
    expect(url.searchParams.get("grade")).toBe("2");
  });

  it("returns preview-safe ACTIVE pages with stored verified revision IDs", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json([pagePreviewFixture]));
    expect(await createBookService().listPages(TEST_BOOK_ID)).toEqual([
      pagePreviewFixture,
    ]);
    expect(requestedApiUrl().pathname).toBe(
      `/books/catalog/${TEST_BOOK_ID}/preview`,
    );
  });

  it.each([
    {
      payload: { ...bookFixture, lifecycle_status: "RETIRED" },
      name: "inactive book",
    },
    {
      payload: { ...bookFixture, min_grade: 5, max_grade: 1 },
      name: "inverted grades",
    },
  ])(
    "rejects $name instead of silently manufacturing eligible data",
    async ({ payload }) => {
      apiFetchFixture.mockResolvedValueOnce(Response.json([payload]));
      await expect(createBookService().list()).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });
    },
  );

  it.each([
    { ...pagePreviewFixture, current_verified_revision_id: null },
    { ...pagePreviewFixture, lifecycle_status: "RETIRED" },
    { ...pagePreviewFixture, preview_url: "javascript:alert(1)" },
  ])("rejects incomplete or unsafe page previews", async (payload) => {
    apiFetchFixture.mockResolvedValueOnce(Response.json([payload]));
    await expect(
      createBookService().listPages(TEST_BOOK_ID),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it.each([
    { status: 404, code: "RESOURCE_NOT_FOUND" },
    { status: 409, code: "CONTENT_INACTIVE" },
  ])(
    "preserves canonical HTTP $status failures without exposing server details",
    async ({ status, code }) => {
      apiFetchFixture.mockResolvedValueOnce(
        Response.json({ detail: "private token SQL" }, { status }),
      );
      await expect(createBookService().get(TEST_BOOK_ID)).rejects.toMatchObject(
        {
          status,
          code,
          retryable: false,
          message: "Có lỗi xảy ra. Vui lòng thử lại sau.",
        },
      );
    },
  );
});
