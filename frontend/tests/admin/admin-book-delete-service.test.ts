import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminBookService } from "@/lib/api/admin-book-service";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
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
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("Admin book soft-delete API adapter", () => {
  it("sends an authenticated DELETE request and validates its response", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ book_id: bookId, is_deleted: true }),
    );

    await expect(createAdminBookService().delete(bookId)).resolves.toEqual({
      book_id: bookId,
      is_deleted: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/books/admin/catalog/${bookId}`);
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(init.body).toBeUndefined();
  });

  it("rejects a deletion response for a different book ID", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        book_id: "33333333-3333-4333-8333-333333333333",
        is_deleted: true,
      }),
    );

    await expect(createAdminBookService().delete(bookId)).rejects.toMatchObject(
      {
        code: "NETWORK_ERROR",
      },
    );
  });
});
