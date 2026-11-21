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
const pageId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";
const newRevisionId = "55555555-5555-4555-8555-555555555555";
const timestamp = "2026-10-08T00:00:00Z";
const book = {
  id: bookId,
  name: "Tên sách Admin từ database",
  title: "Sách Admin từ database",
  author: null,
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "RETIRED",
  next_page_number: 8,
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
let aiReviewDraftEnabled = false;
let aiCorrectionResult = "Xin chào";
let aiCorrectionUnavailable = false;
let aiSafetyFailed = false;
let aiSafetyFindings: Record<string, unknown>[] = [];
let latestAiWorkflow: Record<string, unknown> | null = null;

function aiWorkflowResponse(candidateText = aiCorrectionResult) {
  const candidateHash = "b".repeat(64);
  return {
    workflow_id: "66666666-6666-4666-8666-666666666666",
    page_id: pageId,
    book_id: bookId,
    page_revision_id: newRevisionId,
    status: "READY_FOR_ADMIN_REVIEW",
    stage: "READY_FOR_ADMIN_REVIEW",
    progress: { completed_chunks: 1, total_chunks: 1 },
    attempts: 1,
    error_code: null,
    original_ocr_hash: "a".repeat(64),
    admin_input_hash: "a".repeat(64),
    proofread_text: candidateText,
    proofread_output_hash: candidateHash,
    corrections: [],
    uncertain_word_indices: [],
    proofread_metadata: {
      run_id: "66666666-6666-4666-8666-666666666666",
      prompt_version: "test-proofread-v1",
      processing_time_ms: 1,
    },
    safety_metadata: { prompt_version: "test-safety-v1" },
    candidate_history: [],
    safety_history: [],
    review_history: [],
    candidate_text: candidateText,
    candidate_hash: candidateHash,
    candidate_version: 1,
    safety_input_hash: candidateHash,
    hash_match: true,
    suitability: "SUITABLE",
    safety_status: "PROVISIONAL",
    findings: aiSafetyFindings,
    provider_events: [],
    ocr_approved_at: null,
    final_approved_text_hash: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function readyResponse(url: string): Response {
  if (new URL(url, "http://localhost").pathname.endsWith("/image"))
    return Response.json({
      page_id: pageId,
      page_revision_id:
        new URL(url, "http://localhost").searchParams.get("revision_id") ??
        revisionId,
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
        ? [
            {
              page_revision_id: newRevisionId,
              revision_no: 3,
              verification_status: "NEEDS_REVIEW",
              created_at: timestamp,
              is_current_verified: false,
            },
          ]
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
    return Response.json([
      {
        book_id: bookId,
        page_number: 2,
        processing: {
          ...processing,
          lifecycle_status: pageRetired ? "RETIRED" : "ACTIVE",
        },
        text_preview: "Nội dung OCR hiển thị cho Admin",
      },
    ]);
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
  aiReviewDraftEnabled = false;
  aiCorrectionResult = "Xin chào";
  aiCorrectionUnavailable = false;
  aiSafetyFailed = false;
  aiSafetyFindings = [];
  latestAiWorkflow = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const target = String(url);
    if (
      target.endsWith(`/admin/pages/${pageId}`) &&
      options?.method === "DELETE"
    ) {
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
      return Response.json(
        {
          ...processing,
          page_revision_id: newRevisionId,
          revision_no: 3,
          verification_status: "NEEDS_REVIEW",
          draft_text: aiReviewDraftEnabled ? "Xin chao" : "Văn bản đã lưu thật",
          words: aiReviewDraftEnabled
            ? [
                {
                  word_index: 0,
                  line_index: 0,
                  text: "Xin",
                  normalized_text: "xin",
                  bbox: [0.1, 0.1, 0.2, 0.1],
                  ocr_confidence: 0.92,
                },
                {
                  word_index: 1,
                  line_index: 0,
                  text: "chao",
                  normalized_text: "chao",
                  bbox: [0.32, 0.1, 0.25, 0.1],
                  ocr_confidence: 0.62,
                },
              ]
            : [],
          ocr_metadata: {},
          created_at: timestamp,
          verified_at: null,
          verified_by: null,
        },
        { status: 201 },
      );
    }
    if (
      target.endsWith(`/books/admin/pages/${pageId}/ai-workflows`) &&
      options?.method === "POST"
    ) {
      if (aiCorrectionUnavailable)
        return Response.json(
          { detail: "AI workflow is not configured" },
          { status: 503 },
        );
      latestAiWorkflow = aiWorkflowResponse();
      if (aiSafetyFailed) {
        latestAiWorkflow = {
          ...latestAiWorkflow,
          status: "FAILED",
          stage: "CHILD_SAFETY_SCANNING",
          error_code: "INVALID_EVIDENCE",
          attempts: 3,
          safety_status: "FAILED",
          safety_input_hash: null,
          hash_match: false,
          suitability: null,
          findings: [],
          provider_events: [
            {
              provider: "gemini_primary",
              model: "gemini-test",
              stage: "CHILD_SAFETY_SCANNING",
              availability: false,
              http_status: 200,
              error_code: "INVALID_EVIDENCE",
              duration_ms: 12,
            },
          ],
        };
      }
      return Response.json(latestAiWorkflow);
    }
    if (target.endsWith("/ai-workflows/latest") && options?.method !== "POST") {
      if (latestAiWorkflow?.status === "QUEUED") {
        latestAiWorkflow = {
          ...latestAiWorkflow,
          status: "READY_FOR_ADMIN_REVIEW",
          stage: "READY_FOR_ADMIN_REVIEW",
          progress: { completed_chunks: 1, total_chunks: 1 },
          safety_input_hash: latestAiWorkflow.candidate_hash,
          hash_match: true,
          suitability: "SUITABLE",
          safety_status: "PROVISIONAL",
        };
      }
      return Response.json(latestAiWorkflow);
    }
    if (
      target.endsWith("/ai-workflows/66666666-6666-4666-8666-666666666666") &&
      options?.method !== "POST"
    ) {
      if (
        latestAiWorkflow?.status === "QUEUED" ||
        latestAiWorkflow?.stage === "CHILD_SAFETY_SCANNING"
      ) {
        latestAiWorkflow = {
          ...latestAiWorkflow,
          status: "READY_FOR_ADMIN_REVIEW",
          stage: "READY_FOR_ADMIN_REVIEW",
          progress: { completed_chunks: 1, total_chunks: 1 },
          safety_input_hash: latestAiWorkflow.candidate_hash,
          hash_match: true,
          suitability: "SUITABLE",
          safety_status: "PROVISIONAL",
        };
      }
      return Response.json(latestAiWorkflow);
    }
    if (
      target.endsWith(
        "/ai-workflows/66666666-6666-4666-8666-666666666666/candidate",
      ) &&
      options?.method === "PATCH"
    ) {
      const body = JSON.parse(String(options.body));
      const candidateText = String(body.candidate_text);
      const ready = aiWorkflowResponse(candidateText);
      const changed = candidateText !== aiCorrectionResult;
      latestAiWorkflow = changed
        ? {
            ...ready,
            status: "QUEUED",
            stage: "CHILD_SAFETY_SCANNING",
            progress: { completed_chunks: 0, total_chunks: 1 },
            candidate_version: 2,
            safety_input_hash: null,
            hash_match: false,
            suitability: null,
            safety_status: "STALE",
          }
        : ready;
      return Response.json(latestAiWorkflow);
    }
    if (
      target.endsWith(
        "/ai-workflows/66666666-6666-4666-8666-666666666666/safety-decision",
      ) &&
      options?.method === "POST"
    ) {
      const body = JSON.parse(String(options.body));
      latestAiWorkflow = {
        ...latestAiWorkflow,
        safety_status: body.confirmed ? "CONFIRMED" : "PROVISIONAL",
      };
      return Response.json(latestAiWorkflow);
    }
    if (target.includes("/verification-readiness")) {
      const wf = latestAiWorkflow as Record<string, unknown> | null;
      const safetyConfirmed =
        wf?.safety_status === "CONFIRMED" &&
        wf?.hash_match === true &&
        wf?.suitability !== "NOT_RECOMMENDED" &&
        !(
          Array.isArray(wf?.findings) &&
          (wf.findings as Record<string, unknown>[]).some(
            (f) => String(f.severity ?? "").toUpperCase() === "HIGH",
          )
        );
      const readyToVerify = Boolean(wf?.proofread_text && safetyConfirmed);
      const blockers = readyToVerify
        ? []
        : [
            {
              code: wf?.proofread_text
                ? "CHILD_SAFETY_CONFIRMATION_REQUIRED"
                : "PROOFREADING_REQUIRED",
              stage: wf?.proofread_text ? "CHILD_SAFETY" : "PROOFREADING",
              message: wf?.proofread_text
                ? "Cần Admin xác nhận kết quả An toàn cho trẻ."
                : "Cần chạy AI chỉnh sửa trước khi xác minh.",
            },
          ];
      return Response.json({
        page_id: pageId,
        page_revision_id:
          new URL(target, "http://localhost").searchParams.get("revision_id") ??
          newRevisionId,
        workflow_id: wf ? String(wf.workflow_id) : null,
        ready_to_verify: readyToVerify,
        blockers,
        proofreading_status: wf?.proofread_text ? "COMPLETED" : "NOT_STARTED",
        uncertain_word_count: 0,
        uncertain_resolved: true,
        child_safety_status: wf ? String(wf.safety_status) : "NOT_STARTED",
        child_safety_scope: "TEXT",
        child_safety_coverage_complete: Boolean(wf?.safety_input_hash),
        image_safety_status: "NOT_REVIEWED",
        image_safety_required: false,
        page_content_type: "CONTENT",
        rights_status: "REVIEWED",
        rights_scope: "BOOK",
        rights_profile_version: 1,
      });
    }
    if (target.includes("/rights-profile")) {
      return Response.json({
        id: "77777777-7777-4777-8777-777777777777",
        book_id: bookId,
        page_id: null,
        scope: "BOOK",
        status: "REVIEWED",
        source_name: "NXB Kiểm thử",
        rights_holder: "ViRead",
        usage_basis: "WRITTEN_LICENSE",
        evidence_url: null,
        evidence_reference: "HD-01",
        notes: "Đã rà soát.",
        source_fingerprint: "f".repeat(64),
        profile_version: 1,
        reference_check_status: "NO_MATCH_IN_ALLOWED_CORPUS",
        reference_check_evidence: [],
        reviewed_by: "11111111-1111-4111-8111-111111111111",
        reviewed_by_name: "Test Admin",
        reviewed_at: timestamp,
        history: [],
        updated_at: timestamp,
      });
    }
    if (
      target.endsWith(`/revisions/${newRevisionId}/draft`) &&
      options?.method === "PUT"
    ) {
      return Response.json({
        ...processing,
        page_revision_id: newRevisionId,
        revision_no: 3,
        verification_status: "NEEDS_REVIEW",
        draft_text: "Xin chao",
        words: [
          {
            word_index: 0,
            line_index: 0,
            text: "Xin",
            normalized_text: "xin",
            bbox: [0.1, 0.1, 0.2, 0.1],
            ocr_confidence: 0.92,
          },
          {
            word_index: 1,
            line_index: 0,
            text: "chao",
            normalized_text: "chao",
            bbox: [0.32, 0.1, 0.25, 0.1],
            ocr_confidence: 0.62,
          },
        ],
        ocr_metadata: {},
        created_at: timestamp,
        verified_at: null,
        verified_by: null,
      });
    }
    if (
      target.endsWith(`/admin/pages/${pageId}/verify`) &&
      options?.method === "POST"
    ) {
      return Response.json({
        ...processing,
        page_revision_id: newRevisionId,
        revision_no: 3,
        verification_status: "VERIFIED",
        draft_text: "Xin chào",
        words: [],
        ocr_metadata: {},
        created_at: timestamp,
        verified_by: "11111111-1111-4111-8111-111111111111",
      });
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
          book: { ...book, id: storedId, lifecycle_status: "ACTIVE" },
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
    expect(
      screen.getByText(/Chưa đủ điều kiện thư viện trẻ em · OCR \/ Safety/),
    ).toBeInTheDocument();
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
      screen.getByLabelText("Tìm theo tên sách, tiêu đề hoặc tác giả"),
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
    expect(
      await screen.findByText("Nội dung OCR hiển thị cho Admin"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Xóa trang" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Xóa Trang 2?");
    await user.click(within(dialog).getByRole("button", { name: "Hủy" }));
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith(`/admin/pages/${pageId}`) &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: "Xóa trang" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Xóa trang",
      }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith(`/admin/pages/${pageId}`) &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByText("Trang đã ngừng sử dụng"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Trang 2" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("heading", { name: "Sách chưa có trang" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Xóa trang" }),
    ).not.toBeInTheDocument();
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
    await user.click(
      screen.getByRole("button", { name: "Tạo bản nháp để sửa nội dung" }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith("/revisions/draft") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(await screen.findByLabelText("Nội dung trang")).toBeEnabled();
    expect(
      screen.getByRole("heading", { name: "Kiểm tra OCR · R3" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Đã tạo revision nháp từ nội dung đã xác minh/),
    ).toBeInTheDocument();
  });

  it.each([
    { accept: false, expectedText: "Xin chao", decision: "REJECTED" },
    { accept: true, expectedText: "Xin chào", decision: "ACCEPTED" },
  ])(
    "requires Admin to review combined AI suggestions before VERIFIED (accept=$accept)",
    async ({ accept, expectedText, decision }) => {
      aiReviewDraftEnabled = true;
      const user = userEvent.setup();
      render(
        <AdminServicesProvider>
          <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
        </AdminServicesProvider>,
      );
      await screen.findByRole("heading", { name: "Kiểm tra OCR · R2" });
      await user.click(
        screen.getByRole("button", { name: "Tạo bản nháp để sửa nội dung" }),
      );
      const textArea = await screen.findByLabelText("Nội dung trang");
      await waitFor(() => expect(textArea).toHaveValue("Xin chao"));

      await user.click(screen.getByRole("button", { name: /^AI chỉnh sửa$/ }));
      expect(await screen.findByText("Rà soát đề xuất AI")).toBeInTheDocument();
      expect(textArea).toHaveValue("Xin chao");
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith(`/admin/pages/${pageId}/verify`) &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(false);

      if (accept) {
        await user.click(
          screen.getByRole("checkbox", { name: "Duyệt đề xuất cho từ 2" }),
        );
      }
      await user.click(
        screen.getByRole("button", { name: /Xác nhận lựa chọn gợi ý/ }),
      );
      expect(screen.getByRole("button", { name: /^Xác minh$/ })).toBeDisabled();
      if (!accept) {
        await waitFor(() =>
          expect(
            fetchMock.mock.calls.some(
              ([url, init]) =>
                String(url).endsWith(
                  "/ai-workflows/66666666-6666-4666-8666-666666666666/candidate",
                ) && (init as RequestInit | undefined)?.method === "PATCH",
            ),
          ).toBe(true),
        );
      }
      await waitFor(
        () =>
          expect(
            screen.getByRole("button", { name: "Xác nhận kết quả Safety" }),
          ).toBeEnabled(),
        { timeout: 5000 },
      );
      await user.click(
        screen.getByRole("button", { name: "Xác nhận kết quả Safety" }),
      );
      await waitFor(
        () =>
          expect(
            screen.getByRole("button", { name: /^Xác minh$/ }),
          ).toBeEnabled(),
        { timeout: 5000 },
      );
      expect(textArea).toHaveValue(expectedText);
      await user.click(screen.getByRole("button", { name: /^Xác minh$/ }));
      await waitFor(() => {
        const verifyCall = fetchMock.mock.calls.find(
          ([url, init]) =>
            String(url).endsWith(`/admin/pages/${pageId}/verify`) &&
            (init as RequestInit | undefined)?.method === "POST",
        );
        expect(verifyCall).toBeDefined();
        const body = JSON.parse(String((verifyCall?.[1] as RequestInit).body));
        expect(body.corrected_text).toBe(expectedText);
        expect(body.proofread_audit.suggestions[0].decision).toBe(decision);
      });
    },
    15000,
  );

  it("shows compact Safety findings as collapsible cards and highlights HIGH", async () => {
    aiReviewDraftEnabled = true;
    aiSafetyFindings = [
      {
        finding_id: "finding-1",
        category: "SEXUAL_CONTENT",
        content_type: "DESCRIPTION",
        severity: "HIGH",
        evidence_text: "mô tả hành vi xâm hại tình dục trực diện",
        evidence_start: 12,
        evidence_end: 54,
        explanation:
          "Nội dung mô tả xâm hại tình dục trực diện, không phù hợp với học sinh lớp 1–5.",
        recommendation: "Không phê duyệt sách cho thư viện trẻ em.",
      },
    ];
    const user = userEvent.setup();
    render(
      <AdminServicesProvider>
        <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </AdminServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Kiểm tra OCR · R2" });
    await user.click(
      screen.getByRole("button", { name: "Tạo bản nháp để sửa nội dung" }),
    );
    await screen.findByLabelText("Nội dung trang");
    await user.click(screen.getByRole("button", { name: /^AI chỉnh sửa$/ }));

    expect(await screen.findByText("SEXUAL CONTENT")).toBeInTheDocument();
    expect(screen.getByText("HIGH", { exact: true })).toHaveClass("bg-red-700");
    expect(
      screen.getByText("Mở chi tiết").closest("details"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Nội dung mô tả xâm hại tình dục trực diện, không phù hợp với học sinh lớp 1–5.",
      ),
    ).not.toBeVisible();
    await user.click(screen.getByText("Mở chi tiết"));
    expect(
      await screen.findByText(
        "Nội dung mô tả xâm hại tình dục trực diện, không phù hợp với học sinh lớp 1–5.",
      ),
    ).toBeInTheDocument();
    const safetyReason = screen.getByLabelText(
      /Lý do Admin xem xét Safety · bắt buộc/,
    );
    const safetyConfirm = screen.getByRole("button", {
      name: "Xác nhận kết quả Safety",
    });
    expect(safetyConfirm).toBeDisabled();
    await user.type(
      safetyReason,
      "Admin đã xem ngữ cảnh và giữ trạng thái chặn.",
    );
    expect(safetyConfirm).toBeEnabled();
    await user.click(safetyConfirm);
    await waitFor(() => {
      const decisionCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/safety-decision"),
      );
      expect(decisionCall).toBeDefined();
      expect(
        JSON.parse(String((decisionCall?.[1] as RequestInit).body)).reason,
      ).toBe("Admin đã xem ngữ cảnh và giữ trạng thái chặn.");
    });
    expect(screen.getByRole("button", { name: /^Xác minh$/ })).toBeDisabled();
  }, 15000);

  it("reports a clean AI check but still waits for final Admin confirmation", async () => {
    aiReviewDraftEnabled = true;
    aiCorrectionResult = "Xin chao";
    const user = userEvent.setup();
    render(
      <AdminServicesProvider>
        <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </AdminServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Kiểm tra OCR · R2" });
    await user.click(
      screen.getByRole("button", { name: "Tạo bản nháp để sửa nội dung" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Nội dung trang")).toHaveValue("Xin chao"),
    );
    await user.click(screen.getByRole("button", { name: /^AI chỉnh sửa$/ }));
    expect(
      await screen.findByText(/AI chưa phát hiện lỗi chính tả cần chỉnh sửa/),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith(`/admin/pages/${pageId}/verify`) &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Xác nhận kết quả Safety" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Xác minh$/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /^Xác minh$/ }));
    await waitFor(() => {
      const verifyCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith(`/admin/pages/${pageId}/verify`) &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(verifyCall).toBeDefined();
      const body = JSON.parse(String((verifyCall?.[1] as RequestInit).body));
      expect(body.proofread_audit).toMatchObject({
        mode: "AI_CHECKED",
        suggestions: [],
      });
    });
  });

  it("explains Child Safety INVALID_EVIDENCE and keeps final approval disabled", async () => {
    aiReviewDraftEnabled = true;
    aiSafetyFailed = true;
    const user = userEvent.setup();
    render(
      <AdminServicesProvider>
        <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </AdminServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Kiểm tra OCR · R2" });
    await user.click(
      screen.getByRole("button", { name: "Tạo bản nháp để sửa nội dung" }),
    );
    await screen.findByLabelText("Nội dung trang");
    await user.click(screen.getByRole("button", { name: /^AI chỉnh sửa$/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "AI trả về evidence không thể đối chiếu chính xác với Candidate",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("INVALID_EVIDENCE");
    expect(screen.getByRole("alert")).toHaveTextContent("gemini_primary");
    expect(
      screen.getByRole("button", { name: "Thử lại Child Safety" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Xác minh$/ })).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith(`/admin/pages/${pageId}/verify`) &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  it("blocks manual verification bypass when AI is unavailable while still letting Admin save draft", async () => {
    aiReviewDraftEnabled = true;
    aiCorrectionUnavailable = true;
    const user = userEvent.setup();
    render(
      <AdminServicesProvider>
        <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </AdminServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Kiểm tra OCR · R2" });
    await user.click(
      screen.getByRole("button", { name: "Tạo bản nháp để sửa nội dung" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Nội dung trang")).toHaveValue("Xin chao"),
    );
    await user.click(screen.getByRole("button", { name: /^AI chỉnh sửa$/ }));
    expect(
      await screen.findByText(/Không thể chạy AI chỉnh sửa/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Tiếp tục xác minh thủ công" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Xác minh$/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Lưu bản nháp/ }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith(`/revisions/${newRevisionId}/draft`) &&
            (init as RequestInit | undefined)?.method === "PUT",
        ),
      ).toBe(true),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith(`/admin/pages/${pageId}/verify`) &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
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
      fetchMock.mock.calls.some(([url]) =>
        new URL(String(url), "http://localhost").pathname.endsWith("/image"),
      ),
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
    expect(
      screen.getByText(new RegExp(`book · ${resourceId}`)),
    ).toBeInTheDocument();
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
  it("shows independent OCR and worker states", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/system/admin/health")
        ? Response.json({
            overall_status: "DEGRADED",
            checked_at: timestamp,
            services: [
              {
                id: "vietocr",
                label: "VietOCR",
                status: "DEGRADED",
                checked_at: timestamp,
                safe_message: "Đã cài, chưa nạp.",
                detail_status: "installed",
              },
              {
                id: "tesseract_vie",
                label: "Tesseract tiếng Việt",
                status: "UNAVAILABLE",
                checked_at: timestamp,
                safe_message: "Thiếu dữ liệu nhận diện tiếng Việt (vie).",
                detail_status: "failed",
              },
              {
                id: "storage",
                label: "Supabase Storage",
                status: "HEALTHY",
                checked_at: timestamp,
                safe_message:
                  "Storage phản hồi kiểm tra bucket (không đọc file).",
                detail_status: "healthy",
              },
              {
                id: "book_quality",
                label: "Book quality worker",
                status: "DEGRADED",
                checked_at: timestamp,
                safe_message: "Worker không được khởi chạy.",
                detail_status: "disabled",
              },
            ],
          })
        : readyResponse(url),
    );
    render(
      <AdminServicesProvider>
        <AdminHealthScreen />
      </AdminServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "VietOCR" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Tesseract tiếng Việt" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Trạng thái kỹ thuật: Đã cài")).toBeInTheDocument();
    expect(
      screen.getByText("Trạng thái kỹ thuật: Chưa chạy"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Thiếu dữ liệu nhận diện tiếng Việt (vie)."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Storage phản hồi kiểm tra bucket (không đọc file)."),
    ).toBeInTheDocument();
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

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  };
});
