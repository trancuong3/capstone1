import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminBookContentQualityScreen } from "@/components/admin/admin-book-content-quality-screen";
import { ServiceError } from "@/lib/api/service-error";
import {
  ADMIN_BOOK_ID,
  ADMIN_PAGE_ID,
  ADMIN_R2_ID,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type {
  BookApprovalAssessmentDTO,
  BookContentReportDetailDTO,
  BookContentRightsProfileDTO,
  BookQualityBookDetailDTO,
  BookQualityBookSummaryDTO,
} from "@/types/book-content-quality";

const REPORT_ID = "91000000-0000-4000-8000-000000000001";
const PAGE_2_ID = "83000000-0000-4000-8000-000000000002";

function makeAssessment(
  overrides: Partial<BookApprovalAssessmentDTO> = {},
): BookApprovalAssessmentDTO {
  return {
    status: "READY_FOR_CHILDREN",
    page_count: 2,
    ocr_completed_pages: 2,
    ocr_approval_valid_pages: 2,
    proofreading_status: "COMPLETED",
    proofreading_completed_pages: 2,
    proofreading_suggestion_count: 0,
    child_safety_status: "COMPLETED",
    child_safety_completed_pages: 2,
    processing_pages: 0,
    failed_pages: 0,
    stale_pages: 0,
    copyright_status: "REVIEWED",
    copyright_finding_count: 0,
    rights_profile_status: "REVIEWED",
    rights_profile_version: 1,
    rights_profile_hash: "f".repeat(64),
    legacy_published_needs_rights_review: false,
    expected_page_count: null,
    expected_page_count_status: "UNKNOWN_SOURCE_PAGE_COUNT",
    missing_page_numbers: [],
    duplicate_page_numbers: [],
    empty_ocr_page_numbers: [],
    missing_image_page_numbers: [],
    image_only_page_numbers: [],
    finding_count: 0,
    high_finding_count: 0,
    medium_finding_count: 0,
    warning_page_count: 0,
    failed_or_unscanned_page_count: 0,
    finding_groups: [],
    assessment_hash: "a".repeat(64),
    assessed_at: "2026-11-21T00:00:00Z",
    admin_approved_at: null,
    admin_approved_by: null,
    admin_approved_by_name: null,
    admin_reason: null,
    publication_source: null,
    rights_confirmed: true,
    blockers: [],
    ...overrides,
  };
}

function makeRightsProfile(
  overrides: Partial<BookContentRightsProfileDTO> = {},
): BookContentRightsProfileDTO {
  return {
    id: "86000000-0000-4000-8000-000000000001",
    book_id: ADMIN_BOOK_ID,
    page_id: null,
    scope: "BOOK",
    status: "REVIEWED",
    source_name: "NXB Kiểm thử",
    rights_holder: "Tác giả kiểm thử",
    usage_basis: "WRITTEN_LICENSE",
    evidence_url: "https://example.test/license",
    evidence_reference: "HD-2026",
    notes: "Đã xác minh giấy phép.",
    source_fingerprint: "f".repeat(64),
    profile_version: 1,
    reference_check_status: "NO_MATCH_IN_ALLOWED_CORPUS",
    reference_check_evidence: [],
    reviewed_by: "10000000-0000-4000-8000-000000000002",
    reviewed_by_name: "Admin ViRead",
    reviewed_at: "2026-11-21T00:00:00Z",
    history: [],
    updated_at: "2026-11-21T00:00:00Z",
    ...overrides,
  };
}

function makeBookSummary(
  assessment: BookApprovalAssessmentDTO,
  overrides: Partial<BookQualityBookSummaryDTO> = {},
): BookQualityBookSummaryDTO {
  return {
    book_id: ADMIN_BOOK_ID,
    book_title: "Truyện đọc lớp 3",
    report_count: 1,
    open_report_count: 1,
    open_safety_report_count: 1,
    finding_count: assessment.finding_count,
    needs_review_finding_count: 0,
    verified_page_count: assessment.ocr_completed_pages,
    issue_page_count: 1,
    has_missing_content: assessment.missing_page_numbers.length > 0,
    has_safety_alerts: assessment.finding_count > 0,
    has_missing_rights: assessment.rights_profile_status !== "REVIEWED",
    ready_for_approval: assessment.blockers.length === 0,
    latest_scan: null,
    assessment,
    ...overrides,
  };
}

function makeBookDetail(
  assessment: BookApprovalAssessmentDTO,
  overrides: Partial<BookQualityBookDetailDTO> = {},
): BookQualityBookDetailDTO {
  return {
    book_id: ADMIN_BOOK_ID,
    book_title: "Truyện đọc lớp 3",
    expected_page_count: assessment.expected_page_count,
    reports: [],
    scans: [],
    latest_scan_detail: null,
    ai_workflows: [],
    ai_workflow_summary: {},
    rights_profile: makeRightsProfile({
      status: assessment.rights_profile_status,
    }),
    page_rights_overrides: [],
    pages: [
      {
        page_id: ADMIN_PAGE_ID,
        page_number: 1,
        lifecycle_status: "ACTIVE",
        content_type: "CONTENT",
        current_verified_revision_id: ADMIN_R2_ID,
        latest_revision_id: ADMIN_R2_ID,
        verification_status: "VERIFIED",
        content_issues: [],
        proofreading_status: "COMPLETED",
        uncertain_word_count: 0,
        safety_status: "CONFIRMED",
        safety_suitability: "SUITABLE",
        safety_finding_count: 0,
        high_finding_count: 0,
        image_safety_status: "NOT_REVIEWED",
        rights_status: assessment.rights_profile_status,
        has_rights_override: false,
        open_report_count: 0,
        latest_workflow_id: null,
        has_issues: false,
      },
      {
        page_id: PAGE_2_ID,
        page_number: 3,
        lifecycle_status: "ACTIVE",
        content_type: "CONTENT",
        current_verified_revision_id: null,
        latest_revision_id: ADMIN_R2_ID,
        verification_status: "NEEDS_REVIEW",
        content_issues: ["NEEDS_VERIFICATION", "EMPTY_OCR"],
        proofreading_status: "NOT_STARTED",
        uncertain_word_count: 0,
        safety_status: "NOT_STARTED",
        safety_suitability: null,
        safety_finding_count: 0,
        high_finding_count: 0,
        image_safety_status: "NOT_REVIEWED",
        rights_status: "NOT_ASSESSED",
        has_rights_override: true,
        open_report_count: 1,
        latest_workflow_id: null,
        has_issues: true,
      },
    ],
    assessment,
    decision_history: [],
    ...overrides,
  };
}

describe("AdminBookContentQualityScreen redesigned workspaces", () => {
  it("supports 5 book filters, 3 detail sections, issue-only page filter, exact page links, and requires REVIEWED rights to approve", async () => {
    const services = createAdminServiceFixture();
    const readyAssessment = makeAssessment();
    vi.mocked(services.bookContentQuality.listReports).mockResolvedValue({
      items: [],
      total: 0,
      summary: { OPEN: 0, UNDER_REVIEW: 0, OPEN_SAFETY: 0 },
      limit: 10,
      offset: 0,
    });
    vi.mocked(services.bookContentQuality.listBooks).mockResolvedValue({
      items: [makeBookSummary(readyAssessment)],
      total: 1,
      limit: 10,
      offset: 0,
      summary: { READY_FOR_CHILDREN: 1 },
      alert_summary: { CHILD_SAFETY: 0, COPYRIGHT: 0, BOTH: 0 },
      issue_filter_summary: {
        MISSING_CONTENT: 0,
        SAFETY_ALERTS: 0,
        MISSING_RIGHTS: 0,
        OPEN_REPORTS: 1,
        READY_FOR_APPROVAL: 1,
      },
    });
    vi.mocked(services.bookContentQuality.getBook).mockResolvedValue(
      makeBookDetail(readyAssessment),
    );
    vi.mocked(services.bookContentQuality.decideBook).mockResolvedValue({
      book_id: ADMIN_BOOK_ID,
      assessment: {
        ...readyAssessment,
        status: "APPROVED_BY_ADMIN",
        rights_confirmed: true,
      },
      decision_history: [],
    });

    const user = userEvent.setup();
    render(withAdminFixture(<AdminBookContentQualityScreen />, services));

    // Verify 2 workspace tabs
    expect(
      screen.getByRole("tab", { name: /Tình trạng sách/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("tab", { name: /Báo cáo phụ huynh/ }),
    ).toBeInTheDocument();

    // Verify book row & 5 quick issue filters
    expect(
      await screen.findByRole("heading", { name: "Truyện đọc lớp 3", level: 3 }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Thiếu hồ sơ quyền/ }),
    );
    await waitFor(() =>
      expect(services.bookContentQuality.listBooks).toHaveBeenCalledWith(
        expect.objectContaining({ issue_filter: "MISSING_RIGHTS" }),
      ),
    );

    // Open book detail -> verify 3 clean sections
    await user.click(screen.getByRole("button", { name: "Xem chi tiết" }));
    const detail = await screen.findByTestId("book-quality-detail");
    expect(
      within(detail).getByRole("heading", { name: "1. Nội dung và trang" }),
    ).toBeInTheDocument();
    expect(
      within(detail).getByRole("heading", {
        name: "2. An toàn cho trẻ và Quyền sử dụng nội dung",
      }),
    ).toBeInTheDocument();
    expect(
      within(detail).getByRole("heading", { name: "3. Lịch sử kiểm tra" }),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText("Chưa có số trang nguồn để đối chiếu."),
    ).toBeInTheDocument();

    // Toggle issue-only pages filter
    expect(within(detail).getByText("Trang 1")).toBeInTheDocument();
    expect(within(detail).getByText("Trang 3")).toBeInTheDocument();
    await user.click(
      within(detail).getByLabelText(/Chỉ hiện trang có vấn đề/),
    );
    expect(within(detail).queryByText("Trang 1")).not.toBeInTheDocument();
    expect(within(detail).getByText("Trang 3")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: "Mở trang" })).toHaveAttribute(
      "href",
      `/admin/books/${ADMIN_BOOK_ID}/pages/${PAGE_2_ID}?revisionId=${ADMIN_R2_ID}`,
    );

    // Approve book with reason (rights already REVIEWED)
    await user.type(
      within(detail).getByRole("textbox", {
        name: /Lý do \/ ghi chú quyết định/,
      }),
      "Đủ điều kiện duyệt.",
    );
    await user.click(
      within(detail).getByRole("button", { name: "Phê duyệt toàn bộ sách" }),
    );
    await waitFor(() => {
      expect(services.bookContentQuality.decideBook).toHaveBeenCalledWith(
        ADMIN_BOOK_ID,
        {
          decision: "APPROVE",
          reason: "Đủ điều kiện duyệt.",
          rights_confirmed: true,
        },
      );
      expect(services.bookContentQuality.enqueueScan).not.toHaveBeenCalled();
    });
  }, 15000);

  it("blocks book approval when rights profile is missing and warns on legacy published books and missing page gaps", async () => {
    const services = createAdminServiceFixture();
    const blockedAssessment = makeAssessment({
      status: "PENDING_ADMIN_REVIEW",
      rights_profile_status: "NOT_ASSESSED",
      legacy_published_needs_rights_review: true,
      missing_page_numbers: [2],
      empty_ocr_page_numbers: [3],
      blockers: [
        "Hồ sơ quyền sử dụng nội dung đang ở trạng thái NOT_ASSESSED.",
        "Nghi thiếu trang số: 2.",
      ],
    });
    vi.mocked(services.bookContentQuality.listReports).mockResolvedValue({
      items: [],
      total: 0,
      summary: {},
      limit: 10,
      offset: 0,
    });
    vi.mocked(services.bookContentQuality.listBooks).mockResolvedValue({
      items: [makeBookSummary(blockedAssessment)],
      total: 1,
      limit: 10,
      offset: 0,
      summary: {},
      alert_summary: {},
      issue_filter_summary: {},
    });
    vi.mocked(services.bookContentQuality.getBook).mockResolvedValue(
      makeBookDetail(blockedAssessment),
    );

    const user = userEvent.setup();
    render(withAdminFixture(<AdminBookContentQualityScreen />, services));

    await user.click(await screen.findByRole("button", { name: "Xem chi tiết" }));
    const detail = await screen.findByTestId("book-quality-detail");
    expect(
      within(detail).getByText(/Sách xuất bản theo phiên bản cũ/),
    ).toBeInTheDocument();
    expect(
      within(detail).getAllByText(/Nghi thiếu trang số: 2/).length,
    ).toBeGreaterThanOrEqual(1);

    await user.type(
      within(detail).getByRole("textbox", {
        name: /Lý do \/ ghi chú quyết định/,
      }),
      "Cố duyệt khi chưa có hồ sơ quyền",
    );
    expect(
      within(detail).getByRole("button", { name: "Phê duyệt toàn bộ sách" }),
    ).toBeDisabled();

    // Admin can run local overlap check & save rights profile
    await user.click(
      within(detail).getByRole("button", { name: "Kiểm tra trùng lặp nội bộ" }),
    );
    await waitFor(() =>
      expect(
        services.bookContentQuality.runRightsOverlapCheck,
      ).toHaveBeenCalledWith(ADMIN_BOOK_ID),
    );
  });

  it("displays parent reports inbox with book/page scope, safety priority, snapshot, changed-revision warning, and status updates", async () => {
    const services = createAdminServiceFixture();
    const reportDetail: BookContentReportDetailDTO = {
      id: REPORT_ID,
      book_id: ADMIN_BOOK_ID,
      book_title: "Truyện đọc lớp 3",
      reporter_id: "20000000-0000-4000-8000-000000000001",
      reporter_name: "Phụ huynh Lan",
      page_id: ADMIN_PAGE_ID,
      page_number: 2,
      page_revision_id: ADMIN_R2_ID,
      current_page_revision_id: "84000000-0000-4000-8000-000000000099",
      page_revision_changed: true,
      issue_type: "CHILD_UNSAFE_CONTENT",
      description: "Đoạn cuối trang 2 có từ ngữ không phù hợp cho trẻ lớp 1.",
      reported_text: "Đoạn nhạy cảm",
      suggested_correction: null,
      status: "OPEN",
      scan_run_id: null,
      verified_text_snapshot: "Văn bản chụp tại thời điểm phụ huynh gửi báo cáo.",
      content_hash_snapshot: "b".repeat(64),
      admin_resolution_note: null,
      reviewed_by: null,
      reviewed_by_name: null,
      resolved_at: null,
      history: [
        {
          actor_name: "Phụ huynh Lan",
          from_status: null,
          to_status: "OPEN",
          note: "Báo cáo mới",
          created_at: "2026-11-21T01:00:00Z",
        },
      ],
      related_findings: [],
      created_at: "2026-11-21T01:00:00Z",
      updated_at: "2026-11-21T01:00:00Z",
    };

    vi.mocked(services.bookContentQuality.listBooks).mockResolvedValue({
      items: [],
      total: 0,
      limit: 10,
      offset: 0,
      summary: {},
      alert_summary: {},
      issue_filter_summary: {},
    });
    vi.mocked(services.bookContentQuality.listReports).mockResolvedValue({
      items: [reportDetail],
      total: 1,
      summary: { OPEN: 1, UNDER_REVIEW: 0, RESOLVED: 0, REJECTED: 0, OPEN_SAFETY: 1 },
      limit: 10,
      offset: 0,
    });
    vi.mocked(services.bookContentQuality.getReport).mockResolvedValue(
      reportDetail,
    );
    vi.mocked(services.bookContentQuality.updateReportStatus).mockResolvedValue({
      ...reportDetail,
      status: "RESOLVED",
      admin_resolution_note: "Đã sửa nội dung trang 2 và xác minh lại.",
      history: [
        ...reportDetail.history,
        {
          actor_name: "Admin ViRead",
          from_status: "OPEN",
          to_status: "RESOLVED",
          note: "Đã sửa nội dung trang 2 và xác minh lại.",
          created_at: "2026-11-21T02:00:00Z",
        },
      ],
    });

    const user = userEvent.setup();
    render(withAdminFixture(<AdminBookContentQualityScreen />, services));

    await user.click(
      await screen.findByRole("tab", { name: /Báo cáo phụ huynh/ }),
    );

    expect(await screen.findByText("Ưu tiên an toàn")).toBeInTheDocument();
    expect(screen.getByText("Cấp trang · Trang 2")).toBeInTheDocument();

    // Filter by scope
    await user.selectOptions(screen.getByLabelText("Phạm vi báo cáo"), "PAGE");
    await waitFor(() =>
      expect(services.bookContentQuality.listReports).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "PAGE" }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Xem chi tiết" }));
    const detail = await screen.findByTestId("parent-report-detail");
    expect(
      within(detail).getByText(/Nội dung trang đã thay đổi/),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText(
        "Văn bản chụp tại thời điểm phụ huynh gửi báo cáo.",
      ),
    ).toBeInTheDocument();
    expect(
      within(detail).getByRole("link", { name: "Mở trang được báo" }),
    ).toHaveAttribute(
      "href",
      `/admin/books/${ADMIN_BOOK_ID}/pages/${ADMIN_PAGE_ID}?revisionId=${ADMIN_R2_ID}`,
    );

    await user.type(
      within(detail).getByLabelText("Lý do / ghi chú xử lý của Admin"),
      "Đã sửa nội dung trang 2 và xác minh lại.",
    );
    await user.click(within(detail).getByRole("button", { name: "Đã xử lý" }));
    await waitFor(() =>
      expect(
        services.bookContentQuality.updateReportStatus,
      ).toHaveBeenCalledWith(
        REPORT_ID,
        "RESOLVED",
        "Đã sửa nội dung trang 2 và xác minh lại.",
      ),
    );
  });

  it("renders forbidden and empty states cleanly", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.bookContentQuality.listBooks).mockRejectedValue(
      new ServiceError({
        code: "FORBIDDEN",
        message: "Forbidden",
        status: 403,
        request_id: "req-403",
        retryable: false,
      }),
    );
    vi.mocked(services.bookContentQuality.listReports).mockResolvedValue({
      items: [],
      total: 0,
      summary: {},
      limit: 10,
      offset: 0,
    });

    const user = userEvent.setup();
    render(withAdminFixture(<AdminBookContentQualityScreen />, services));

    expect(
      await screen.findByText("Tài khoản hiện tại không có quyền Admin."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Báo cáo phụ huynh/ }));
    expect(
      await screen.findByText("Không có báo cáo phù hợp"),
    ).toBeInTheDocument();
  });
});
