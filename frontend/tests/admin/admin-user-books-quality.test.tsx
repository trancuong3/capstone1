import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminBookContentQualityScreen } from "@/components/admin/admin-book-content-quality-screen";
import { ServiceError } from "@/lib/api/service-error";
import {
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type {
  AdminUserBookQueueItemDTO,
  AdminUserBookSubmissionDetailDTO,
} from "@/types/parent-private-book";

vi.mock("@/lib/api/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/api-client")>();
  return {
    ...actual,
    fetchAuthenticatedBlobUrl: vi.fn(async () => "blob:admin-private-preview"),
    revokePrivateBlobUrl: vi.fn(),
  };
});

const BOOK_ID = "aa000000-0000-4000-8000-000000000010";
const SUB_ID = "bb000000-0000-4000-8000-000000000010";
const REQ_ID = "dd000000-0000-4000-8000-000000000010";
const AUDIT_ID = "ee000000-0000-4000-8000-000000000010";
const HASH_A = "a".repeat(64);
const NOW = "2026-11-21T12:00:00Z";

function makeQueueItem(
  overrides: Partial<AdminUserBookQueueItemDTO> = {},
): AdminUserBookQueueItemDTO {
  return {
    book_id: BOOK_ID,
    book_title: "Sách Riêng Cần Duyệt",
    book_author: "Gia đình An",
    owner_label: "Phụ huynh A (id#11111111)",
    moderation_status: "ACTIVE",
    queue_status: "PENDING_ADMIN",
    pending_count: 1,
    flagged_count: 1,
    failed_count: 0,
    committed_page_count: 0,
    latest_submission_id: SUB_ID,
    latest_request_id: REQ_ID,
    latest_submission_version: 1,
    latest_submitted_at: NOW,
    policy_blocked: false,
    ...overrides,
  };
}

