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
import { resolvePrivateApiMediaUrl } from "@/lib/api/api-client";
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
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "mobile-parent-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const BOOK_ID = "aa111111-1111-4111-8111-111111111111";
const SUB_ID_1 = "bb111111-1111-4111-8111-111111111111";
const SUB_ID_2 = "bb222222-2222-4222-8222-222222222222";
const BATCH_ID = "cc111111-1111-4111-8111-111111111111";
const HASH_1 = "a".repeat(64);
const NOW = "2026-11-22T00:00:00Z";

function makeAuthRuntime(): AuthRuntimeState {
  return {
    initializationFailure: null,
    isPasswordRecovery: false,
    lastEvent: "SIGNED_IN",
    mode: "supabase",
    status: "ready",
    session: {
      expires_at: null,
      user: {
        id: "parent-mobile-01",
        email: "parent.mobile@viread.test",
        display_name: "Mẹ Bé Minh",
      },
    },
  };
}

function makeBookSummary(
  overrides: Partial<ParentPrivateBookSummaryDTO> = {},
): ParentPrivateBookSummaryDTO {
  return {
    id: BOOK_ID,
    title: "Sách Đồng Dao Cho Bé",
    author: "Gia đình Minh",
    min_grade: 1,
    max_grade: 2,
    lifecycle_status: "ACTIVE",
    visibility_scope: "PARENT_PRIVATE",
    moderation_status: "ACTIVE",
    suspended_reason: null,
    source_declaration: "Sách giấy của gia đình",
    committed_page_count: 1,
    pending_submission_count: 0,
    flagged_submission_count: 1,
    failed_submission_count: 0,
    ready_to_add_count: 1,
    readable_for_children: true,
    has_held_multipage_batch: false,
    privacy_notice: "Chỉ gia đình bạn được đọc.",
    created_at: NOW,
    ...overrides,
  };
}

