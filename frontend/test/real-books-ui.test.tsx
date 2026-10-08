import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookDetailScreen } from "@/components/books/book-detail-screen";
import { BookLibraryScreen } from "@/components/books/book-library-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
const book = {
  id: bookId,
  title: "Sách từ API thật",
  author: "Tác giả API",
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
};
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/profiles/children")) return Response.json([]);
    if (url.endsWith("/preview")) return Response.json({}, { status: 503 });
    if (url.endsWith(`/catalog/${bookId}`)) return Response.json(book);
    return Response.json([book]);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Books UI with real service HTTP test doubles", () => {
  it("shows actual empty catalog, not a fabricated fallback", async () => {
    fetchMock.mockImplementation(async () => Response.json([]));
    render(
      <AppServicesProvider>
        <BookLibraryScreen />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", {
        name: "Thư viện đang được cập nhật",
      }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/books/catalog"),
      ),
    ).toHaveLength(1);
  });
  it("distinguishes no search results and clears the filter", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/profiles/children")) return Response.json([]);
      const search = new URL(url).searchParams.get("search");
      return Response.json(search?.trim() ? [] : [book]);
    });
    render(
      <AppServicesProvider>
        <BookLibraryScreen />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: book.title });
    await user.type(screen.getByRole("searchbox"), "không có");
    expect(
      await screen.findByRole("heading", {
        name: "Không tìm thấy cuốn sách phù hợp",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Xóa bộ lọc" }));
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
  });
  it("recovers from a catalog failure through retry", async () => {
    const user = userEvent.setup();
    let failed = true;
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/profiles/children")
        ? Response.json([])
        : failed
          ? Response.json({ detail: "private sql" }, { status: 500 })
          : Response.json([book]),
    );
    render(
      <AppServicesProvider>
        <BookLibraryScreen />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByText("Chưa tải được thư viện sách"),
    ).toBeInTheDocument();
    expect(screen.queryByText("private sql")).not.toBeInTheDocument();
    failed = false;
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
  });
  it("does not stay loading or request books for an inaccessible child; retry recovers", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(Response.json({}, { status: 404 }));
    render(
      <AppServicesProvider>
        <BookLibraryScreen requestedChildId={bookId} />
      </AppServicesProvider>,
    );
    await screen.findByText("Không thể chọn hồ sơ bé");
    expect(
      screen.queryByLabelText("Đang tải thư viện sách"),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.every(([url]) =>
        String(url).includes("/profiles/children"),
      ),
    ).toBe(true);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/profiles/children")
        ? Response.json({
            id: bookId,
            parent_id: bookId,
            alias: "Bé API",
            grade: 2,
            settings: {},
            created_at: "2026-10-08T00:00:00Z",
          })
        : Response.json([book]),
    );
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
  });
  it("uses API book fields, not runtime catalog fixtures", async () => {
    render(
      <AppServicesProvider>
        <BookLibraryScreen />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Chú Mèo Nhỏ")).not.toBeInTheDocument();
  });
  it("keeps metadata visible when preview images have not been provided", async () => {
    render(
      <AppServicesProvider>
        <BookDetailScreen bookId={bookId} />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: book.title }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ảnh xem trước chưa sẵn sàng")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bắt đầu đọc" })).toBeDisabled();
  });
  it("retries an unavailable preview and renders the real image URL without sample text", async () => {
    const user = userEvent.setup();
    render(
      <AppServicesProvider>
        <BookDetailScreen bookId={bookId} />
      </AppServicesProvider>,
    );
    await screen.findByText("Ảnh xem trước chưa sẵn sàng");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/profiles/children")) return Response.json([]);
      if (url.endsWith("/preview"))
        return Response.json([
          {
            page_id: bookId,
            page_number: 4,
            lifecycle_status: "ACTIVE",
            current_verified_revision_id: bookId,
            preview_url: "https://example.test/actual-page.png",
          },
        ]);
      return Response.json(book);
    });
    await user.click(screen.getByRole("button", { name: "Thử tải ảnh lại" }));
    const image = await screen.findByRole("img", {
      name: "Ảnh xem trước trang 4",
    });
    expect(image).toHaveAttribute(
      "src",
      "https://example.test/actual-page.png",
    );
    expect(
      screen.queryByText("Một buổi sáng yên bình"),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText("Ảnh xem trước chưa sẵn sàng"),
      ).not.toBeInTheDocument(),
    );
  });
  it("shows unavailable for content that is no longer parent eligible", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/profiles/children")
        ? Response.json([])
        : Response.json({}, { status: 409 }),
    );
    render(
      <AppServicesProvider>
        <BookDetailScreen bookId={bookId} />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Sách hiện chưa sẵn sàng" }),
    ).toBeInTheDocument();
  });
  it("shows backend not-found without exposing server details", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/profiles/children")
        ? Response.json([])
        : Response.json({ detail: "private account data" }, { status: 404 }),
    );
    render(
      <AppServicesProvider>
        <BookDetailScreen bookId={bookId} />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy sách" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("private account data")).not.toBeInTheDocument();
  });
});
