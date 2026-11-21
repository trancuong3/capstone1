import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminBookContentQualityScreen } from "@/components/admin/admin-book-content-quality-screen";
import {
  ADMIN_BOOK_ID,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";

const assessment = {
  status: "READY_FOR_CHILDREN" as const,
  page_count: 1,
  ocr_completed_pages: 1,
  ocr_approval_valid_pages: 1,
  proofreading_status: "COMPLETED",
  proofreading_completed_pages: 1,
  proofreading_suggestion_count: 0,
  child_safety_status: "COMPLETED",
  child_safety_completed_pages: 1,
  processing_pages: 0,
  failed_pages: 0,
  stale_pages: 0,
  copyright_status: "NOT_CONFIGURED",
  copyright_finding_count: null,
  finding_count: 0,
  high_finding_count: 0,
  medium_finding_count: 0,
  warning_page_count: 0,
  failed_or_unscanned_page_count: 0,
  finding_groups: [],
  assessment_hash: "a".repeat(64),
  assessed_at: "2026-11-18T00:00:00Z",
  admin_approved_at: null,
  admin_approved_by: null,
  admin_approved_by_name: null,
  admin_reason: null,
  publication_source: null,
  rights_confirmed: false,
  blockers: [],
};

describe("book-level approval dashboard", () => {
  it("allows approval without Copyright confirmation and does not start another scan", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.bookContentQuality.listReports).mockResolvedValue({
      items: [],
      total: 0,
      summary: {},
      limit: 10,
      offset: 0,
    });
    vi.mocked(services.bookContentQuality.listBooks).mockResolvedValue({
      items: [
        {
          book_id: ADMIN_BOOK_ID,
          book_title: "Truyện đọc lớp 3",
          report_count: 0,
          open_report_count: 0,
          finding_count: 0,
          needs_review_finding_count: 0,
          latest_scan: null,
          assessment,
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
      summary: { PENDING_ADMIN_REVIEW: 1 },
      alert_summary: { CHILD_SAFETY: 0, COPYRIGHT: 0, BOTH: 0 },
    });
    vi.mocked(services.bookContentQuality.getBook).mockResolvedValue({
      book_id: ADMIN_BOOK_ID,
      book_title: "Truyện đọc lớp 3",
      reports: [],
      scans: [],
      latest_scan_detail: null,
      ai_workflows: [],
      ai_workflow_summary: {},
      assessment,
      decision_history: [],
    });
    vi.mocked(services.bookContentQuality.decideBook).mockResolvedValue({
      book_id: ADMIN_BOOK_ID,
      assessment: {
        ...assessment,
        status: "APPROVED_BY_ADMIN",
        copyright_status: "NOT_CONFIGURED",
        rights_confirmed: false,
      },
      decision_history: [],
    });
    const user = userEvent.setup();

    render(withAdminFixture(<AdminBookContentQualityScreen />, services));

    expect(
      await screen.findByRole("heading", {
        name: "Truyện đọc lớp 3",
        level: 3,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        /0 Child Safety findings.*Copyright chưa có scanner tự động/,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Xem kết quả" }));
    expect(
      await screen.findByText(
        /Copyright hiện tạm thời chưa tham gia quyết định/,
      ),
    ).toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: "Lý do / ghi chú quyết định" }),
      "Đã kiểm tra hồ sơ quyền sử dụng.",
    );
    await user.click(
      screen.getByRole("button", { name: "Phê duyệt toàn bộ sách" }),
    );

    await waitFor(() => {
      expect(services.bookContentQuality.decideBook).toHaveBeenCalledWith(
        ADMIN_BOOK_ID,
        {
          decision: "APPROVE",
          reason: "Đã kiểm tra hồ sơ quyền sử dụng.",
          rights_confirmed: false,
          category: undefined,
        },
      );
      expect(services.bookContentQuality.enqueueScan).not.toHaveBeenCalled();
    });
  });
});