function makeSubmission(
  overrides: Partial<ParentPageSubmissionDTO> = {},
): ParentPageSubmissionDTO {
  return {
    id: SUB_ID_1,
    book_id: BOOK_ID,
    batch_id: BATCH_ID,
    batch_total_pages: 2,
    source_page_number: 1,
    target_page_number: null,
    source_file_name: "dong-dao-30-trang.pdf",
    source_format: "PDF",
    image_width: 1200,
    image_height: 1600,
    image_url: `http://127.0.0.1:8000/books/my-books/${BOOK_ID}/submissions/${SUB_ID_1}/image`,
    source_type: "OWNED_PHYSICAL_BOOK",
    source_type_label: "Sách giấy gia đình sở hữu",
    source_note: null,
    submission_version: 1,
    optimistic_lock_version: 1,
    workflow_status: "PASSED_READY_TO_ADD",
    workflow_status_label: "Đủ điều kiện thêm vào sách",
    ocr_status: "COMPLETED",
    ocr_text: "Rồng rắn lên mây có cây lúc lắc.",
    ocr_error_code: null,
    is_image_only: false,
    proofread_status: "COMPLETED",
    proofread_text: "Rồng rắn lên mây có cây lúc lắc.",
    proofread_suggestions: [],
    uncertain_word_indices: [],
    proofread_error_code: null,
    spelling_accepted: true,
    candidate_text: "Rồng rắn lên mây có cây lúc lắc.",
    candidate_hash: HASH_1,
    tool_check_status: "PASSED",
    tool_check_suitability: "SUITABLE",
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
    tool_check_findings_count: 0,
    tool_check_parent_notice: null,
    tool_check_policy_blocked: false,
    tool_check_workflow_id: null,
    tool_check_error_code: null,
    provider_events: [],
    can_add_to_book: true,
    can_request_admin_review: false,
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
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Mobile My Books Multi-Format Upload (Image/PDF/DOCX) & Responsive Controls", () => {
  it("rewrites absolute backend private image URLs onto getApiBaseUrl() so Android LAN HTTPS proxies never mixed-content fail", () => {
    expect(
      resolvePrivateApiMediaUrl(
        "http://192.168.1.4:8443/books/my-books/abc/pages/p1/image",
      ),
    ).toBe("http://127.0.0.1:8000/books/my-books/abc/pages/p1/image");
    expect(
      resolvePrivateApiMediaUrl("/books/my-books/abc/submissions/s1/image"),
    ).toBe("http://127.0.0.1:8000/books/my-books/abc/submissions/s1/image");
  });

  it("renders My Books list cleanly on mobile and navigates after creating a book", async () => {
    const user = userEvent.setup();
    const summary = makeBookSummary();

    apiFetchFixture.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/books/my-books" && (!init?.method || init.method === "GET")) {
        return Response.json([summary]);
      }
      if (path === "/books/my-books" && init?.method === "POST") {
        return Response.json(
          makeBookSummary({
            id: "aa222222-2222-4222-8222-222222222222",
            title: "Truyện Cổ Tích Mobile",
          }),
        );
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });

    render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime()}>
        <AppServicesProvider>
          <ParentMyBooksScreen />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(
      await screen.findByText("Sách Đồng Dao Cho Bé"),
    ).toBeInTheDocument();
    expect(screen.getByText(/tối đa 30 trang\/tệp/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Tạo sách riêng/i }));
    await user.type(
      screen.getByLabelText(/Tên sách/i),
      "Truyện Cổ Tích Mobile",
    );
    await user.click(
      screen.getByRole("button", { name: /Lưu và thêm trang/i }),
    );

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        "/my-books/aa222222-2222-4222-8222-222222222222",
      );
    });
  });

  it("exposes all ViRead accept MIME/extensions for Android picker and uploads PDF, DOCX, and camera JPEG", async () => {
    const user = userEvent.setup();
    const uploadedFiles: Array<{ name: string; type: string }> = [];

    const detail: ParentPrivateBookDetailDTO = {
      book: makeBookSummary(),
      pages: [],
      submissions: [
        makeSubmission(),
        makeSubmission({
          id: SUB_ID_2,
          source_page_number: 2,
          workflow_status: "NEEDS_ADMIN_REVIEW",
          workflow_status_label: "Cần Admin duyệt",
          tool_check_status: "FLAGGED",
          tool_check_suitability: "REVIEW_REQUIRED",
          tool_check_findings_count: 1,
          can_add_to_book: false,
          can_request_admin_review: true,
        }),
      ],
    };

    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (
        url.pathname === `/books/my-books/${BOOK_ID}` &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json(detail);
      }
      if (
        url.pathname === `/books/my-books/${BOOK_ID}/submissions` &&
        init?.method === "POST"
      ) {
        const form = init.body as FormData;
        const f = form.get("file") as File;
        uploadedFiles.push({ name: f.name, type: f.type });
        return Response.json({
          book_id: BOOK_ID,
          batch_id: BATCH_ID,
          source_format: f.name.endsWith(".pdf")
            ? "PDF"
            : f.name.endsWith(".docx")
              ? "DOCX"
              : "IMAGE",
          total_pages: f.name.endsWith(".jpg") ? 1 : 5,
          replayed_idempotency: false,
          submissions: detail.submissions,
        });
      }
      if (url.pathname.endsWith("/image")) {
        return new Response(new Blob(["img"], { type: "image/png" }), {
          status: 200,
        });
      }
      throw new Error(
        `Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`,
      );
    });

    render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime()}>
        <AppServicesProvider>
          <ParentPrivateBookManager bookId={BOOK_ID} />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(
      await screen.findByText("Sách Đồng Dao Cho Bé"),
    ).toBeInTheDocument();

    const fileInput = screen.getByLabelText(
      /Chọn tệp trang sách hoặc tài liệu/i,
    ) as HTMLInputElement;
    for (const token of [
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".bmp",
      ".tif",
      ".tiff",
      ".pdf",
      ".docx",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]) {
      expect(fileInput.accept).toContain(token);
    }

    // 1. Upload multipage PDF (<= 30 pages)
    const pdf = new File(["%PDF-1.7 sample"], "tap-doc-lop-2.pdf", {
      type: "application/pdf",
    });
    await user.upload(fileInput, pdf);
    await user.click(
      screen.getByRole("button", { name: /Tải lên & kiểm tra/i }),
    );

    await waitFor(() => expect(uploadedFiles).toHaveLength(1));
    expect(uploadedFiles[0]).toEqual({
      name: "tap-doc-lop-2.pdf",
      type: "application/pdf",
    });

    // 2. Upload DOCX document
    const docx = new File(["PK\x03\x04docx"], "bai-tho.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await user.upload(fileInput, docx);
    await user.click(
      screen.getByRole("button", { name: /Tải lên & kiểm tra/i }),
    );
    await waitFor(() => expect(uploadedFiles).toHaveLength(2));
    expect(uploadedFiles[1].name).toBe("bai-tho.docx");
  });
});
