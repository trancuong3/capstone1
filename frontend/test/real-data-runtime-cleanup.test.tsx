import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminNewBookScreen } from "@/components/admin/admin-new-book-screen";
import { AdminPageUploader } from "@/components/admin/admin-page-uploader";
import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { BookLibraryScreen } from "@/components/books/book-library-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useRouter: () => ({ push: vi.fn() }) };
});

vi.mock("@/lib/supabase/admin-auth-service", () => ({
  createSupabaseAdminAuthService: () => ({}),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "isolated-token" } },
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
  title: "Dữ liệu thật từ API kiểm thử",
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

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const readRoutes = [
  "app/(app)/profile/page.tsx",
  "app/(app)/books/page.tsx",
  "app/(app)/books/[bookId]/page.tsx",
  "app/(app)/sessions/page.tsx",
  "app/(app)/sessions/[sessionId]/page.tsx",
  "app/(app)/reports/page.tsx",
  "app/(app)/reports/difficult-words/page.tsx",
  "app/admin/(protected)/books/page.tsx",
  "app/admin/(protected)/books/[bookId]/page.tsx",
  "app/admin/(protected)/books/[bookId]/pages/[pageId]/page.tsx",
  "app/admin/(protected)/books/new/page.tsx",
  "app/admin/(protected)/audit-logs/page.tsx",
  "app/admin/(protected)/health/page.tsx",
];

describe("Phase 5 real-data runtime cleanup", () => {
  it("converted pages no longer parse or pass demo state", () => {
    for (const path of readRoutes) {
      expect(source(path), path).not.toMatch(
        /parse(?:AppMockScenario|AdminScenario|Group5DemoState)|(?:\bscenario|\w+Scenario)=|\bstate\?:|lib\/mock\//,
      );
    }
  });
  it("Admin root layout uses real service provider without a local mock store", () => {
    const layout = source("app/admin/layout.tsx");
    expect(layout).toContain("<AdminServicesProvider>");
    expect(layout).not.toMatch(
      /AdminStore|admin-store-provider|scenario=|authMode=/,
    );
    expect(source("app/admin/(protected)/layout.tsx")).toContain(
      'requireAppRole("admin")',
    );
  });
  it("all converted services and providers avoid runtime mock imports", () => {
    for (const path of [
      "components/providers/app-services-provider.tsx",
      "components/providers/admin-services-provider.tsx",
      ...[
        "book",
        "session",
        "report",
        "difficult-word",
        "admin-book",
        "admin-page",
        "revision",
        "ocr-review",
        "audit",
        "health",
      ].map((name) => `lib/api/${name}-service.ts`),
    ]) {
      expect(source(path), path).not.toMatch(
        /(?:from\s*|import\s*\()\s*["'](?:@\/|\.\.?\/).*mock/i,
      );
    }
  });
  it("Admin Books OCR components use real services without fabricated OCR output", () => {
    for (const path of [
      "components/admin/admin-book-detail-screen.tsx",
      "components/admin/admin-ocr-review-screen.tsx",
      "components/admin/admin-new-book-screen.tsx",
      "components/admin/admin-page-uploader.tsx",
    ]) {
      expect(source(path), path).not.toMatch(
        /wordsFromText|OCR mock|fake OCR|mock OCR/i,
      );
    }
    expect(source("components/admin/admin-ocr-review-screen.tsx")).toMatch(
      /ocr\.saveDraft\(/,
    );
    expect(source("components/admin/admin-ocr-review-screen.tsx")).toMatch(
      /revisions\.verify\(/,
    );
    expect(source("components/admin/admin-ocr-review-screen.tsx")).toMatch(
      /revisions\.reprocess\(/,
    );
    expect(source("components/admin/admin-new-book-screen.tsx")).toMatch(
      /books\.create\(/,
    );
    expect(source("components/admin/admin-page-uploader.tsx")).toMatch(
      /pages\.upload\(/,
    );
  });
  it("new-book screen exposes a validated form and waits for submit before writing", () => {
    render(
      <AdminServicesProvider>
        <AdminNewBookScreen />
      </AdminServicesProvider>,
    );
    expect(
      screen.getByRole("heading", { name: "Tạo sách mới" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Tên sách" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /Tác giả/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Khối lớp nhỏ nhất" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Khối lớp lớn nhất" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tạo sách" })).toBeEnabled();
    expect(
      screen.getByRole("link", { name: /Hủy và quay lại/ }),
    ).toHaveAttribute("href", "/admin/books");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uploader accepts multiple page images and exposes the real upload action", () => {
    const onUploaded = vi.fn();
    render(
      <AdminServicesProvider>
        <AdminPageUploader
          bookId={bookId}
          nextPageNumber={1}
          onUploaded={onUploaded}
        />
      </AdminServicesProvider>,
    );
    const input = screen.getByLabelText(/Chọn một hoặc nhiều ảnh trang sách/);
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    expect(input).toHaveAttribute("multiple");
    expect(
      screen.getByRole("button", { name: "Upload và chạy OCR" }),
    ).toBeEnabled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("legacy Admin scenario props cannot replace actual API catalog", async () => {
    fetchMock.mockResolvedValue(
      Response.json([
        {
          book,
          page_count: 0,
          processing_count: 0,
          needs_review_count: 0,
          verified_count: 0,
          parent_catalog_eligible: false,
        },
      ]),
    );
    render(
      <AdminServicesProvider scenario="empty" authMode="mock">
        <AdminBooksScreen />
      </AdminServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain("/books/admin/catalog");
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => (init as RequestInit).method === "GET",
      ),
    ).toBe(true);
  });
  it("legacy Parent scenario props cannot replace the real books adapter", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      Response.json(url.includes("/profiles/children") ? [] : [book]),
    );
    render(
      <AppServicesProvider
        scenario="empty"
        bookScenario="empty"
        reportScenario="error"
      >
        <BookLibraryScreen />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/books/catalog"),
        ),
      ).toBe(true),
    );
  });
});
