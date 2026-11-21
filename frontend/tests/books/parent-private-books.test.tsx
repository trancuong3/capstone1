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
        url.pathname === "/books/my-books" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json(
          activeUser === "parent-a" ? parentABooks : parentBBooks,
        );
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
              admin_decision_reason:
                "Phù hợp cho bé lớp 2 đọc cùng phụ huynh.",
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
    await user.click(
      screen.getByRole("button", { name: /Gửi Admin xem xét/ }),
    );
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
            (call.body as Record<string, unknown>).expected_submission_version ===
              2 &&
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
});
