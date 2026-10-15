import { render, screen, waitFor, within } from "@testing-library/react";
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
const newRevisionId = "55555555-5555-4555-8555-555555555555";
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
let pageRetired = false;
let manualDraftCreated = false;

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
      ...(manualDraftCreated
        ? [{
            page_revision_id: newRevisionId,
            revision_no: 3,
            verification_status: "NEEDS_REVIEW",
            created_at: timestamp,
            is_current_verified: false,
          }]
        : []),
      {
        page_revision_id: revisionId,
        revision_no: 2,
        verification_status: "VERIFIED",
        created_at: timestamp,
        is_current_verified: true,
      },
    ]);
  if (url.endsWith("/pages"))
    return Response.json([{
      book_id: bookId,
      page_number: 2,
      processing: { ...processing, lifecycle_status: pageRetired ? "RETIRED" : "ACTIVE" },
      text_preview: "Nội dung OCR hiển thị cho Admin",
    }]);
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
  pageRetired = false;
  manualDraftCreated = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const target = String(url);
    if (target.endsWith(`/admin/pages/${pageId}`) && options?.method === "DELETE") {
      pageRetired = true;
      return Response.json({
        page_id: pageId,
        book_id: bookId,
        page_number: 2,
        lifecycle_status: "RETIRED",
      });
    }
    if (target.endsWith("/revisions/draft") && options?.method === "POST") {
      manualDraftCreated = true;
      return Response.json({
        ...processing,
        page_revision_id: newRevisionId,
        revision_no: 3,
        verification_status: "NEEDS_REVIEW",
        draft_text: "Văn bản đã lưu thật",
        words: [],
        ocr_metadata: {},
        created_at: timestamp,
        verified_at: null,
        verified_by: null,
      }, { status: 201 });
    }
    return readyResponse(target);
  });
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
  it("renders retired admin books and links to the real create-book flow", async () => {
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
    expect(screen.getByRole("link", { name: "Tạo sách mới" })).toHaveAttribute(
      "href",
      "/admin/books/new",
    );
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
      screen.getByRole("button", { name: "Upload và chạy OCR" }),
    ).toBeEnabled();
    fetchMock.mockImplementation(async (url: string) => readyResponse(url));
    await user.click(screen.getByRole("button", { name: "Tải lại" }));
    expect(
      await screen.findByRole("heading", { name: "Trang 2" }),
    ).toBeInTheDocument();
  });
  it("previews OCR text and only retires a page after confirmation", async () => {
    const user = userEvent.setup();
    render(
      <AdminServicesProvider>
        <AdminBookDetailScreen bookId={bookId} />
      </AdminServicesProvider>,
    );
    expect(await screen.findByText("Nội dung OCR hiển thị cho Admin")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Xóa trang" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Xóa Trang 2?");
    await user.click(within(dialog).getByRole("button", { name: "Hủy" }));
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith(`/admin/pages/${pageId}`) && (init as RequestInit | undefined)?.method === "DELETE",
    )).toBe(false);

    await user.click(screen.getByRole("button", { name: "Xóa trang" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Xóa trang" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith(`/admin/pages/${pageId}`) && (init as RequestInit | undefined)?.method === "DELETE",
    )).toBe(true));
    expect(await screen.findByText("Trang đã ngừng sử dụng")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Xóa trang" })).not.toBeInTheDocument();
  });

  it("creates an editable revision from verified text without rerunning OCR", async () => {
    const user = userEvent.setup();
    render(
      <AdminServicesProvider>
        <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </AdminServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Kiểm tra OCR · R2" });
    expect(screen.getByLabelText("Nội dung trang")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Tạo bản nháp để sửa nội dung" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/revisions/draft") && (init as RequestInit | undefined)?.method === "POST",
    )).toBe(true));
    expect(await screen.findByLabelText("Nội dung trang")).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Kiểm tra OCR · R3" })).toBeInTheDocument();
    expect(await screen.findByText(/Đã tạo revision nháp từ nội dung đã xác minh/)).toBeInTheDocument();
  });

  it("shows true empty pages with the upload workflow available", async () => {
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
    expect(
      screen.getByRole("button", { name: "Upload và chạy OCR" }),
    ).toBeEnabled();
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
              : "Dữ liệu OCR chưa khả dụng",
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
  it("renders verified revision as read-only and allows a new OCR revision", async () => {
    render(
      <AdminServicesProvider>
        <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </AdminServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Kiểm tra OCR · R2" });
    expect(screen.getByLabelText("Nội dung trang")).toHaveValue(
      "Văn bản đã lưu thật",
    );
    expect(screen.getByLabelText("Nội dung trang")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Chạy lại OCR từ ảnh đã lưu" }),
    ).toBeEnabled();
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
