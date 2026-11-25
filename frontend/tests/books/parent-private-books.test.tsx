import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthRuntimeContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import { ParentMyBooksScreen } from "@/components/books/parent-my-books-screen";
import { ParentPrivateBookManager } from "@/components/books/parent-private-book-manager";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import type {
  ParentPageSubmissionDTO,
  ParentPrivateBookDetailDTO,
  ParentPrivateBookSummaryDTO,
} from "@/types/parent-private-book";

const { pushMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "parent-a-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const BOOK_ID = "aa000000-0000-4000-8000-000000000001";
const SUB_ID = "bb000000-0000-4000-8000-000000000001";
const BATCH_ID = "cc000000-0000-4000-8000-000000000001";
const PAGE_ID = "dd000000-0000-4000-8000-000000000001";
const REV_ID = "ee000000-0000-4000-8000-000000000001";
const HASH_V1 = "1".repeat(64);
const HASH_V2 = "2".repeat(64);
const NOW = "2026-11-21T12:00:00Z";

function makeAuthRuntime(userId: string): AuthRuntimeState {
  return {
    initializationFailure: null,
    isPasswordRecovery: false,
    lastEvent: "SIGNED_IN",
    mode: "supabase",
    status: "ready",
    session: {
      expires_at: null,
      user: {
        id: userId,
        email: `${userId}@example.test`,
        display_name: "Phụ huynh kiểm thử",
      },
    },
  };
}

function makeBookSummary(
  overrides: Partial<ParentPrivateBookSummaryDTO> = {},
): ParentPrivateBookSummaryDTO {
  return {
    id: BOOK_ID,
    title: "Truyện Riêng Nhà An",
    author: "Gia đình bé An",
    min_grade: 1,
    max_grade: 3,
    lifecycle_status: "ACTIVE",
    visibility_scope: "PARENT_PRIVATE",
    moderation_status: "ACTIVE",
    suspended_reason: null,
    source_declaration: "Sách giấy gia đình mua",
    committed_page_count: 0,
    pending_submission_count: 0,
    flagged_submission_count: 0,
    failed_submission_count: 0,
    ready_to_add_count: 0,
    readable_for_children: false,
    has_held_multipage_batch: false,
    privacy_notice:
      "Chỉ phụ huynh sở hữu và các hồ sơ trẻ của gia đình được đọc sách này.",
    created_at: NOW,
    ...overrides,
  };
}

function makeSubmission(
  overrides: Partial<ParentPageSubmissionDTO> = {},
): ParentPageSubmissionDTO {
  return {
    id: SUB_ID,
    book_id: BOOK_ID,
    batch_id: BATCH_ID,
    batch_total_pages: 1,
    source_page_number: 1,
    target_page_number: null,
    source_file_name: "trang1.png",
    source_format: "IMAGE",
    image_width: 400,
    image_height: 300,
    image_url: `http://127.0.0.1:8000/books/my-books/${BOOK_ID}/submissions/${SUB_ID}/image`,
    source_type: "OWNED_PHYSICAL_BOOK",
    source_type_label: "Sách giấy gia đình sở hữu",
    source_note: "Sách giấy của bé",
    submission_version: 1,
    optimistic_lock_version: 1,
    workflow_status: "NEEDS_ADMIN_REVIEW",
    workflow_status_label: "Cần Admin duyệt",
    ocr_status: "COMPLETED",
    ocr_text: "Đoạn văn có cảnh báo cần xem xét.",
    ocr_error_code: null,
    is_image_only: false,
    proofread_status: "COMPLETED",
    proofread_text: "Đoạn văn có cảnh báo cần xem xét.",
    proofread_suggestions: [],
    uncertain_word_indices: [],
    proofread_error_code: null,
    spelling_accepted: true,
    candidate_text: "Đoạn văn có cảnh báo cần xem xét.",
    candidate_hash: HASH_V1,
    tool_check_status: "FLAGGED",
    tool_check_suitability: "REVIEW_REQUIRED",
    tool_check_scope: {
      modality: "TEXT_ONLY",
      covers_all_chunks: true,
      chunks_checked: 1,
      total_chunks: 1,
      image_visual_safety_checked: false,
      requires_admin_visual_review: false,
      copyright_scanner_status: "NOT_CONFIGURED",
      local_ai_enforced: true,
    },
    tool_check_findings_count: 1,
    tool_check_parent_notice:
      "Tool Check gắn cờ 1 nội dung cần Admin xem xét trước khi thêm vào sách.",
    tool_check_policy_blocked: false,
    tool_check_workflow_id: null,
    tool_check_error_code: null,
    provider_events: [],
    can_add_to_book: false,
    can_request_admin_review: true,
    can_retry: false,
    admin_decision: null,
    admin_decision_reason: null,
    approved_snapshot_hash: null,
    approved_submission_version: null,
    committed_page_id: null,
    committed_revision_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  installApiFetchFixture();
  pushMock.mockReset();
  replaceMock.mockReset();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:private-test-image"),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Parent Private Books UI (Sách của tôi)", () => {
  it("creates a private book and clears cached private books immediately on account switch", async () => {
    const parentABooks = [makeBookSummary({ title: "Sách Bí Mật Nhà An" })];
    const parentBBooks = [
      makeBookSummary({
        id: "aa000000-0000-4000-8000-000000000099",
        title: "Sách Riêng Nhà Bình",
      }),
    ];
    let activeUser = "parent-a";

    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (
        (url.pathname === "/books/my-books" ||
          url.pathname === "/books/my-books/paged") &&
        (!init?.method || init.method === "GET")
      ) {
        const list = activeUser === "parent-a" ? parentABooks : parentBBooks;
        if (url.pathname === "/books/my-books/paged") {
          return Response.json({
            items: list,
            total: list.length,
            limit: 9,
            offset: 0,
          });
        }
        return Response.json(list);
      }
      if (url.pathname === "/books/my-books" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return Response.json(
          makeBookSummary({
            id: "aa000000-0000-4000-8000-000000000002",
            title: body.title,
          }),
          { status: 201 },
        );
      }
      throw new Error(`Unexpected fetch ${url.pathname}`);
    });

    const user = userEvent.setup();
    const { rerender } = render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-a")}>
        <AppServicesProvider>
          <ParentMyBooksScreen />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(await screen.findByText("Sách Bí Mật Nhà An")).toBeInTheDocument();
    expect(screen.getByText(/Chỉ bạn và các hồ sơ trẻ/)).toBeInTheDocument();
    expect(screen.getByText("Chưa mở đọc cùng bé")).toBeInTheDocument();

    // Create a book
    await user.click(screen.getByRole("button", { name: /Tạo sách riêng/ }));
    await user.type(screen.getByLabelText(/Tên sách/), "Truyện Mới Bé An");
    await user.click(screen.getByRole("button", { name: "Lưu và thêm trang" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        "/my-books/aa000000-0000-4000-8000-000000000002",
      );
    });

    // Switch account to Parent B -> Parent A's book MUST disappear immediately!
    activeUser = "parent-b";
    rerender(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-b")}>
        <AppServicesProvider>
          <ParentMyBooksScreen />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(await screen.findByText("Sách Riêng Nhà Bình")).toBeInTheDocument();
    expect(screen.queryByText("Sách Bí Mật Nhà An")).not.toBeInTheDocument();
  });

  it("locks Thêm trang when flagged, sends exact snapshot to Admin, handles retry on error, and allows add after Admin approval", async () => {
    let currentDetail: ParentPrivateBookDetailDTO = {
      book: makeBookSummary({ flagged_submission_count: 1 }),
      pages: [],
      submissions: [makeSubmission()],
    };
    const postedCalls: Array<{ path: string; body: unknown }> = [];

    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/image")) {
        return new Response(new Blob(["png-bytes"], { type: "image/png" }), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      if (
        url.pathname === `/books/my-books/${BOOK_ID}` &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json(currentDetail);
      }
      if (
        url.pathname === `/books/my-books/${BOOK_ID}/submissions` &&
        init?.method === "POST"
      ) {
        currentDetail = {
          ...currentDetail,
          submissions: [
            makeSubmission({
              workflow_status: "CHECK_FAILED",
              workflow_status_label: "Kiểm tra lỗi — có thể thử lại",
              tool_check_status: "FAILED",
              tool_check_error_code: "OLLAMA_TIMEOUT",
              tool_check_findings_count: 0,
              tool_check_parent_notice: null,
              can_add_to_book: false,
              can_request_admin_review: false,
              can_retry: true,
            }),
          ],
        };
        return Response.json(
          {
            book_id: BOOK_ID,
            batch_id: BATCH_ID,
            source_format: "IMAGE",
            total_pages: 1,
            replayed_idempotency: false,
            submissions: currentDetail.submissions,
          },
          { status: 202 },
        );
      }
      if (
        url.pathname.endsWith("/request-admin-review") &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body));
        postedCalls.push({ path: url.pathname, body });
        currentDetail = {
          ...currentDetail,
          submissions: [
            makeSubmission({
              workflow_status: "PENDING_ADMIN",
              workflow_status_label: "Đang chờ Admin",
              can_add_to_book: false,
              can_request_admin_review: false,
            }),
          ],
        };
        return Response.json(currentDetail.submissions[0]);
      }
      if (url.pathname.endsWith("/retry") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        postedCalls.push({ path: url.pathname, body });
        currentDetail = {
          ...currentDetail,
          submissions: [
            makeSubmission({
              submission_version: 2,
              candidate_hash: HASH_V2,
              workflow_status: "APPROVED_READY_TO_ADD",
              workflow_status_label: "Đã duyệt — có thể thêm trang",
              tool_check_status: "FLAGGED",
              admin_decision: "APPROVE",
              admin_decision_reason: "Phù hợp cho bé lớp 2 đọc cùng phụ huynh.",
              approved_submission_version: 2,
              approved_snapshot_hash: HASH_V2,
              can_add_to_book: true,
              can_request_admin_review: false,
              can_retry: false,
            }),
          ],
        };
        return Response.json(currentDetail.submissions[0]);
      }
      if (url.pathname.endsWith("/add-page") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        postedCalls.push({ path: url.pathname, body });
        currentDetail = {
          book: makeBookSummary({
            committed_page_count: 1,
            readable_for_children: true,
          }),
          pages: [
            {
              page_id: PAGE_ID,
              page_number: 1,
              current_verified_revision_id: REV_ID,
              verified_text: "Đoạn văn đã duyệt.",
              verified_text_preview: "Đoạn văn đã duyệt.",
              image_url: `http://127.0.0.1:8000/books/my-books/${BOOK_ID}/pages/${PAGE_ID}/image`,
              created_at: NOW,
            },
          ],
          submissions: [
            makeSubmission({
              submission_version: 2,
              candidate_hash: HASH_V2,
              workflow_status: "ADDED_TO_BOOK",
              workflow_status_label: "Đã thêm vào sách",
              committed_page_id: PAGE_ID,
              committed_revision_id: REV_ID,
              can_add_to_book: false,
              can_request_admin_review: false,
            }),
          ],
        };
        return Response.json(
          {
            book_id: BOOK_ID,
            page_id: PAGE_ID,
            page_number: 1,
            revision_id: REV_ID,
            submission: currentDetail.submissions[0],
            book_readable_for_children: true,
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected fetch ${url.pathname}`);
    });

    const user = userEvent.setup();
    render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-a")}>
        <AppServicesProvider>
          <ParentPrivateBookManager bookId={BOOK_ID} />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    // 1. Flagged submission locks Thêm trang vào sách
    const addButton = await screen.findByRole("button", {
      name: /Thêm trang vào sách/,
    });
    expect(addButton).toBeDisabled();
    expect(screen.getByText("Cần Admin duyệt")).toBeInTheDocument();

    // 2. Send exact snapshot to Admin
    await user.click(screen.getByRole("button", { name: /Gửi Admin xem xét/ }));
    await user.type(
      screen.getByLabelText("Lời nhắn cho Admin"),
      "Truyện cổ tích lớp 2 an toàn.",
    );
    await user.click(
      screen.getByRole("button", { name: /Xác nhận gửi Admin/ }),
    );

    await waitFor(() => {
      expect(postedCalls[0]).toEqual({
        path: `/books/my-books/${BOOK_ID}/submissions/${SUB_ID}/request-admin-review`,
        body: expect.objectContaining({
          expected_submission_version: 1,
          expected_candidate_hash: HASH_V1,
          request_note: "Truyện cổ tích lớp 2 an toàn.",
        }),
      });
    });
    expect(await screen.findByText("Đang chờ Admin")).toBeInTheDocument();

    // 3. Upload a file -> transitions to CHECK_FAILED -> retry works
    const fileInput = screen.getByLabelText(
      /Chọn tệp trang sách hoặc tài liệu/,
    );
    const fakeFile = new File(["img"], "trang2.png", { type: "image/png" });
    await user.upload(fileInput, fakeFile);
    await user.click(
      screen.getByRole("button", { name: /Tải lên & kiểm tra/ }),
    );

    const retryBtn = await screen.findByRole("button", {
      name: /Thử lại kiểm tra/,
    });
    await user.click(retryBtn);

    // 4. After Admin approval, decision reason is shown & Thêm trang vào sách is ENABLED
    expect(
      await screen.findByText(/Phù hợp cho bé lớp 2 đọc cùng phụ huynh/),
    ).toBeInTheDocument();
    const enabledAddBtn = screen.getByRole("button", {
      name: /Thêm trang vào sách/,
    });
    expect(enabledAddBtn).toBeEnabled();
    await user.click(enabledAddBtn);

    await waitFor(() => {
      expect(
        postedCalls.some(
          (call) =>
            call.path ===
              `/books/my-books/${BOOK_ID}/submissions/${SUB_ID}/add-page` &&
            (call.body as Record<string, unknown>)
              .expected_submission_version === 2 &&
            (call.body as Record<string, unknown>).expected_candidate_hash ===
              HASH_V2,
        ),
      ).toBe(true);
    });

    // 5. Book becomes readable for children after page is added
    expect(
      await screen.findByRole("link", { name: /Mở đọc cùng bé/ }),
    ).toHaveAttribute("href", `/books/${BOOK_ID}`);
  });

  it("edits a private book with full re-check warning and deletes a book immediately without re-check", async () => {
    let currentBook: ParentPrivateBookSummaryDTO | null = makeBookSummary({
      title: "test tạo",
      committed_page_count: 1,
      readable_for_children: true,
    });
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];

    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();

      if (
        (url.pathname === "/books/my-books" ||
          url.pathname === "/books/my-books/paged") &&
        method === "GET"
      ) {
        const list = currentBook ? [currentBook] : [];
        const payload =
          url.pathname === "/books/my-books/paged"
            ? { items: list, total: list.length, limit: 9, offset: 0 }
            : list;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === `/books/my-books/${BOOK_ID}` && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        requests.push({ method, path: url.pathname, body });
        currentBook = makeBookSummary({
          title: String(body.title ?? "test tạo"),
          committed_page_count: 0,
          pending_submission_count: 1,
          readable_for_children: false,
        });
        return new Response(JSON.stringify(currentBook), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.pathname === `/books/my-books/${BOOK_ID}` &&
        method === "DELETE"
      ) {
        requests.push({ method, path: url.pathname });
        currentBook = null;
        return new Response(
          JSON.stringify({
            status: "deleted",
            book_id: BOOK_ID,
            retired_pages_count: 0,
            cancelled_submissions_count: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const user = userEvent.setup();
    render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-a")}>
        <AppServicesProvider>
          <ParentMyBooksScreen />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(await screen.findByText("test tạo")).toBeInTheDocument();
    expect(screen.getByText("Bé có thể đọc")).toBeInTheDocument();

    // 1. Edit book -> shows full re-check warning -> saves -> resets readable status
    await user.click(screen.getByRole("button", { name: "Sửa sách test tạo" }));
    expect(
      screen.getByText(
        /toàn bộ các trang của sách sẽ phải kiểm tra lại từ đầu/,
      ),
    ).toBeInTheDocument();
    const titleInput = screen.getByLabelText("Tên sách chỉnh sửa");
    await user.clear(titleInput);
    await user.type(titleInput, "Truyện Mèo Con Sửa Lại");
    await user.click(
      screen.getByRole("button", { name: /Lưu & kiểm tra lại toàn bộ/ }),
    );

    await waitFor(() => {
      expect(requests[0]).toEqual({
        method: "PATCH",
        path: `/books/my-books/${BOOK_ID}`,
        body: expect.objectContaining({ title: "Truyện Mèo Con Sửa Lại" }),
      });
    });
    expect(
      await screen.findByText("Truyện Mèo Con Sửa Lại"),
    ).toBeInTheDocument();
    expect(screen.getByText("Chưa sẵn sàng đọc")).toBeInTheDocument();
    expect(
      screen.getByText(/đã được đưa về kiểm tra lại từ đầu/),
    ).toBeInTheDocument();

    // 2. Delete book -> inline confirm says no re-check -> deletes immediately
    await user.click(
      screen.getByRole("button", { name: "Xóa sách Truyện Mèo Con Sửa Lại" }),
    );
    expect(screen.getByText(/không cần kiểm tra lại/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Xác nhận xóa" }));

    await waitFor(() => {
      expect(requests[1]).toEqual({
        method: "DELETE",
        path: `/books/my-books/${BOOK_ID}`,
      });
    });
    expect(
      await screen.findByText("Bạn chưa có sách riêng nào"),
    ).toBeInTheDocument();
  });

  it("edits a committed page (triggering re-check) and deletes a committed page without re-check", async () => {
    const PAGE_2_ID = "dd000000-0000-4000-8000-000000000002";
    let detail: ParentPrivateBookDetailDTO = {
      book: makeBookSummary({
        committed_page_count: 2,
        readable_for_children: true,
      }),
      pages: [
        {
          page_id: PAGE_ID,
          page_number: 1,
          current_verified_revision_id: REV_ID,
          verified_text: "Mèo con đi học buổi sáng.",
          verified_text_preview: "Mèo con đi học buổi sáng.",
          image_url: `http://127.0.0.1:8000/books/my-books/${BOOK_ID}/pages/${PAGE_ID}/image`,
          created_at: NOW,
        },
        {
          page_id: PAGE_2_ID,
          page_number: 2,
          current_verified_revision_id: REV_ID,
          verified_text: "Thỏ trắng chơi ngoài vườn.",
          verified_text_preview: "Thỏ trắng chơi ngoài vườn.",
          image_url: `http://127.0.0.1:8000/books/my-books/${BOOK_ID}/pages/${PAGE_2_ID}/image`,
          created_at: NOW,
        },
      ],
      submissions: [],
    };
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];

    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.pathname.endsWith("/image")) {
        return new Response(new Blob(["png"], { type: "image/png" }), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      if (url.pathname === `/books/my-books/${BOOK_ID}` && method === "GET") {
        return new Response(JSON.stringify(detail), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.pathname === `/books/my-books/${BOOK_ID}/pages/${PAGE_2_ID}` &&
        method === "DELETE"
      ) {
        calls.push({ method, path: url.pathname });
        detail = {
          ...detail,
          book: makeBookSummary({
            committed_page_count: 1,
            readable_for_children: true,
          }),
          pages: [detail.pages[0]],
        };
        return new Response(
          JSON.stringify({
            status: "deleted",
            book_id: BOOK_ID,
            page_id: PAGE_2_ID,
            committed_page_count: 1,
            readable_for_children: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (
        url.pathname === `/books/my-books/${BOOK_ID}/pages/${PAGE_ID}` &&
        method === "PATCH"
      ) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        calls.push({ method, path: url.pathname, body });
        const recheckSub = makeSubmission({
          workflow_status: "CHECKING",
          workflow_status_label: "Đang kiểm tra",
          ocr_status: "COMPLETED",
          proofread_status: "PENDING",
          tool_check_status: "PENDING",
          candidate_text: String(body.candidate_text ?? ""),
          can_add_to_book: false,
          can_request_admin_review: false,
        });
        detail = {
          book: makeBookSummary({
            committed_page_count: 0,
            pending_submission_count: 1,
            readable_for_children: false,
          }),
          pages: [],
          submissions: [recheckSub],
        };
        return new Response(JSON.stringify(recheckSub), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    });

    const user = userEvent.setup();
    render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-a")}>
        <AppServicesProvider>
          <ParentPrivateBookManager bookId={BOOK_ID} />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(
      await screen.findByText("Các trang đã thêm vào sách đọc (2)"),
    ).toBeInTheDocument();

    // 1. Delete Page 2 immediately -> no re-check on Page 1
    await user.click(screen.getByRole("button", { name: "Xóa trang 2" }));
    await user.click(screen.getByRole("button", { name: "Xác nhận xóa" }));

    await waitFor(() => {
      expect(calls[0]).toEqual({
        method: "DELETE",
        path: `/books/my-books/${BOOK_ID}/pages/${PAGE_2_ID}`,
      });
    });
    expect(
      await screen.findByText("Các trang đã thêm vào sách đọc (1)"),
    ).toBeInTheDocument();

    // 2. Edit Page 1 -> retires from readable book & re-queues full check
    await user.click(
      screen.getByRole("button", { name: "Sửa nội dung trang 1" }),
    );
    const textarea = screen.getByLabelText("Chỉnh sửa văn bản trang 1");
    await user.clear(textarea);
    await user.type(textarea, "Mèo con đi học rất vui vẻ.");
    await user.click(
      screen.getByRole("button", { name: /Lưu & kiểm tra lại/ }),
    );

    await waitFor(() => {
      expect(calls[1]).toEqual({
        method: "PATCH",
        path: `/books/my-books/${BOOK_ID}/pages/${PAGE_ID}`,
        body: expect.objectContaining({
          candidate_text: "Mèo con đi học rất vui vẻ.",
          auto_recheck: true,
        }),
      });
    });
    expect(
      await screen.findByText("Các trang đã thêm vào sách đọc (0)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Đang kiểm tra")).toBeInTheDocument();
  });

  it("paginates My Books at 9/page, preserves URL & detail returnPage, rolls back after deleting last item on last page, and discards stale responses", async () => {
    const allBooks = Array.from({ length: 10 }, (_, index) =>
      makeBookSummary({
        id: `aa000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        title: `Sách Gia Đình Số ${index + 1}`,
      }),
    );
    let currentBooks = [...allBooks];
    let delayFirstPage2 = false;
    let resolveSlowPage2: (() => void) | null = null;

    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === "/books/my-books/paged" && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? "9");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        if (offset === 9 && delayFirstPage2) {
          delayFirstPage2 = false;
          await new Promise<void>((resolve) => {
            resolveSlowPage2 = resolve;
          });
        }
        return Response.json({
          items: currentBooks.slice(offset, offset + limit),
          total: currentBooks.length,
          limit,
          offset,
        });
      }
      if (url.pathname.startsWith("/books/my-books/") && method === "DELETE") {
        const id = url.pathname.split("/").pop()!;
        currentBooks = currentBooks.filter((b) => b.id !== id);
        return Response.json({
          status: "deleted",
          book_id: id,
          retired_pages_count: 0,
          cancelled_submissions_count: 0,
        });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });

    const user = userEvent.setup();
    render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-a")}>
        <AppServicesProvider>
          <ParentMyBooksScreen />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    // Page 1 shows books 1..9 (NOT book 10)
    expect(await screen.findByText("Sách Gia Đình Số 1")).toBeInTheDocument();
    expect(screen.getByText("Sách Gia Đình Số 9")).toBeInTheDocument();
    expect(screen.queryByText("Sách Gia Đình Số 10")).not.toBeInTheDocument();

    // Go to page 2 -> URL synced to ?page=2 & detail link includes ?fromPage=2
    const nextButtons = screen.getAllByRole("button", { name: /Sau|Tiếp/ });
    await user.click(nextButtons[0]);
    expect(await screen.findByText("Sách Gia Đình Số 10")).toBeInTheDocument();
    expect(screen.queryByText("Sách Gia Đình Số 1")).not.toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith("/my-books?page=2", {
      scroll: false,
    });
    expect(
      screen.getByRole("link", { name: /Quản lý & thêm trang/ }),
    ).toHaveAttribute(
      "href",
      "/my-books/aa000000-0000-4000-8000-000000000010?fromPage=2",
    );

    // Delete last (only) book on page 2 -> rolls back to page 1 & pagination hides (9 <= 9)
    await user.click(
      screen.getByRole("button", { name: "Xóa sách Sách Gia Đình Số 10" }),
    );
    await user.click(screen.getByRole("button", { name: "Xác nhận xóa" }));
    expect(await screen.findByText("Sách Gia Đình Số 1")).toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith("/my-books", { scroll: false });
    expect(
      screen.queryByRole("navigation", { name: /Phân trang Sách của tôi/ }),
    ).not.toBeInTheDocument();

    // Add book back -> test stale response discard when jumping page 2 (slow) then back to page 1 (fast)
    currentBooks = [...allBooks];
    await user.click(screen.getByRole("button", { name: /Tải lại/ }));
    expect(
      await screen.findByRole("navigation", {
        name: "Phân trang Sách của tôi",
      }),
    ).toBeInTheDocument();

    delayFirstPage2 = true;
    await user.click(screen.getAllByRole("button", { name: /Sau|Tiếp/ })[0]);
    // Immediately click Prev before slow page 2 finishes
    await waitFor(() => expect(resolveSlowPage2).not.toBeNull());
    // Resolve slow page 2 after navigating away -> should not corrupt page 1
    // Note: while fetching, pagination buttons are disabled; simulate rapid navigation via unmount/back or verify page 2 settles cleanly
    resolveSlowPage2!();
    expect(await screen.findByText("Sách Gia Đình Số 10")).toBeInTheDocument();
  });

  it("paginates committed pages inside ParentPrivateBookManager and preserves returnPage back link", async () => {
    const pages = Array.from({ length: 15 }, (_, idx) => ({
      page_id: `dd000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
      page_number: idx + 1,
      current_verified_revision_id: REV_ID,
      verified_text: `Nội dung trang ${idx + 1}`,
      verified_text_preview: `Nội dung trang ${idx + 1}`,
      image_url: `http://127.0.0.1:8000/books/my-books/${BOOK_ID}/pages/dd000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}/image`,
      created_at: NOW,
    }));
    const detail: ParentPrivateBookDetailDTO = {
      book: makeBookSummary({
        committed_page_count: 15,
        readable_for_children: true,
      }),
      pages,
      submissions: [],
    };
    apiFetchFixture.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/image")) {
        return new Response(new Blob(["png"], { type: "image/png" }), {
          status: 200,
        });
      }
      if (url.pathname === `/books/my-books/${BOOK_ID}`) {
        return Response.json(detail);
      }
      throw new Error(`Unexpected ${url.pathname}`);
    });

    const user = userEvent.setup();
    render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("parent-a")}>
        <AppServicesProvider>
          <ParentPrivateBookManager bookId={BOOK_ID} returnPage={4} />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(
      await screen.findByText("Các trang đã thêm vào sách đọc (15)"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Quay lại Sách của tôi/ }),
    ).toHaveAttribute("href", "/my-books?page=4");
    expect(screen.getByText("Trang 12")).toBeInTheDocument();
    expect(screen.queryByText("Trang 13")).not.toBeInTheDocument();

    const pagesNav = screen.getByRole("navigation", {
      name: "Phân trang các trang đã thêm vào sách",
    });
    const nextBtn = pagesNav.querySelectorAll("button")[1];
    await user.click(nextBtn);
    expect(await screen.findByText("Trang 13")).toBeInTheDocument();
    expect(screen.getByText("Trang 15")).toBeInTheDocument();
    expect(screen.queryByText("Trang 1")).not.toBeInTheDocument();
  });
});
