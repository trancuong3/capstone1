import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminAuditScreen } from "@/components/admin/admin-audit-screen";
import { AdminBookContentQualityScreen } from "@/components/admin/admin-book-content-quality-screen";
import { AdminBookDetailScreen } from "@/components/admin/admin-book-detail-screen";
import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { AdminFlow2CandidatesPanel } from "@/components/admin/admin-flow2-candidates-panel";
import { AdminParentDetailScreen } from "@/components/admin/admin-parent-detail-screen";
import { AdminUserBooksQualitySection } from "@/components/admin/admin-user-books-quality-section";
import {
  ADMIN_BOOK_ID,
  ADMIN_PAGE_ID,
  ADMIN_R2_ID,
  adminBookListItemFixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type { AdminOcrJobDTO } from "@/lib/api/admin-page-service";
import type { AdminPageListItemUI, AuditLogDTO } from "@/types/admin";
import type { BookQualityBookDetailDTO } from "@/types/book-content-quality";
import type {
  AdminFlow2CandidatePageDTO,
  AdminUserBookQueueItemDTO,
  AdminUserBookSubmissionDetailDTO,
} from "@/types/parent-private-book";

vi.mock("@/lib/api/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/api-client")>();
  return {
    ...actual,
    fetchAuthenticatedBlobUrl: vi.fn(async () => "blob:admin-pagination-test"),
    revokePrivateBlobUrl: vi.fn(),
  };
});

const NOW = "2026-11-21T08:00:00Z";

