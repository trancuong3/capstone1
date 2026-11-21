import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminBookContentQualityScreen } from "@/components/admin/admin-book-content-quality-screen";
import {
  ADMIN_BOOK_ID,
  ADMIN_PAGE_ID,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type { BookQualityBookDetailDTO } from "@/types/book-content-quality";

const createdAt = "2026-11-21T08:00:00Z";

function makeBookDetail(
  overrides: Partial<BookQualityBookDetailDTO> = {},
): BookQualityBookDetailDTO {
  return {
    book_id: ADMIN_BOOK_ID,
    book_title: "Chú Mèo Nhỏ Đi Học",
    reports: [],
    scans: [],
    latest_scan_detail: null,
    ai_workflows: [],
    ai_workflow_summary: {
      pages_total: 2,
      workflows_total: 2,
      pages_with_workflow: 2,
      pages_without_workflow: 0,
      proofreading_completed: 2,
      safety_completed: 2,
      safety_stale: 0,
      safety_unscanned: 0,
      active: 0,
      ready_for_review: 2,
      failed: 0,
      needs_admin_review: 0,
      finding_count: 0,
    },
    assessment: {
      status: "PENDING_ADMIN_REVIEW",
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
      copyright_status: "UNASSESSED",
      copyright_finding_count: 0,
      finding_count: 0,
      high_finding_count: 0,
      medium_finding_count: 0,
      warning_page_count: 0,
      failed_or_unscanned_page_count: 0,
      finding_groups: [],
      assessment_hash: "a".repeat(64),
      assessed_at: createdAt,
      admin_approved_at: null,
      admin_approved_by: null,
      admin_approved_by_name: null,
      admin_reason: null,
      publication_source: null,
      rights_confirmed: false,
      blockers: ["RIGHTS_UNASSESSED"],
    },
    rights_evidence: {
      id: null,
      book_id: ADMIN_BOOK_ID,
      page_id: null,
      scope: "BOOK",
      status: "UNASSESSED",
      effective_status: "UNASSESSED",
      is_stale: false,
      source_description: null,
      author_or_rights_holder: null,
      usage_basis: null,
      evidence_url_or_ref: null,
      notes: null,
      version: 0,
      content_fingerprint: null,
      current_content_fingerprint: "b".repeat(64),
      reviewed_by: null,
      reviewed_by_name: null,
      reviewed_at: null,
      updated_at: null,
      history: [],
    },
    page_diagnostics: [
      {
        page_id: ADMIN_PAGE_ID,
        page_number: 1,
        lifecycle_status: "ACTIVE",
        verification_status: "NEEDS_REVIEW",
        codes: ["EMPTY_OCR", "UNVERIFIED_PAGE"],
        image_safety_status: "UNASSESSED_NO_VISION_MODEL",
        text_safety_status: "PENDING",
        summary: "Chưa có văn bản OCR. Trang chưa được Admin xác minh.",
      },
      {
        page_id: null,
        page_number: 2,
        lifecycle_status: null,
        verification_status: null,
        codes: ["SUSPECTED_MISSING_PAGE"],
        summary:
          "Nghi ngờ thiếu trang số 2 trong dãy trang đã tải lên (không khẳng định tổng số trang bản in gốc).",
      },
    ],
    completeness_disclaimer:
      "Hệ thống chỉ kiểm tra các trang đã tải lên; chưa thể khẳng định đủ số trang so với bản in gốc nếu chưa khai báo tổng số trang gốc.",
    decision_history: [],
    ...overrides,
  };
}

describe("AdminBookContentQualityScreen rights evidence, diagnostics, and reports", () => {
  it("locks book approval until rights evidence is RIGHTS_REVIEWED and saves versioned rights evidence", async () => {
    const services = createAdminServiceFixture();
    const initialDetail = makeBookDetail();
    const reviewedDetail = makeBookDetail({
      assessment: {
        ...initialDetail.assessment,
        status: "READY_FOR_CHILDREN",
        copyright_status: "RIGHTS_REVIEWED",
        rights_confirmed: true,
        blockers: [],
      },
      rights_evidence: {
        ...initialDetail.rights_evidence!,
        id: "77000000-0000-4000-8000-000000000001",
        status: "RIGHTS_REVIEWED",
        effective_status: "RIGHTS_REVIEWED",
        source_description: "Thư viện giáo dục mở",
        usage_basis: "OPEN_LICENSE",
        evidence_url_or_ref: "https://open.example.org/license",
        version: 1,
        reviewed_by_name: "Admin QA",
        reviewed_at: createdAt,
      },
    });

    services.bookContentQuality.listReports.mockResolvedValue({
      items: [
        {
          id: "88000000-0000-4000-8000-000000000001",
          book_id: ADMIN_BOOK_ID,
          book_title: "Chú Mèo Nhỏ Đi Học",
          reporter_name: "Phụ huynh A",
          page_id: ADMIN_PAGE_ID,
          page_number: 1,
          page_revision_id: null,
          issue_type: "CHILD_SAFETY_CONCERN",
          description: "Có câu thoại nhạy cảm ở trang 1.",
          reported_text: null,
          suggested_correction: null,
          status: "OPEN",
          scan_run_id: null,
          created_at: createdAt,
          updated_at: createdAt,
        },
      ],
      total: 1,
      summary: { OPEN: 1 },
      limit: 10,
      offset: 0,
    });
    services.bookContentQuality.listBooks.mockResolvedValue({
      items: [
        {
          book_id: ADMIN_BOOK_ID,
          book_title: "Chú Mèo Nhỏ Đi Học",
          report_count: 1,
          open_report_count: 1,
          finding_count: 0,
          needs_review_finding_count: 0,
          latest_scan: null,
          assessment: initialDetail.assessment,
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
      summary: { PENDING_ADMIN_REVIEW: 1 },
      alert_summary: { CHILD_SAFETY: 0, COPYRIGHT: 0, BOTH: 0 },
    });
    services.bookContentQuality.getBook
      .mockResolvedValueOnce(initialDetail)
      .mockResolvedValueOnce(reviewedDetail);
    services.bookContentQuality.upsertBookRights = vi
      .fn()
      .mockResolvedValue(reviewedDetail.rights_evidence!);

    const user = userEvent.setup();
    render(withAdminFixture(<AdminBookContentQualityScreen />, services));

    // Parent report with CHILD_SAFETY_CONCERN is displayed
    expect(
      await screen.findByText(/Nội dung có dấu hiệu không phù hợp cho trẻ em/i),
    ).toBeInTheDocument();

    // Open book detail
    await user.click(
      await screen.findByRole("button", { name: "Xem kết quả" }),
    );

    const rightsPanel = await screen.findByTestId("book-rights-panel");
    expect(
      within(rightsPanel).getByTestId("book-rights-status"),
    ).toHaveTextContent(/Chưa rà soát quyền sử dụng/i);

    // Page diagnostics and physical completeness disclaimer render cleanly
    const diagnostics = screen.getByTestId("book-page-diagnostics");
    expect(
      within(diagnostics).getByText(/chưa thể khẳng định đủ số trang/i),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText(/Nghi thiếu trang/i),
    ).toBeInTheDocument();

    // Approve button stays disabled without rights_confirmed even when reason is entered
    await user.type(
      screen.getByLabelText(/Lý do \/ ghi chú quyết định/i),
      "Kiểm tra phê duyệt",
    );
    const approveBtn = screen.getByRole("button", {
      name: /Phê duyệt toàn bộ sách/i,
    });
    expect(approveBtn).toBeDisabled();

    // Fill Rights Evidence as RIGHTS_REVIEWED
    await user.selectOptions(
      within(rightsPanel).getByLabelText(/Trạng thái quyền sử dụng/i),
      "RIGHTS_REVIEWED",
    );
    const saveRightsBtn = within(rightsPanel).getByRole("button", {
      name: /Lưu hồ sơ quyền sử dụng/i,
    });
    expect(saveRightsBtn).toBeDisabled();

    await user.click(within(rightsPanel).getByLabelText(/Cơ sở sử dụng/i));
    await user.paste("OPEN_LICENSE");
    await user.click(within(rightsPanel).getByLabelText(/Nguồn tài liệu/i));
    await user.paste("Thư viện giáo dục mở");
    await user.click(
      within(rightsPanel).getByLabelText(/Đường dẫn \/ Mã hồ sơ bằng chứng/i),
    );
    await user.paste("https://open.example.org/license");
    expect(saveRightsBtn).toBeEnabled();
    await user.click(saveRightsBtn);

    await waitFor(() => {
      expect(services.bookContentQuality.upsertBookRights).toHaveBeenCalledWith(
        ADMIN_BOOK_ID,
        expect.objectContaining({
          scope: "BOOK",
          status: "RIGHTS_REVIEWED",
          usage_basis: "OPEN_LICENSE",
          source_description: "Thư viện giáo dục mở",
          evidence_url_or_ref: "https://open.example.org/license",
        }),
      );
    });
    expect(approveBtn).toBeEnabled();
  }, 15_000);
});
