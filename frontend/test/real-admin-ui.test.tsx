import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { AdminBookDetailScreen } from "@/components/admin/admin-book-detail-screen";
import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
import { AdminAuditScreen } from "@/components/admin/admin-audit-screen";
import { AdminHealthScreen } from "@/components/admin/admin-health-screen";

vi.mock("@/lib/supabase/admin-auth-service", () => ({
  createSupabaseAdminAuthService: () => ({}),
}));
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
  title: "Sách Admin từ database",
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
const auditItem = {
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

function readyResponse(url: string): Response {
  if (url.endsWith("/image"))
    return Response.json({
      page_id: pageId,
      page_number: 2,
      preview_url: "https://example.test/image.png",
      width: 800,
      height: 1000,
    });
  if (url.endsWith(`/revisions/${revisionId}`))
    return Response.json({
      ...processing,
      draft_text: "Văn bản đã lưu thật",
      words: [],
      ocr_metadata: {},
      created_at: timestamp,
      verified_by: null,
    });
  if (url.endsWith("/revisions"))
    return Response.json([
      {
        page_revision_id: revisionId,
        revision_no: 2,
        verification_status: "VERIFIED",
        created_at: timestamp,
        is_current_verified: true,
      },
    ]);
  if (url.endsWith("/pages"))
    return Response.json([{ book_id: bookId, page_number: 2, processing }]);
  if (url.endsWith(`/catalog/${bookId}`)) return Response.json(book);
  if (url.includes("/books/admin/catalog"))
    return Response.json([
      {
        book,
        page_count: 1,
        processing_count: 0,
        needs_review_count: 0,
        verified_count: 1,
        parent_catalog_eligible: false,
      },
    ]);
  if (url.includes("/system/admin/audit-logs"))
    return Response.json({ items: [auditItem], next_cursor: "page-2" });
  if (url.endsWith("/system/admin/health"))
    return Response.json({
      overall_status: "HEALTHY",
      checked_at: timestamp,
      services: [
        {
          id: "database",
          label: "Database",
          status: "HEALTHY",
          checked_at: timestamp,
          safe_message: "Database đã phản hồi truy vấn đọc.",
        },
      ],
    });
  throw new Error("Unexpected test API route");
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => readyResponse(url));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Admin UI with real adapters and isolated HTTP responses", () => {
  it("renders and links a stored book UUID without rejecting the catalog", async () => {
    const storedId = "00000000-0000-0000-0000-000000000101";
    fetchMock.mockResolvedValue(
      Response.json([
        {
          book: { ...book, id: storedId },
          page_count: 1,
          processing_count: 0,
          needs_review_count: 0,
          verified_count: 1,
          parent_catalog_eligible: false,
        },
      ]),
    );
    render(
      <AdminServicesProvider>
        <AdminBooksScreen />
      </AdminServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Sách Admin từ database/ }),
    ).toHaveAttribute("href", `/admin/books/${storedId}`);
    expect(
      screen.queryByText("Không thể tải kho sách"),
    ).not.toBeInTheDocument();
  });
  it("renders real admin catalog including retired books and no create action", async () => {
    render(
      <AdminServicesProvider>
        <AdminBooksScreen />
      </AdminServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Sách Admin từ database/ }),
    ).toHaveAttribute("href", `/admin/books/${bookId}`);
    expect(
      screen.queryByRole("link", { name: "Thêm sách" }),
    ).not.toBeInTheDocument();
  });
  it("forwards search and lifecycle filters to the API", async () => {
    const user = userEvent.setup();
    render(
      <AdminServicesProvider>
        <AdminBooksScreen />
      </AdminServicesProvider>,
    );
    await screen.findByRole("heading", { name: book.title });
    await user.type(
      screen.getByLabelText("Tìm theo tên sách hoặc tác giả"),
      "Mèo",
    );
    await user.selectOptions(screen.getByLabelText("Vòng đời"), "RETIRED");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => {
          const query = new URL(String(url)).searchParams;
          return (
            query.get("search") === "Mèo" &&
            query.get("lifecycle_status") === "RETIRED"
          );
        }),
      ).toBe(true),
    );
  });
  it("shows genuinely empty admin catalog", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    render(
      <AdminServicesProvider>
        <AdminBooksScreen />
      </AdminServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy sách" }),
    ).toBeInTheDocument();
  });
  it("keeps book metadata when pages are unavailable and retries successfully", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/pages")
        ? Response.json({ detail: "private sql" }, { status: 501 })
        : readyResponse(url),
    );
    render(
      <AdminServicesProvider>
        <AdminBookDetailScreen bookId={bookId} />
      </AdminServicesProvider>,
    );
    await screen.findByText("Dữ liệu trang đang chờ bổ sung");
    expect(
      screen.getByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sách chưa có trang")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sửa thông tin" }),
    ).toBeDisabled();
    fetchMock.mockImplementation(async (url: string) => readyResponse(url));
    await user.click(screen.getByRole("button", { name: "Tải lại" }));
    expect(
      await screen.findByRole("heading", { name: "Trang 2" }),
    ).toBeInTheDocument();
  });
  it("shows true empty pages without promising an upload", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/pages") ? Response.json([]) : readyResponse(url),
    );
    render(
      <AdminServicesProvider>
        <AdminBookDetailScreen bookId={bookId} />
      </AdminServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Sách chưa có trang" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Dữ liệu trang đang chờ bổ sung"),
    ).not.toBeInTheDocument();
  });
  it.each([404, 501, 503])(
    "shows OCR status %s without mock fallback and offers retry",
    async (status) => {
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("/pages")
          ? Response.json({ detail: "private sql token" }, { status })
          : readyResponse(url),
      );
      render(
        <AdminServicesProvider>
          <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
        </AdminServicesProvider>,
      );
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name:
            status === 404
              ? "Không tìm thấy trang"
              : "Dữ liệu OCR đang chờ bổ sung",
        }),
      ).toBeInTheDocument();
      expect(screen.queryByText("private sql token")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Thử lại" }),
      ).toBeInTheDocument();
    },
  );
  it("rejects a page that does not belong to the requested book before loading its image", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/pages") ? Response.json([]) : readyResponse(url),
    );
    render(
      <AdminServicesProvider>
        <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </AdminServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Không tìm thấy trang" });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/image")),
    ).toBe(false);
  });
  it("renders stored revision and image in read-only mode", async () => {
    render(
      <AdminServicesProvider>
        <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </AdminServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Kiểm tra OCR · R2" });
    expect(screen.getByLabelText("Nội dung đã hiệu chỉnh")).toHaveValue(
      "Văn bản đã lưu thật",
    );
    expect(screen.getByLabelText("Nội dung đã hiệu chỉnh")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Chạy lại OCR" })).toBeDisabled();
    expect(
      screen.getByRole("img", { name: `Ảnh trang 2 của ${book.title}` }),
    ).toHaveAttribute("src", "https://example.test/image.png");
  });
  it("renders stored audit UUIDs without showing the load error", async () => {
    const actorId = "00000000-0000-0000-0000-000000000202";
    const resourceId = "00000000-0000-0000-0000-000000000203";
    fetchMock.mockResolvedValue(
      Response.json({
        items: [
          {
            ...auditItem,
            id: "00000000-0000-0000-0000-000000000201",
            actor_id: actorId,
            resource_id: resourceId,
          },
        ],
        next_cursor: null,
      }),
    );
    render(
      <AdminServicesProvider>
        <AdminAuditScreen />
      </AdminServicesProvider>,
    );
    expect(await screen.findByText("book.read")).toBeInTheDocument();
    expect(screen.getByText(actorId)).toBeInTheDocument();
    expect(screen.getByText(`book · ${resourceId}`)).toBeInTheDocument();
    expect(screen.queryByText(/Không thể tải nhật ký/)).not.toBeInTheDocument();
    expect(screen.getByText("{}")).toBeInTheDocument();
  });
  it("displays real audit nullable actors and deduplicates pagination", async () => {
    const user = userEvent.setup();
    render(
      <AdminServicesProvider>
        <AdminAuditScreen />
      </AdminServicesProvider>,
    );
    await screen.findByText("book.read");
    expect(screen.getByText("Hệ thống")).toBeInTheDocument();
    expect(screen.getByText("{}")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tải thêm" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("cursor=page-2"),
        ),
      ).toBe(true),
    );
    expect(screen.getAllByText("book.read")).toHaveLength(1);
  });
  it("shows audit errors safely and retries", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      Response.json({ detail: "secret token" }, { status: 503 }),
    );
    render(
      <AdminServicesProvider>
        <AdminAuditScreen />
      </AdminServicesProvider>,
    );
    await screen.findByText(/Không thể tải nhật ký/);
    expect(screen.queryByText("secret token")).not.toBeInTheDocument();
    fetchMock.mockImplementation(async (url: string) => readyResponse(url));
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByText("book.read")).toBeInTheDocument();
  });
  it("shows actual empty audit rather than fallback events", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ items: [], next_cursor: null }),
    );
    render(
      <AdminServicesProvider>
        <AdminAuditScreen />
      </AdminServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Chưa có sự kiện phù hợp" }),
    ).toBeInTheDocument();
  });
  it("checks actual backend health and does not invent OCR health", async () => {
    render(
      <AdminServicesProvider>
        <AdminHealthScreen />
      </AdminServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Database" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Database đã phản hồi truy vấn đọc."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "OCR" }),
    ).not.toBeInTheDocument();
  });
  it("health error is safe and recheck recovers", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      Response.json({ detail: "secret sql" }, { status: 503 }),
    );
    render(
      <AdminServicesProvider>
        <AdminHealthScreen />
      </AdminServicesProvider>,
    );
    await screen.findByText(
      "Không thể lấy trạng thái an toàn. Vui lòng thử lại.",
    );
    fetchMock.mockImplementation(async (url: string) => readyResponse(url));
    await user.click(screen.getByRole("button", { name: "Kiểm tra lại" }));
    expect(
      await screen.findByRole("heading", { name: "Database" }),
    ).toBeInTheDocument();
  });
});