function makeUuid(prefix: string, index: number): string {
  return `${prefix}0000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("Admin screens bounded pagination", () => {
  it("paginates AdminBooksScreen at 10 books per page and resets to page 1 on filter changes", async () => {
    const services = createAdminServiceFixture();
    const books = Array.from({ length: 14 }, (_, idx) => {
      const n = idx + 1;
      return {
        ...adminBookListItemFixture,
        book: {
          ...adminBookListItemFixture.book,
          id: makeUuid("1000", n),
          title: `Cuốn sách kiểm thử ${String(n).padStart(2, "0")}`,
          name: `Tập ${n}`,
        },
        parent_catalog_eligible: n <= 3,
      };
    });
    services.books.list.mockResolvedValue(books);

    const user = userEvent.setup();
    render(withAdminFixture(<AdminBooksScreen />, services));

    expect(
      await screen.findByRole("heading", { name: "Cuốn sách kiểm thử 01" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Cuốn sách kiểm thử 10" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Cuốn sách kiểm thử 11" }),
    ).not.toBeInTheDocument();

    const nextButtons = screen.getAllByRole("button", { name: "Tiếp" });
    await user.click(nextButtons[0]);

    expect(
      await screen.findByRole("heading", { name: "Cuốn sách kiểm thử 11" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Cuốn sách kiểm thử 14" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Cuốn sách kiểm thử 01" }),
    ).not.toBeInTheDocument();

    // Filtering via KPI card resets back to page 1 safely
    await user.click(screen.getByTestId("books-kpi-eligible"));
    expect(
      await screen.findByRole("heading", { name: "Cuốn sách kiểm thử 01" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Cuốn sách kiểm thử 11" }),
    ).not.toBeInTheDocument();
  });

  it("paginates AdminBookDetailScreen pages at 12 per page and queued OCR jobs at 5 per page", async () => {
    const services = createAdminServiceFixture();
    const pages: AdminPageListItemUI[] = Array.from(
      { length: 16 },
      (_, idx) => {
        const n = idx + 1;
        return {
          book_id: ADMIN_BOOK_ID,
          page_number: n,
          processing: {
            page_id: makeUuid("2000", n),
            page_revision_id: makeUuid("3000", n),
            revision_no: 1,
            verification_status: "VERIFIED",
            lifecycle_status: "ACTIVE",
            ocr_preview_metadata: {},
            verified_at: NOW,
            current_verified_revision_id: makeUuid("3000", n),
          },
          text_preview: `Nội dung trang ${n}`,
        };
      },
    );
    const queuedJobs: AdminOcrJobDTO[] = Array.from({ length: 7 }, (_, idx) => {
      const n = idx + 1;
      return {
        id: makeUuid("4000", n),
        book_id: ADMIN_BOOK_ID,
        page_id: null,
        job_kind: "ADMIN_PAGE_UPLOAD",
        status: "QUEUED",
        worker_online: false,
        file_name: `queued-page-${n}.png`,
        queue_position: n,
        created_at: NOW,
        updated_at: NOW,
        completed_at: null,
        error_message: null,
      } as AdminOcrJobDTO;
    });
    services.pages.list.mockResolvedValue(pages);
    const listOcrJobs = vi.fn().mockResolvedValue(queuedJobs);
    const customServices = {
      ...services,
      pages: {
        ...services.pages,
        listOcrJobs,
      },
    };

    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminBookDetailScreen bookId={ADMIN_BOOK_ID} />,
        customServices,
      ),
    );

    expect(
      await screen.findByRole("heading", { name: "Trang 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Trang 12" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Trang 13" }),
    ).not.toBeInTheDocument();

    // Queued jobs banner paginates at 5 per page
    const queueBanner = screen.getByTestId("admin-book-ocr-queue-banner");
    expect(
      within(queueBanner).getByTestId(
        `admin-queued-new-page-row-${makeUuid("4000", 1)}`,
      ),
    ).toBeInTheDocument();
    expect(
      within(queueBanner).queryByTestId(
        `admin-queued-new-page-row-${makeUuid("4000", 6)}`,
      ),
    ).not.toBeInTheDocument();
    await user.click(within(queueBanner).getByRole("button", { name: "Tiếp" }));
    expect(
      within(queueBanner).getByTestId(
        `admin-queued-new-page-row-${makeUuid("4000", 6)}`,
      ),
    ).toBeInTheDocument();

    // Book pages pagination moves to page 2 (pages 13..16)
    const pagesNavs = screen.getAllByRole("navigation", {
      name: /Điều hướng danh sách/i,
    });
    const bookPagesNav = pagesNavs[0];
    await user.click(
      within(bookPagesNav).getByRole("button", { name: "Tiếp" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Trang 13" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Trang 16" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Trang 1" }),
    ).not.toBeInTheDocument();
  });

  it("paginates AdminParentDetailScreen linked children at 6 per page", async () => {
    const services = createAdminServiceFixture();
    const parentId = makeUuid("5000", 1);
    services.parents.getById.mockResolvedValue({
      id: parentId,
      display_name: "Phụ huynh Đông Con",
      email: "family@example.com",
      phone: "0901234567",
      created_at: NOW,
      contact_info_status: "available",
      children: Array.from({ length: 9 }, (_, idx) => ({
        id: makeUuid("6000", idx + 1),
        alias: `Bé Số ${idx + 1}`,
        grade: (idx % 5) + 1,
        created_at: NOW,
      })),
    });

    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminParentDetailScreen parentId={parentId} />,
        services,
      ),
    );

    expect(
      await screen.findByRole("heading", { name: "Bé Số 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Bé Số 6" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Bé Số 7" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tiếp" }));

    expect(
      await screen.findByRole("heading", { name: "Bé Số 7" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Bé Số 9" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Bé Số 1" }),
    ).not.toBeInTheDocument();
  });

  it("paginates AdminAuditScreen at 10 events per page when loading multiple batches", async () => {
    const services = createAdminServiceFixture();
    const makeAuditBatch = (start: number, count: number): AuditLogDTO[] =>
      Array.from({ length: count }, (_, idx) => {
        const n = start + idx;
        return {
          id: makeUuid("7000", n),
          actor_id: null,
          resource_id: null,
          action: `book.action_${String(n).padStart(2, "0")}`,
          resource_type: "book",
          request_id: null,
          created_at: NOW,
          metadata: {},
        };
      });

    services.audit.list
      .mockResolvedValueOnce({
        items: makeAuditBatch(1, 10),
        next_cursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        items: makeAuditBatch(11, 5),
        next_cursor: null,
      });

    const user = userEvent.setup();
    render(withAdminFixture(<AdminAuditScreen />, services));

    expect(await screen.findByText("book.action_01")).toBeInTheDocument();
    expect(screen.getByText("book.action_10")).toBeInTheDocument();

    // Load second batch -> auto-advances to page 2 without stretching page 1
    await user.click(screen.getByRole("button", { name: "Tải thêm" }));
    expect(await screen.findByText("book.action_11")).toBeInTheDocument();
    expect(screen.getByText("book.action_15")).toBeInTheDocument();
    expect(screen.queryByText("book.action_01")).not.toBeInTheDocument();

    // Navigate back to page 1 via PaginationBar
    await user.click(screen.getByRole("button", { name: "Trước" }));
    expect(await screen.findByText("book.action_01")).toBeInTheDocument();
    expect(screen.queryByText("book.action_11")).not.toBeInTheDocument();
  });

  it("paginates AdminUserBooksQualitySection queue at 10 and drawer findings/history at 5", async () => {
    const services = createAdminServiceFixture();
    const subId = makeUuid("8000", 1);
    const queueItem: AdminUserBookQueueItemDTO = {
      book_id: ADMIN_BOOK_ID,
      book_title: "Sách gia đình 1",
      book_author: "Gia đình A",
      owner_label: "Phụ huynh A",
      moderation_status: "ACTIVE",
      queue_status: "PENDING_ADMIN",
      pending_count: 1,
      flagged_count: 7,
      failed_count: 0,
      committed_page_count: 0,
      latest_submission_id: subId,
      latest_request_id: makeUuid("8100", 1),
      latest_submission_version: 1,
      latest_submitted_at: NOW,
      policy_blocked: false,
    };
    const detail: AdminUserBookSubmissionDetailDTO = {
      submission_id: subId,
      request_id: makeUuid("8100", 1),
      book_id: ADMIN_BOOK_ID,
      book_title: "Sách gia đình 1",
      book_author: "Gia đình A",
      book_moderation_status: "ACTIVE",
      book_suspended_reason: null,
      owner_label: "Phụ huynh A",
      source_file_name: "p1.png",
      source_format: "IMAGE",
      source_page_number: 1,
      batch_total_pages: 1,
      submission_version: 1,
      optimistic_lock_version: 1,
      snapshot_hash: "a".repeat(64),
      source_sha256: "b".repeat(64),
      image_width: 400,
      image_height: 300,
      image_url: "http://127.0.0.1:8000/test.png",
      workflow_status: "PENDING_ADMIN",
      workflow_status_label: "Chờ duyệt",
      request_status: "PENDING_ADMIN",
      ocr_status: "COMPLETED",
      ocr_text: "Nội dung OCR",
      ocr_error_code: null,
      is_image_only: false,
      proofread_status: "COMPLETED",
      proofread_text: "Nội dung OCR",
      proofread_suggestions: [],
      uncertain_word_indices: [],
      proofread_error_code: null,
      candidate_text: "Nội dung OCR",
      tool_check_status: "COMPLETED",
      tool_check_suitability: "REVIEW_REQUIRED",
      tool_check_scope: {
        modality: "TEXT_ONLY",
        covers_all_chunks: true,
        chunks_checked: 1,
        total_chunks: 1,
        image_visual_safety_checked: false,
        requires_admin_visual_review: false,
        copyright_scanner_status: "CLEAR",
        local_ai_enforced: true,
      },
      tool_check_findings: Array.from({ length: 7 }, (_, idx) => ({
        finding_id: `finding-${idx + 1}`,
        source: "OLLAMA_TEXT",
        category: "VIOLENCE",
        severity: "MEDIUM",
        content_type: "TEXT",
        excerpt: `Đoạn ${idx + 1}`,
        explanation: `Giải thích cảnh báo số ${idx + 1}`,
        recommendation: "Cần xem xét",
      })),
      tool_check_policy_blocked: false,
      tool_check_error_code: null,
      tool_check_workflow_id: null,
      provider_events: [],
      source_type: "OWNED_PHYSICAL_BOOK",
      source_type_label: "Sách giấy gia đình sở hữu",
      source_note: null,
      parent_request_note: null,
      can_approve: true,
      approve_blocked_reason: null,
      approved_snapshot_hash: null,
      approved_submission_version: null,
      admin_decision: null,
      admin_decision_reason: null,
      history: Array.from({ length: 7 }, (_, idx) => ({
        request_id: makeUuid("8200", idx + 1),
        submission_version: idx + 1,
        snapshot_hash: "a".repeat(64),
        status: "APPROVED",
        previous_status: "PENDING_ADMIN",
        parent_source_type: "OWNED_PHYSICAL_BOOK",
        parent_source_note: null,
        decided_by_label: "Admin",
        decision_reason: `Lý do lịch sử số ${idx + 1}`,
        parent_request_note: null,
        decided_at: NOW,
        created_at: NOW,
      })),
      created_at: NOW,
      updated_at: NOW,
    };

    vi.mocked(services.bookContentQuality.listUserBooks!).mockResolvedValue({
      items: [queueItem],
      total: 15,
      summary: { PENDING_ADMIN: 15 },
      limit: 10,
      offset: 0,
    });
    vi.mocked(
      services.bookContentQuality.getUserBookSubmission!,
    ).mockResolvedValue(detail);

    const user = userEvent.setup();
    render(withAdminFixture(<AdminUserBooksQualitySection />, services));

    await waitFor(() => {
      expect(services.bookContentQuality.listUserBooks).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 0 }),
      );
    });

    await user.click(
      await screen.findByRole("button", { name: "Mở để duyệt" }),
    );

    expect(
      await screen.findByText("Giải thích cảnh báo số 1"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Giải thích cảnh báo số 6"),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Lý do lịch sử số 1/)).toBeInTheDocument();
    expect(screen.queryByText(/Lý do lịch sử số 6/)).not.toBeInTheDocument();

    const drawer = screen.getByTestId("admin-drawer-panel");
    const drawerNextButtons = within(drawer).getAllByRole("button", {
      name: "Tiếp",
    });
    expect(drawerNextButtons.length).toBeGreaterThanOrEqual(2);

    await user.click(drawerNextButtons[0]);
    expect(
      await screen.findByText("Giải thích cảnh báo số 6"),
    ).toBeInTheDocument();

    await user.click(drawerNextButtons[1]);
    expect(await screen.findByText(/Lý do lịch sử số 6/)).toBeInTheDocument();
  });

  it("paginates AdminBookContentQualityScreen drawer diagnostics, AI workflows, and scan pages/findings", async () => {
    const services = createAdminServiceFixture();
    const scanId = makeUuid("9000", 1);
    const scanSummary: BookQualityBookDetailDTO["scans"][number] = {
      id: scanId,
      book_id: ADMIN_BOOK_ID,
      book_title: "Sách Chất Lượng Nhiều Trang",
      trigger_type: "MANUAL",
      scope: "BOOK",
      target_page_id: null,
      status: "COMPLETED",
      total_pages: 7,
      completed_pages: 7,
      skipped_pages: 0,
      failed_pages: 0,
      ai_completed_pages: 7,
      ai_unavailable_pages: 0,
      error_summary: null,
      started_at: NOW,
      created_at: NOW,
      completed_at: NOW,
    };
    const bookDetail: BookQualityBookDetailDTO = {
      book_id: ADMIN_BOOK_ID,
      book_title: "Sách Chất Lượng Nhiều Trang",
      reports: [],
      scans: [scanSummary],
      latest_scan_detail: {
        ...scanSummary,
        pages: Array.from({ length: 7 }, (_, idx) => ({
          id: makeUuid("9100", idx + 1),
          page_id: ADMIN_PAGE_ID,
          page_revision_id: ADMIN_R2_ID,
          page_number: idx + 1,
          page_lifecycle_status: "ACTIVE",
          content_hash: "d".repeat(64),
          status: "COMPLETED",
          rule_check_status: "COMPLETED",
          ai_analysis_status: "COMPLETED",
          rejected_ai_finding_count: 0,
          error_code: null,
          error_summary: null,
          findings:
            idx === 0
              ? Array.from({ length: 7 }, (__, fIdx) => ({
                  id: makeUuid("9200", fIdx + 1),
                  page_scan_id: makeUuid("9100", 1),
                  book_id: ADMIN_BOOK_ID,
                  page_id: ADMIN_PAGE_ID,
                  page_revision_id: ADMIN_R2_ID,
                  page_number: 1,
                  issue_type: "SPELLING_ERROR",
                  severity: "MEDIUM",
                  status: "NEEDS_REVIEW",
                  detection_source: "RULE",
                  original_excerpt: `Trích đoạn lỗi quét ${fIdx + 1}`,
                  excerpt_start: 0,
                  excerpt_end: 10,
                  explanation: `Mô tả lỗi quét ${fIdx + 1}`,
                  suggested_correction: null,
                  model_name: null,
                  confidence: null,
                  review_note: null,
                  created_at: NOW,
                }))
              : [],
        })),
      },
      ai_workflows: Array.from({ length: 7 }, (_, idx) => ({
        workflow_id: makeUuid("9300", idx + 1),
        page_id: ADMIN_PAGE_ID,
        book_id: ADMIN_BOOK_ID,
        page_revision_id: ADMIN_R2_ID,
        status: "READY_FOR_ADMIN_REVIEW",
        stage: "READY_FOR_ADMIN_REVIEW",
        progress: { completed_chunks: 1, total_chunks: 1 },
        attempts: 1,
        safety_status: "CONFIRMED",
        suitability: "SUITABLE",
        candidate_version: idx + 1,
        original_ocr_hash: "a".repeat(64),
        admin_input_hash: "b".repeat(64),
        proofread_text: "Nội dung mẫu",
        proofread_output_hash: "c".repeat(64),
        corrections: [],
        uncertain_word_indices: [],
        proofread_metadata: {},
        safety_metadata: {},
        candidate_text: "Nội dung mẫu",
        candidate_hash: "c".repeat(64),
        safety_input_hash: "c".repeat(64),
        hash_match: true,
        error_code: null,
        findings: [],
        provider_events: [],
        safety_history: [],
        candidate_history: [],
        review_history: [],
        ocr_approved_at: null,
        final_approved_text_hash: null,
        created_at: NOW,
        updated_at: NOW,
      })),
      ai_workflow_summary: {
        pages_total: 10,
        workflows_total: 7,
        pages_with_workflow: 7,
        pages_without_workflow: 3,
        proofreading_completed: 7,
        safety_completed: 7,
        safety_stale: 0,
        safety_unscanned: 0,
        active: 0,
        ready_for_review: 0,
        failed: 0,
        needs_admin_review: 0,
        finding_count: 7,
      },
      assessment: {
        status: "PENDING_ADMIN_REVIEW",
        page_count: 10,
        ocr_completed_pages: 10,
        ocr_approval_valid_pages: 10,
        proofreading_status: "COMPLETED",
        proofreading_completed_pages: 10,
        proofreading_suggestion_count: 0,
        child_safety_status: "COMPLETED",
        child_safety_completed_pages: 10,
        processing_pages: 0,
        failed_pages: 0,
        stale_pages: 0,
        copyright_status: "UNASSESSED",
        copyright_finding_count: 0,
        finding_count: 7,
        high_finding_count: 0,
        medium_finding_count: 7,
        warning_page_count: 1,
        failed_or_unscanned_page_count: 0,
        finding_groups: [],
        assessment_hash: "c".repeat(64),
        assessed_at: NOW,
        admin_approved_at: null,
        admin_approved_by: null,
        admin_approved_by_name: null,
        admin_reason: null,
        publication_source: null,
        rights_confirmed: false,
        blockers: [],
      },
      rights_evidence: null,
      page_diagnostics: Array.from({ length: 10 }, (_, idx) => ({
        page_id: makeUuid("9400", idx + 1),
        page_number: idx + 1,
        lifecycle_status: "ACTIVE",
        verification_status: "VERIFIED",
        codes: ["OK"],
        summary: `Chẩn đoán trang ${idx + 1}`,
      })),
      completeness_disclaimer: undefined,
      decision_history: [],
    };

    services.bookContentQuality.listBooks.mockResolvedValue({
      items: [
        {
          book_id: ADMIN_BOOK_ID,
          book_title: "Sách Chất Lượng Nhiều Trang",
          report_count: 0,
          open_report_count: 0,
          finding_count: 7,
          needs_review_finding_count: 7,
          latest_scan: bookDetail.scans[0],
          assessment: bookDetail.assessment,
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
      summary: { PENDING_ADMIN_REVIEW: 1 },
      alert_summary: { CHILD_SAFETY: 0, COPYRIGHT: 0, BOTH: 0 },
    });
    services.bookContentQuality.getBook.mockResolvedValue(bookDetail);

    const user = userEvent.setup();
    render(
      withAdminFixture(
        <AdminBookContentQualityScreen section="approval" />,
        services,
      ),
    );

    await user.click(
      await screen.findByRole("button", { name: "Xem kết quả" }),
    );

    // Diagnostics paginate at 8 per page
    const diagnosticsSection = await screen.findByTestId(
      "book-page-diagnostics",
    );
    expect(
      within(diagnosticsSection).getByText("Chẩn đoán trang 1"),
    ).toBeInTheDocument();
    expect(
      within(diagnosticsSection).queryByText("Chẩn đoán trang 9"),
    ).not.toBeInTheDocument();
    await user.click(
      within(diagnosticsSection).getByRole("button", { name: "Tiếp" }),
    );
    expect(
      within(diagnosticsSection).getByText("Chẩn đoán trang 9"),
    ).toBeInTheDocument();

    // AI workflows paginate at 5 per page (candidate_version 1..5 on page 1, 6..7 on page 2)
    expect(screen.getByText(/Phiên bản 1/)).toBeInTheDocument();
    expect(screen.queryByText(/Phiên bản 6/)).not.toBeInTheDocument();

    // Scan page findings paginate at 5 per page
    expect(screen.getByText("Mô tả lỗi quét 1")).toBeInTheDocument();
    expect(screen.queryByText("Mô tả lỗi quét 6")).not.toBeInTheDocument();
  });

  it("paginates AdminFlow2CandidatesPanel at 10 per page", async () => {
    const services = createAdminServiceFixture();
    const makePage = (offset: number): AdminFlow2CandidatePageDTO => ({
      items: [
        {
          id: makeUuid("9500", offset + 1),
          book_id: ADMIN_BOOK_ID,
          book_title: `Sách Flow2 ${offset + 1}`,
          page_id: ADMIN_PAGE_ID,
          page_number: 1,
          revision_id: ADMIN_R2_ID,
          line_index: 0,
          consent_version: 1,
          image_sha256: "e".repeat(64),
          proposed_label: `Dòng mẫu ${offset + 1}`,
          verified_label: null,
          rights_basis: "SELF_AUTHORED",
          rights_basis_label: "Phụ huynh đồng ý",
          pii_check_status: "CLEAR",
          pii_flags: [],
          quality_metrics: {},
          status: "PENDING_VERIFICATION",
          status_label: "Chờ xác minh",
          crop_image_url: "http://127.0.0.1:8000/crop.png",
          verified_at: null,
          rejection_code: null,
          rejection_reason: null,
          outbox_event_id: null,
          sample_id: null,
          revoked_at: null,
          revoke_reason: null,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      total: 15,
      limit: 10,
      offset,
      summary: { PENDING_VERIFICATION: 15 },
    });

    const listFlow2Candidates = vi
      .fn()
      .mockResolvedValueOnce(makePage(0))
      .mockResolvedValueOnce(makePage(10));
    const customServices = {
      ...services,
      bookContentQuality: {
        ...services.bookContentQuality,
        listFlow2Candidates,
      },
    };

    const user = userEvent.setup();
    render(withAdminFixture(<AdminFlow2CandidatesPanel />, customServices));

    expect(await screen.findByText("Sách Flow2 1")).toBeInTheDocument();
    expect(listFlow2Candidates).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 0 }),
    );

    await user.click(screen.getByRole("button", { name: "Tiếp" }));
    expect(await screen.findByText("Sách Flow2 11")).toBeInTheDocument();
    expect(listFlow2Candidates).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 10, offset: 10 }),
    );
  });
});
