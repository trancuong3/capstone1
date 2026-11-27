import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ParentPrivateBookManager } from "@/components/books/parent-private-book-manager";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "parent-30p-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "https://api.example.com",
}));

const BOOK_ID = "91000000-0000-4000-8000-000000000001";
const BATCH_ID = "93000000-0000-4000-8000-000000000001";

function buildSubmission(index: number) {
  const pageNum = index + 1;
  const subId = `92000000-0000-4000-8000-${String(pageNum).padStart(12, "0")}`;

  const base = {
    id: subId,
    book_id: BOOK_ID,
    batch_id: BATCH_ID,
    batch_total_pages: 30,
    source_page_number: pageNum,
    target_page_number: pageNum,
    source_file_name: "sach-30-trang.pdf",
    source_format: "PDF",
    image_width: 800,
    image_height: 1100,
    image_url: `https://storage.example.com/p${pageNum}.jpg`,
    source_type: "OWNED_PHYSICAL_BOOK" as const,
    source_type_label: "Sách giấy gia đình đã mua để con luyện đọc tại nhà",
    source_note: null,
    submission_version: 1,
    optimistic_lock_version: 1,
    ocr_text: `Nội dung trang ${pageNum} đã sẵn sàng.`,
    ocr_error_code: null as string | null,
    is_image_only: false,
    proofread_text: `Nội dung trang ${pageNum} đã sẵn sàng.`,
    proofread_suggestions: [],
    uncertain_word_indices: [],
    proofread_error_code: null as string | null,
    spelling_accepted: true,
    candidate_text: `Nội dung trang ${pageNum} đã sẵn sàng.`,
    candidate_hash: `hash-p${pageNum}`,
    tool_check_suitability: "SAFE" as string | null,
    tool_check_scope: {
      modality: "TEXT_AND_IMAGE",
      covers_all_chunks: true,
      chunks_checked: 1,
      total_chunks: 1,
      image_visual_safety_checked: false,
      requires_admin_visual_review: false,
      copyright_scanner_status: "CLEAR",
      local_ai_enforced: true,
    },
    tool_check_findings_count: 0,
    tool_check_parent_notice: null as string | null,
    tool_check_policy_blocked: false,
    tool_check_workflow_id: null as string | null,
    tool_check_error_code: null as string | null,
    provider_events: [],
    admin_decision: null,
    admin_decision_reason: null,
    approved_snapshot_hash: null,
    approved_submission_version: null,
    committed_page_id: null,
    committed_revision_id: null,
    created_at: "2026-11-24T00:00:00Z",
    updated_at: "2026-11-24T00:00:00Z",
  };

  if (pageNum === 7) {
    return {
      ...base,
      ocr_status: "FAILED",
      ocr_text: null,
      ocr_error_code: "LOCAL_OCR_UNAVAILABLE",
      proofread_status: "PENDING",
      proofread_text: null,
      spelling_accepted: false,
      candidate_text: null,
      tool_check_status: "PENDING",
      tool_check_suitability: null,
      tool_check_scope: {
        ...base.tool_check_scope,
        covers_all_chunks: false,
        chunks_checked: 0,
        total_chunks: 0,
      },
      workflow_status: "CHECK_FAILED" as const,
      workflow_status_label: "Kiểm tra lỗi",
      can_add_to_book: false,
      can_request_admin_review: false,
      can_retry: true,
    };
  }

  if (pageNum === 12) {
    return {
      ...base,
      ocr_status: "PASSED",
      proofread_status: "PASSED",
      tool_check_status: "FLAGGED",
      tool_check_findings_count: 1,
      tool_check_parent_notice: "Cần Admin xác nhận từ ngữ.",
      workflow_status: "PENDING_ADMIN" as const,
      workflow_status_label: "Chờ Admin duyệt",
      can_add_to_book: false,
      can_request_admin_review: false,
      can_retry: false,
    };
  }

  return {
    ...base,
    ocr_status: "PASSED",
    proofread_status: "PASSED",
    tool_check_status: "PASSED",
    workflow_status: "PASSED_READY_TO_ADD" as const,
    workflow_status_label: "Sẵn sàng thêm",
    can_add_to_book: true,
    can_request_admin_review: false,
    can_retry: false,
  };
}

describe("ParentPrivateBookManager 30-page mixed state view", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders all 30 pages with mixed states, actionable OCR offline hint, status filters, and per-page Retry on Page 7", async () => {
    const submissions = Array.from({ length: 30 }, (_, index) =>
      buildSubmission(index),
    );
    const detailPayload = {
      book: {
        id: BOOK_ID,
        title: "Truyện 30 trang",
        author: "Tác giả",
        min_grade: 1,
        max_grade: 3,
        lifecycle_status: "ACTIVE",
        visibility_scope: "PARENT_PRIVATE",
        moderation_status: "ACTIVE",
        suspended_reason: null,
        source_declaration: "OWNED_PHYSICAL_BOOK",
        committed_page_count: 0,
        pending_submission_count: 30,
        flagged_submission_count: 1,
        failed_submission_count: 1,
        ready_to_add_count: 28,
        readable_for_children: false,
        has_held_multipage_batch: false,
        privacy_notice: "Chỉ hiển thị trong tài khoản của ba mẹ.",
        ocr_contribution: null,
        created_at: "2026-11-24T00:00:00Z",
      },
      pages: [],
      submissions,
    };

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).includes("/retry")) {
        return Response.json(buildSubmission(6));
      }
      return Response.json(detailPayload);
    });

    render(
      <AppServicesProvider>
        <ParentPrivateBookManager bookId={BOOK_ID} />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByText(/Các trang đang kiểm tra & duyệt \(30\)/),
    ).toBeInTheDocument();

    // Mixed summary counters visible simultaneously
    const filterGroup = screen.getByRole("group", {
      name: "Lọc trạng thái từng trang",
    });
    expect(
      within(filterGroup).getByRole("button", { name: "Tất cả (30)" }),
    ).toBeInTheDocument();
    expect(
      within(filterGroup).getByRole("button", { name: "Sẵn sàng thêm (28)" }),
    ).toBeInTheDocument();
    expect(
      within(filterGroup).getByRole("button", { name: "Chờ / Cần Admin (1)" }),
    ).toBeInTheDocument();
    expect(
      within(filterGroup).getByRole("button", { name: "Lỗi kiểm tra (1)" }),
    ).toBeInTheDocument();

    // Actionable guidance shown alongside Page 7 without exposing raw LOCAL_OCR_UNAVAILABLE code
    expect(screen.queryByText(/LOCAL_OCR_UNAVAILABLE/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Hệ thống kiểm tra đang tạm nghỉ hoặc khởi động/),
    ).toBeInTheDocument();

    // Filter to failed pages -> focuses cleanly on Page 7 with Retry button
    fireEvent.click(
      within(filterGroup).getByRole("button", { name: "Lỗi kiểm tra (1)" }),
    );
    expect(screen.getByText(/Trang nguồn 7\/30/)).toBeInTheDocument();
    expect(screen.queryByText(/Trang nguồn 12\/30/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Thử lại kiểm tra" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes(
              "/92000000-0000-4000-8000-000000000007/retry",
            ) && init?.method === "POST",
        ),
      ).toBe(true);
    });
  }, 15_000);
});
