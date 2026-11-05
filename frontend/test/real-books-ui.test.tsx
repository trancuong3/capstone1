import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookDetailScreen } from "@/components/books/book-detail-screen";
import { BookLibraryScreen } from "@/components/books/book-library-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}));
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
const childId = "33333333-3333-4333-8333-333333333333";
const child = {
  id: childId,
  parent_id: "44444444-4444-4444-8444-444444444444",
  alias: "Bé API",
  grade: 2,
  settings: {},
  created_at: "2026-10-08T00:00:00Z",
};
const book = {
  id: bookId,
  title: "Sách từ API thật",
  author: "Tác giả API",
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
};
const page = {
  page_id: "55555555-5555-4555-8555-555555555555",
  page_number: 4,
  lifecycle_status: "ACTIVE",
  current_verified_revision_id: "66666666-6666-4666-8666-666666666666",
  preview_url: "https://example.test/actual-page.png",
};
const fetchMock = vi.fn();
function renderWithChild(ui: React.ReactNode) {
  return render(
    <WithSelectedChild childId={childId}>
      <AppServicesProvider>{ui}</AppServicesProvider>
    </WithSelectedChild>,
  );
}
function defaultResponse(url: string) {
  const pathname = new URL(url).pathname;
  if (pathname === `/profiles/children/${childId}`) return Response.json(child);
  if (pathname === `/books/catalog/${bookId}/preview`)
    return Response.json([page]);
  if (pathname === `/books/catalog/${bookId}`) return Response.json(book);
  if (pathname === "/books/catalog") return Response.json([book]);
  return Response.json([]);
}
beforeEach(() => {
  replaceMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => defaultResponse(url));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Books UI with real service HTTP test doubles", () => {
  it("shows actual empty catalog, not a fabricated fallback", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (new URL(url).pathname === `/profiles/children/${childId}`)
        return Response.json(child);
      return Response.json([]);
    });
    renderWithChild(<BookLibraryScreen />);
    expect(
      await screen.findByRole("heading", {
        name: "Thư viện đang được cập nhật",
      }),
    ).toBeInTheDocument();
  });

  it("distinguishes no search results and clears the filter", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) => {
      if (new URL(url).pathname === `/profiles/children/${childId}`)
        return Response.json(child);
      const search = new URL(url).searchParams.get("search");
      return Response.json(search?.trim() ? [] : [book]);
    });
    renderWithChild(<BookLibraryScreen />);
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
    fetchMock.mockImplementation(async (url: string) => {
      if (new URL(url).pathname === `/profiles/children/${childId}`)
        return Response.json(child);
      return failed
        ? Response.json({ detail: "private sql" }, { status: 500 })
        : Response.json([book]);
    });
    renderWithChild(<BookLibraryScreen />);
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

  it("returns to Dashboard and does not request books for a child the API no longer allows", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (new URL(url).pathname.startsWith("/profiles/children/"))
        return Response.json({}, { status: 404 });
      return Response.json([book]);
    });
    renderWithChild(<BookLibraryScreen />);
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(
        "/dashboard?focus=child-selection&reason=invalid",
      ),
    );
    expect(
      fetchMock.mock.calls.every(([url]) =>
        new URL(String(url)).pathname.startsWith("/profiles/children/"),
      ),
    ).toBe(true);
  });

  it("uses API book fields, not runtime catalog fixtures", async () => {
    renderWithChild(<BookLibraryScreen />);
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Chú Mèo Nhỏ")).not.toBeInTheDocument();
  });

  it("keeps metadata visible when preview images have not been provided", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname === `/profiles/children/${childId}`)
        return Response.json(child);
      if (pathname.endsWith("/preview"))
        return Response.json({}, { status: 503 });
      if (pathname.endsWith(`/catalog/${bookId}`)) return Response.json(book);
      return Response.json([]);
    });
    renderWithChild(<BookDetailScreen bookId={bookId} />);
    expect(
      await screen.findByRole("heading", { level: 1, name: book.title }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ảnh xem trước chưa sẵn sàng")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chuẩn bị đọc" })).toBeDisabled();
  });

  it("retries an unavailable preview and renders the real image URL without sample text", async () => {
    const user = userEvent.setup();
    let previewUnavailable = true;
    fetchMock.mockImplementation(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname === `/profiles/children/${childId}`)
        return Response.json(child);
      if (pathname.endsWith("/preview"))
        return previewUnavailable
          ? Response.json({}, { status: 503 })
          : Response.json([page]);
      if (pathname.endsWith(`/catalog/${bookId}`)) return Response.json(book);
      return Response.json([]);
    });
    renderWithChild(<BookDetailScreen bookId={bookId} />);
    await screen.findByText("Ảnh xem trước chưa sẵn sàng");
    previewUnavailable = false;
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
    fetchMock.mockImplementation(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname === `/profiles/children/${childId}`)
        return Response.json(child);
      return Response.json(
        {},
        { status: pathname.endsWith(`/catalog/${bookId}`) ? 409 : 200 },
      );
    });
    renderWithChild(<BookDetailScreen bookId={bookId} />);
    expect(
      await screen.findByRole("heading", { name: "Sách hiện chưa sẵn sàng" }),
    ).toBeInTheDocument();
  });

  it("shows backend not-found without exposing server details", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname === `/profiles/children/${childId}`)
        return Response.json(child);
      return Response.json({ detail: "private account data" }, { status: 404 });
    });
    renderWithChild(<BookDetailScreen bookId={bookId} />);
    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy sách" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("private account data")).not.toBeInTheDocument();
  });
});
