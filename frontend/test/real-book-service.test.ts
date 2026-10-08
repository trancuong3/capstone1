import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBookService } from "@/lib/api/book-service";

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

const id = "22222222-2222-4222-8222-222222222222";
const book = {
  id,
  title: "Tên sách API",
  author: null,
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
};
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("real BookService", () => {
  it("preserves PostgreSQL UUIDs in the shared Parent book contract", async () => {
    const storedId = "00000000-0000-0000-0000-000000000101";
    const storedBook = { ...book, id: storedId };
    fetchMock
      .mockResolvedValueOnce(Response.json([storedBook]))
      .mockResolvedValueOnce(Response.json(storedBook));
    const service = createBookService();
    expect(await service.list()).toEqual([storedBook]);
    expect(await service.get(storedId)).toEqual(storedBook);
  });
  it("reads catalog and encodes search/grade filters", async () => {
    fetchMock.mockResolvedValue(Response.json([book]));
    expect(
      await createBookService().list({ search: "Mèo & em", grade: 2 }),
    ).toEqual([book]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8000/books/catalog?search=M%C3%A8o+%26+em&grade=2",
    );
  });
  it("accepts actual empty catalog without fallback books", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    expect(await createBookService().list()).toEqual([]);
  });
  it("rejects retired or invalid catalog responses", async () => {
    fetchMock.mockResolvedValue(
      Response.json([{ ...book, lifecycle_status: "RETIRED" }]),
    );
    await expect(createBookService().list()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("reads detail from the scoped backend route", async () => {
    fetchMock.mockResolvedValue(Response.json(book));
    expect(await createBookService().get(id)).toEqual(book);
    expect(fetchMock.mock.calls[0][0]).toContain(`/books/catalog/${id}`);
  });
  it("preserves not-found, unavailable and missing-image failures", async () => {
    fetchMock.mockResolvedValue(Response.json({}, { status: 404 }));
    await expect(createBookService().get(id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    fetchMock.mockResolvedValue(Response.json({}, { status: 409 }));
    await expect(createBookService().get(id)).rejects.toMatchObject({
      code: "CONTENT_INACTIVE",
    });
    fetchMock.mockResolvedValue(Response.json({}, { status: 503 }));
    await expect(createBookService().listPages(id)).rejects.toMatchObject({
      status: 503,
    });
  });
  it("does not accept relative or unverified previews", async () => {
    fetchMock.mockResolvedValue(
      Response.json([
        {
          page_id: id,
          page_number: 1,
          lifecycle_status: "ACTIVE",
          current_verified_revision_id: null,
          preview_url: "image.png",
        },
      ]),
    );
    await expect(createBookService().listPages(id)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("rejects an inverted grade range instead of displaying invalid data", async () => {
    fetchMock.mockResolvedValue(
      Response.json([{ ...book, min_grade: 4, max_grade: 2 }]),
    );
    await expect(createBookService().list()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("rejects image URLs containing embedded credentials", async () => {
    fetchMock.mockResolvedValue(
      Response.json([
        {
          page_id: id,
          page_number: 1,
          lifecycle_status: "ACTIVE",
          current_verified_revision_id: id,
          preview_url: "https://user:password@example.test/page.png",
        },
      ]),
    );
    await expect(createBookService().listPages(id)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
});
