import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { AdminPageUploader } from "@/components/admin/admin-page-uploader";
import { createAdminPageService } from "@/lib/api/admin-page-service";

vi.mock("@/lib/supabase/admin-auth-service", () => ({
  createSupabaseAdminAuthService: () => ({}),
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
const pageId1 = "33333333-3333-4333-8333-333333333333";
const pageId2 = "44444444-4444-4444-8444-444444444444";
const revId1 = "55555555-5555-4555-8555-555555555555";
const revId2 = "66666666-6666-4666-8666-666666666666";
const timestamp = "2026-10-08T00:00:00Z";

function makeRevisionDetail(pageId: string, revisionId: string, text: string) {
  return {
    page_id: pageId,
    page_revision_id: revisionId,
    revision_no: 1,
    verification_status: "NEEDS_REVIEW",
    lifecycle_status: "ACTIVE",
    draft_text: text,
    words: [],
    ocr_metadata: {},
    created_at: timestamp,
    verified_at: null,
    verified_by: null,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 800, height: 1000, close: vi.fn() })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Admin multi-format document upload service and UI", () => {
  it("routes PNG through /pages and PDF/DOCX/TIFF/BMP through /documents with Zod validation", async () => {
    const png = new File(["png"], "page-1.png", { type: "image/png" });
    const pdf = new File(["%PDF-1.4"], "story.pdf", {
      type: "application/pdf",
    });
    const docx = new File(["PK\x03\x04"], "lesson.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    fetchMock
      .mockResolvedValueOnce(
        Response.json(makeRevisionDetail(pageId1, revId1, "Trang ảnh")),
      )
      .mockResolvedValueOnce(
        Response.json({
          book_id: bookId,
          file_name: "story.pdf",
          source_format: "PDF",
          total_source_pages: 3,
          created_pages_count: 2,
          skipped_empty_count: 1,
          failed_pages_count: 0,
          pages: [
            {
              source_page: 1,
              status: "SUCCEEDED",
              page_id: pageId1,
              page_number: 2,
              revision: makeRevisionDetail(pageId1, revId1, "Trang 1"),
              error_code: null,
              error_message: null,
            },
            {
              source_page: 2,
              status: "SKIPPED_EMPTY",
              page_id: null,
              page_number: null,
              revision: null,
              error_code: "EMPTY_PAGE",
              error_message: "Trang trắng",
            },
            {
              source_page: 3,
              status: "SUCCEEDED",
              page_id: pageId2,
              page_number: 3,
              revision: makeRevisionDetail(pageId2, revId2, "Trang 3"),
              error_code: null,
              error_message: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          book_id: bookId,
          file_name: "lesson.docx",
          source_format: "DOCX",
          total_source_pages: 1,
          created_pages_count: 1,
          skipped_empty_count: 0,
          failed_pages_count: 0,
          pages: [
            {
              source_page: 1,
              status: "SUCCEEDED",
              page_id: pageId2,
              page_number: 4,
              revision: makeRevisionDetail(pageId2, revId2, "Word"),
              error_code: null,
              error_message: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json([]));

    const progressUpdates: Array<{
      client_id: string;
      status: string;
      summary_message?: string;
    }> = [];
    await createAdminPageService().upload(
      bookId,
      [
        {
          client_id: "0-page-1.png",
          file_name: png.name,
          mime_type: "image/png",
          size_bytes: png.size,
          upload_kind: "image",
          file: png,
        },
        {
          client_id: "1-story.pdf",
          file_name: pdf.name,
          mime_type: "application/pdf",
          size_bytes: pdf.size,
          upload_kind: "document",
          file: pdf,
        },
        {
          client_id: "2-lesson.docx",
          file_name: docx.name,
          mime_type:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size_bytes: docx.size,
          upload_kind: "document",
          file: docx,
        },
      ],
      (p) => progressUpdates.push(p),
    );

    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe(
      `/books/admin/catalog/${bookId}/pages`,
    );
    expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toBe(
      `/books/admin/catalog/${bookId}/documents`,
    );
    expect(new URL(String(fetchMock.mock.calls[2][0])).pathname).toBe(
      `/books/admin/catalog/${bookId}/documents`,
    );
    expect(
      ((fetchMock.mock.calls[1][1] as RequestInit).body as FormData).get(
        "document",
      ),
    ).toBeInstanceOf(File);

    const pdfDone = progressUpdates.find(
      (item) =>
        item.client_id === "1-story.pdf" && item.status === "PROCESSING",
    );
    expect(pdfDone?.summary_message).toBe(
      "Đã tạo 2 trang · Cần duyệt (bỏ qua 1 trang trắng)",
    );
  });

  it("maps the 30-page limit backend error to a safe Vietnamese message", async () => {
    const pdf = new File(["%PDF-1.4"], "huge.pdf", { type: "application/pdf" });
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          { detail: "Document exceeds the 30-page limit per upload" },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(Response.json([]));

    const updates: Array<{ status: string; error_message?: string }> = [];
    await createAdminPageService().upload(
      bookId,
      [
        {
          client_id: "0-huge.pdf",
          file_name: pdf.name,
          mime_type: "application/pdf",
          size_bytes: pdf.size,
          upload_kind: "document",
          file: pdf,
        },
      ],
      (p) => updates.push(p),
    );

    const failed = updates.find((item) => item.status === "FAILED");
    expect(failed?.error_message).toContain("tối đa 30 trang");
  });

  it("uploads mixed PNG + PDF + DOCX from AdminPageUploader, blocks .docm, and retries failures", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const onUploaded = vi.fn();
    let failDocxOnce = true;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/pages") && init?.method === "POST") {
        return Response.json(makeRevisionDetail(pageId1, revId1, "Trang ảnh"));
      }
      if (target.endsWith("/documents") && init?.method === "POST") {
        const body = init.body as FormData;
        const uploaded = body.get("document") as File;
        if (uploaded.name === "lesson.docx" && failDocxOnce) {
          failDocxOnce = false;
          return Response.json(
            { detail: "No usable text was detected in the uploaded document" },
            { status: 422 },
          );
        }
        return Response.json({
          book_id: bookId,
          file_name: uploaded.name,
          source_format: uploaded.name.endsWith(".pdf") ? "PDF" : "DOCX",
          total_source_pages: 2,
          created_pages_count: 2,
          skipped_empty_count: 0,
          failed_pages_count: 0,
          pages: [
            {
              source_page: 1,
              status: "SUCCEEDED",
              page_id: pageId1,
              page_number: 1,
              revision: makeRevisionDetail(pageId1, revId1, "Trang 1"),
              error_code: null,
              error_message: null,
            },
            {
              source_page: 2,
              status: "SUCCEEDED",
              page_id: pageId2,
              page_number: 2,
              revision: makeRevisionDetail(pageId2, revId2, "Trang 2"),
              error_code: null,
              error_message: null,
            },
          ],
        });
      }
      if (target.endsWith("/pages")) {
        return Response.json([]);
      }
      throw new Error(`Unexpected URL ${target}`);
    });

    render(
      <AdminServicesProvider>
        <AdminPageUploader bookId={bookId} onUploaded={onUploaded} />
      </AdminServicesProvider>,
    );

    const input = screen.getByLabelText(/Chọn một hoặc nhiều ảnh trang sách/);
    const png = new File(["png"], "cover.png", { type: "image/png" });
    const pdf = new File(["%PDF-1.4"], "story.pdf", {
      type: "application/pdf",
    });
    const docxWithEmptyMime = new File(["PK\x03\x04"], "lesson.docx", {
      type: "",
    });
    const macroDoc = new File(["PK\x03\x04"], "unsafe.docm", { type: "" });

    await user.upload(input, [png, pdf, docxWithEmptyMime, macroDoc]);
    await user.click(
      screen.getByRole("button", { name: "Upload và chạy OCR" }),
    );

    expect(
      await screen.findByText(/Một số tệp không hợp lệ nên chưa được upload/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Không cho phép tệp Word chứa macro (.docm)."),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getAllByText("Đã tạo 2 trang · Cần duyệt")).toHaveLength(1),
    );
    expect(
      await screen.findByText(
        /Không phát hiện được chữ trong tài liệu tải lên/,
      ),
    ).toBeInTheDocument();

    const retryButton = await screen.findByRole("button", {
      name: "Thử lại các file thất bại",
    });
    await user.click(retryButton);

    await waitFor(() =>
      expect(screen.getAllByText("Đã tạo 2 trang · Cần duyệt")).toHaveLength(2),
    );
    expect(onUploaded).toHaveBeenCalled();
  });

  it("preserves in-flight document upload progress across unmount/remount in the same tab", async () => {
    const user = userEvent.setup();
    const sessionBookId = "77777777-7777-4777-8777-777777777777";
    let resolveUpload: ((value: Response) => void) | undefined;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/documents") && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      }
      if (target.endsWith("/pages")) {
        return Response.json([]);
      }
      throw new Error(`Unexpected URL ${target}`);
    });

    const firstMount = render(
      <AdminServicesProvider>
        <AdminPageUploader bookId={sessionBookId} onUploaded={vi.fn()} />
      </AdminServicesProvider>,
    );

    const input = screen.getByLabelText(/Chọn một hoặc nhiều ảnh trang sách/);
    const pdf = new File(["%PDF-1.4"], "in-flight.pdf", {
      type: "application/pdf",
    });
    await user.upload(input, [pdf]);
    await user.click(
      screen.getByRole("button", { name: "Upload và chạy OCR" }),
    );

    expect(await screen.findByText("Đang tải lên")).toBeInTheDocument();
    firstMount.unmount();

    resolveUpload?.(
      Response.json({
        book_id: sessionBookId,
        file_name: "in-flight.pdf",
        source_format: "PDF",
        total_source_pages: 4,
        created_pages_count: 3,
        skipped_empty_count: 1,
        failed_pages_count: 0,
        pages: [
          {
            source_page: 1,
            status: "SUCCEEDED",
            page_id: pageId1,
            page_number: 1,
            revision: makeRevisionDetail(pageId1, revId1, "Trang 1"),
            error_code: null,
            error_message: null,
          },
          {
            source_page: 2,
            status: "SKIPPED_EMPTY",
            page_id: null,
            page_number: null,
            revision: null,
            error_code: "EMPTY_PAGE",
            error_message: "Trang trắng",
          },
          {
            source_page: 3,
            status: "SUCCEEDED",
            page_id: pageId2,
            page_number: 2,
            revision: makeRevisionDetail(pageId2, revId2, "Trang 3"),
            error_code: null,
            error_message: null,
          },
          {
            source_page: 4,
            status: "SUCCEEDED",
            page_id: pageId2,
            page_number: 3,
            revision: makeRevisionDetail(pageId2, revId2, "Trang 4"),
            error_code: null,
            error_message: null,
          },
        ],
      }),
    );

    const onUploadedAfterRemount = vi.fn();
    render(
      <AdminServicesProvider>
        <AdminPageUploader
          bookId={sessionBookId}
          onUploaded={onUploadedAfterRemount}
        />
      </AdminServicesProvider>,
    );

    expect(
      await screen.findByText(
        "Đã tạo 3 trang · Cần duyệt (bỏ qua 1 trang trắng)",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("in-flight.pdf")).toBeInTheDocument();
  });

  it("formats partial skipped/failed summaries, rejects >30 page Zod payload, and maps security errors", async () => {
    const tiff = new File(["II*\x00"], "scan.tiff", {
      type: "application/octet-stream",
    });
    const bmp = new File(["BM"], "photo.bmp", { type: "" });
    const lockedPdf = new File(["%PDF-1.4"], "locked.pdf", {
      type: "application/pdf",
    });

    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          book_id: bookId,
          file_name: "scan.tiff",
          source_format: "TIFF",
          total_source_pages: 4,
          created_pages_count: 2,
          skipped_empty_count: 1,
          failed_pages_count: 1,
          pages: [
            {
              source_page: 1,
              status: "SUCCEEDED",
              page_id: pageId1,
              page_number: 1,
              revision: makeRevisionDetail(pageId1, revId1, "Trang 1"),
              error_code: null,
              error_message: null,
            },
            {
              source_page: 2,
              status: "SKIPPED_EMPTY",
              page_id: null,
              page_number: null,
              revision: null,
              error_code: "EMPTY_PAGE",
              error_message: "Trang trắng",
            },
            {
              source_page: 3,
              status: "FAILED",
              page_id: null,
              page_number: null,
              revision: null,
              error_code: "HTTP_422",
              error_message: "Lỗi OCR trang 3",
            },
            {
              source_page: 4,
              status: "SUCCEEDED",
              page_id: pageId2,
              page_number: 2,
              revision: makeRevisionDetail(pageId2, revId2, "Trang 4"),
              error_code: null,
              error_message: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          book_id: bookId,
          file_name: "photo.bmp",
          source_format: "BMP",
          total_source_pages: 31,
          created_pages_count: 31,
          skipped_empty_count: 0,
          failed_pages_count: 0,
          pages: [],
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { detail: "Password-protected PDF files are not supported" },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(Response.json([]));

    const updates: Array<{
      client_id: string;
      status: string;
      summary_message?: string;
      error_message?: string;
    }> = [];

    await createAdminPageService().upload(
      bookId,
      [
        {
          client_id: "0-scan.tiff",
          file_name: tiff.name,
          mime_type: "image/tiff",
          size_bytes: tiff.size,
          upload_kind: "document",
          file: tiff,
        },
        {
          client_id: "1-photo.bmp",
          file_name: bmp.name,
          mime_type: "image/bmp",
          size_bytes: bmp.size,
          upload_kind: "document",
          file: bmp,
        },
        {
          client_id: "2-locked.pdf",
          file_name: lockedPdf.name,
          mime_type: "application/pdf",
          size_bytes: lockedPdf.size,
          upload_kind: "document",
          file: lockedPdf,
        },
      ],
      (p) => updates.push(p),
    );

    expect(
      updates.find(
        (u) => u.client_id === "0-scan.tiff" && u.status === "PROCESSING",
      )?.summary_message,
    ).toBe("Đã tạo 2 trang · Cần duyệt (bỏ qua 1 trang trắng, lỗi 1 trang)");

    // total_source_pages: 31 rejected by Zod schema (> 30)
    expect(
      updates.find(
        (u) => u.client_id === "1-photo.bmp" && u.status === "FAILED",
      ),
    ).toBeDefined();

    // Password-protected PDF mapped safely to Vietnamese
    expect(
      updates.find(
        (u) => u.client_id === "2-locked.pdf" && u.status === "FAILED",
      )?.error_message,
    ).toContain("mật khẩu");
  });

  it("classifies .tiff (application/octet-stream) and .bmp (empty MIME) in AdminPageUploader", async () => {
    const user = userEvent.setup();
    const multiBookId = "88888888-8888-4888-8888-888888888888";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/documents") && init?.method === "POST") {
        const uploaded = (init.body as FormData).get("document") as File;
        return Response.json({
          book_id: multiBookId,
          file_name: uploaded.name,
          source_format: uploaded.name.endsWith(".bmp") ? "BMP" : "TIFF",
          total_source_pages: 1,
          created_pages_count: 1,
          skipped_empty_count: 0,
          failed_pages_count: 0,
          pages: [
            {
              source_page: 1,
              status: "SUCCEEDED",
              page_id: pageId1,
              page_number: 1,
              revision: makeRevisionDetail(pageId1, revId1, "Trang 1"),
              error_code: null,
              error_message: null,
            },
          ],
        });
      }
      if (target.endsWith("/pages")) {
        return Response.json([]);
      }
      throw new Error(`Unexpected URL ${target}`);
    });

    render(
      <AdminServicesProvider>
        <AdminPageUploader bookId={multiBookId} onUploaded={vi.fn()} />
      </AdminServicesProvider>,
    );

    const input = screen.getByLabelText(/Chọn một hoặc nhiều ảnh trang sách/);
    const tiff = new File(["II*\x00"], "scan.tiff", {
      type: "application/octet-stream",
    });
    const bmp = new File(["BM"], "photo.bmp", { type: "" });
    await user.upload(input, [tiff, bmp]);
    await user.click(
      screen.getByRole("button", { name: "Upload và chạy OCR" }),
    );

    await waitFor(() =>
      expect(screen.getAllByText("Đã tạo 1 trang · Cần duyệt")).toHaveLength(2),
    );
  });
});