function makeDetail(
  overrides: Partial<AdminUserBookSubmissionDetailDTO> = {},
): AdminUserBookSubmissionDetailDTO {
  return {
    submission_id: SUB_ID,
    request_id: REQ_ID,
    book_id: BOOK_ID,
    book_title: "Sách Riêng Cần Duyệt",
    book_author: "Gia đình An",
    book_moderation_status: "ACTIVE",
    book_suspended_reason: null,
    owner_label: "Phụ huynh A (id#11111111)",
    source_file_name: "trang1.png",
    source_format: "IMAGE",
    source_page_number: 1,
    batch_total_pages: 1,
    submission_version: 1,
    optimistic_lock_version: 2,
    snapshot_hash: HASH_A,
    source_sha256: "f".repeat(64),
    image_width: 400,
    image_height: 300,
    image_url: `http://127.0.0.1:8000/books/admin/quality/user-books/submissions/${SUB_ID}/image`,
    workflow_status: "PENDING_ADMIN",
    workflow_status_label: "Đang chờ Admin",
    request_status: "PENDING_ADMIN",
    ocr_status: "COMPLETED",
    ocr_text: "Văn bản OCR gốc có đoạn cảnh báo.",
    ocr_error_code: null,
    is_image_only: false,
    proofread_status: "COMPLETED",
    proofread_text: "Văn bản đã rà chính tả có đoạn cảnh báo.",
    proofread_suggestions: [],
    uncertain_word_indices: [],
    proofread_error_code: null,
    candidate_text: "Văn bản đề xuất có đoạn cảnh báo.",
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
    tool_check_findings: [
      {
        finding_id: "f-1",
        source: "OLLAMA_TEXT",
        category: "MILD_SCARY_THEME",
        severity: "MEDIUM",
        content_type: "TEXT",
        excerpt: "đoạn nhạy cảm cần ẩn mặc định",
        explanation: "Có cụm từ cần người lớn đánh giá ngữ cảnh.",
        recommendation: "Cần Admin xem xét trước khi mở cho trẻ.",
      },
    ],
    tool_check_policy_blocked: false,
    tool_check_error_code: null,
    tool_check_workflow_id: null,
    provider_events: [],
    source_type: "OWNED_PHYSICAL_BOOK",
    source_type_label: "Sách giấy gia đình sở hữu",
    source_note: "Sách mua ở nhà sách",
    parent_request_note: "Mong Admin xem xét duyệt trang này.",
    can_approve: true,
    approve_blocked_reason: null,
    approved_snapshot_hash: null,
    approved_submission_version: null,
    admin_decision: null,
    admin_decision_reason: null,
    history: [],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Admin Chất lượng sách -> Sách người dùng tab", () => {
  it("supports all 6 status filters, collapses sensitive excerpts by default, validates reason, and submits decisions", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.bookContentQuality.listBooks).mockResolvedValue({
      items: [],
      total: 0,
      limit: 10,
      offset: 0,
      summary: {},
      alert_summary: { CHILD_SAFETY: 0, COPYRIGHT: 0, BOTH: 0 },
    });
    vi.mocked(services.bookContentQuality.listReports).mockResolvedValue({
      items: [],
      total: 0,
      summary: {},
      limit: 10,
      offset: 0,
    });
    vi.mocked(services.bookContentQuality.listUserBooks!).mockResolvedValue({
      items: [makeQueueItem()],
      total: 1,
      summary: {
        PENDING_ADMIN: 1,
        FLAGGED: 2,
        CHECK_FAILED: 1,
        APPROVED: 3,
        REJECTED: 1,
        SUSPENDED: 0,
      },
      limit: 30,
      offset: 0,
    });
    vi.mocked(
      services.bookContentQuality.getUserBookSubmission!,
    ).mockResolvedValue(makeDetail());
    vi.mocked(
      services.bookContentQuality.decideUserBookSubmission!,
    ).mockResolvedValue({
      submission_id: SUB_ID,
      book_id: BOOK_ID,
      decision: "APPROVE",
      previous_status: "PENDING_ADMIN",
      new_workflow_status: "APPROVED_READY_TO_ADD",
      book_moderation_status: "ACTIVE",
      approved_snapshot_hash: HASH_A,
      approved_submission_version: 1,
      optimistic_lock_version: 3,
      decided_at: NOW,
      reason: "Đã kiểm tra ngữ cảnh phù hợp cho bé.",
      audit_log_id: AUDIT_ID,
    });

    const user = userEvent.setup();
    const { container } = render(
      withAdminFixture(<AdminBookContentQualityScreen />, services),
    );

    // Switch to Sách người dùng tab
    const userBooksTab = await screen.findByRole("tab", {
      name: "Sách người dùng",
    });
    await user.click(userBooksTab);
    expect(userBooksTab).toHaveAttribute("aria-selected", "true");

    // Regression guard: NO duplicate #quality-panel-user-books or any duplicate IDs
    expect(
      container.querySelectorAll("#quality-panel-user-books"),
    ).toHaveLength(1);
    const ids = Array.from(container.querySelectorAll("[id]")).map(
      (el) => el.id,
    );
    expect(new Set(ids).size).toBe(ids.length);

    // All 6 status filters visible
    for (const label of [
      /Chờ duyệt/,
      /Có cảnh báo/,
      /Kiểm tra lỗi/,
      /Đã duyệt/,
      /Bị từ chối/,
      /Đang đình chỉ/,
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }

    // Open detail
    expect(await screen.findByText("Sách Riêng Cần Duyệt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mở để duyệt" }));

    expect(
      await screen.findByText(/Văn bản đề xuất có đoạn cảnh báo/),
    ).toBeInTheDocument();
    // No button to promote private book to catalog
    expect(
      screen.queryByRole("button", {
        name: /Phê duyệt toàn bộ sách|Xuất bản/i,
      }),
    ).not.toBeInTheDocument();

    // Sensitive excerpt MUST be collapsed by default
    const excerptSummary = screen.getByText("Xem đoạn nhạy cảm bị gắn cờ");
    const detailsEl = excerptSummary.closest("details");
    expect(detailsEl).not.toBeNull();
    expect(detailsEl?.open).toBe(false);

    // Reason validation (< 5 chars blocked)
    await user.click(screen.getByRole("button", { name: /Duyệt bản này/ }));
    expect(
      await screen.findByText(
        /Vui lòng nhập lý do quyết định tối thiểu 5 ký tự/,
      ),
    ).toBeInTheDocument();
    expect(
      services.bookContentQuality.decideUserBookSubmission,
    ).not.toHaveBeenCalled();

    // Enter valid reason & Approve exact revision
    await user.type(
      screen.getByLabelText("Lý do quyết định Admin"),
      "Đã kiểm tra ngữ cảnh phù hợp cho bé.",
    );
    await user.click(screen.getByRole("button", { name: /Duyệt bản này/ }));

    await waitFor(() => {
      expect(
        services.bookContentQuality.decideUserBookSubmission,
      ).toHaveBeenCalledWith(SUB_ID, {
        decision: "APPROVE",
        reason: "Đã kiểm tra ngữ cảnh phù hợp cho bé.",
        expected_submission_version: 1,
        expected_snapshot_hash: HASH_A,
        expected_lock_version: 2,
      });
    });
    // Drawer auto-closes on success while keeping confirmation notice visible above queue
    await waitFor(() => {
      expect(
        screen.queryByTestId("admin-drawer-panel"),
      ).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText(/Đã phê duyệt đúng phiên bản v1/),
    ).toBeInTheDocument();
  });

  it("disables Approve on policy-blocked content and handles concurrent 409 conflict cleanly", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.bookContentQuality.listBooks).mockResolvedValue({
      items: [],
      total: 0,
      limit: 10,
      offset: 0,
      summary: {},
      alert_summary: { CHILD_SAFETY: 0, COPYRIGHT: 0, BOTH: 0 },
    });
    vi.mocked(services.bookContentQuality.listReports).mockResolvedValue({
      items: [],
      total: 0,
      summary: {},
      limit: 10,
      offset: 0,
    });
    vi.mocked(services.bookContentQuality.listUserBooks!).mockResolvedValue({
      items: [makeQueueItem({ policy_blocked: true })],
      total: 1,
      summary: { PENDING_ADMIN: 1 },
      limit: 30,
      offset: 0,
    });
    vi.mocked(
      services.bookContentQuality.getUserBookSubmission!,
    ).mockResolvedValue(
      makeDetail({
        can_approve: false,
        tool_check_policy_blocked: true,
        tool_check_suitability: "NOT_RECOMMENDED",
        approve_blocked_reason:
          "Nội dung vi phạm mức chặn an toàn trẻ em (HIGH) không thể duyệt bỏ qua.",
      }),
    );
    vi.mocked(
      services.bookContentQuality.decideUserBookSubmission!,
    ).mockRejectedValue(
      new ServiceError({
        code: "CONTENT_INACTIVE",
        message: "Bản nộp đã thay đổi bởi Admin khác.",
        status: 409,
        request_id: "req-409",
        retryable: false,
      }),
    );

    const user = userEvent.setup();
    render(withAdminFixture(<AdminBookContentQualityScreen />, services));

    await user.click(
      await screen.findByRole("tab", { name: "Sách người dùng" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Mở để duyệt" }),
    );

    // Approve button MUST be disabled when policy-blocked
    const approveBtn = await screen.findByRole("button", {
      name: /Duyệt bản này/,
    });
    expect(approveBtn).toBeDisabled();
    expect(
      screen.getByText(/Nội dung bị chặn theo chính sách an toàn trẻ em/),
    ).toBeInTheDocument();

    // Reject hits concurrent 409 conflict -> displays clear conflict banner + reload CTA
    await user.type(
      screen.getByLabelText("Lý do quyết định Admin"),
      "Từ chối do vi phạm mức chặn.",
    );
    await user.click(screen.getByRole("button", { name: /Từ chối/ }));

    expect(
      await screen.findByText(/Xung đột phiên bản \(409\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Tải lại phiên bản mới nhất/ }),
    ).toBeInTheDocument();
  });
});
