import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BookContentReportDialog } from "@/components/books/book-content-report-dialog";
import { ParentBookReportsScreen } from "@/components/books/parent-book-reports-screen";
import type { BookContentReportService } from "@/lib/api/book-content-report-service";

const mockReportService: BookContentReportService = {
  create: vi.fn(),
  listMine: vi.fn(),
  getMine: vi.fn(),
};

vi.mock("@/hooks/use-book-content-report-service", () => ({
  useBookContentReportService: () => mockReportService,
}));

const BOOK_ID = "55000000-0000-4000-8000-000000000001";
const PAGE_ID = "66000000-0000-4000-8000-000000000001";
const REPORT_ID = "77000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-11-21T08:30:00Z";

describe("Parent book content reports dialog & inbox", () => {
  it("supports CHILD_SAFETY_CONCERN and COPYRIGHT_CONCERN and reuses idempotency key on retry", async () => {
    const createMock = vi.mocked(mockReportService.create);
    createMock.mockReset();
    createMock
      .mockRejectedValueOnce(new Error("transient network error"))
      .mockResolvedValueOnce({
        id: REPORT_ID,
        book_id: BOOK_ID,
        book_title: "Truyện Thiếu Nhi",
        reporter_id: "11000000-0000-4000-8000-000000000001",
        reporter_name: "Phụ huynh A",
        page_id: PAGE_ID,
        page_number: 2,
        page_revision_id: null,
        issue_type: "COPYRIGHT_CONCERN",
        description: "Nghi ngờ tài liệu chưa có giấy phép sử dụng.",
        reported_text: null,
        suggested_correction: null,
        status: "OPEN",
        scan_run_id: null,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        verified_text_snapshot: null,
        content_hash_snapshot: null,
        admin_resolution_note: null,
        reviewed_by: null,
        reviewed_by_name: null,
        resolved_at: null,
        history: [],
        related_findings: [],
      });

    const user = userEvent.setup();
    render(
      <BookContentReportDialog
        bookId={BOOK_ID}
        bookTitle="Truyện Thiếu Nhi"
        onClose={vi.fn()}
        pageId={PAGE_ID}
        pageNumber={2}
      />,
    );

    const select = screen.getByLabelText(/Loại vấn đề/i);
    expect(
      screen.getByRole("option", {
        name: /Nội dung có dấu hiệu không phù hợp cho trẻ em/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Nghi ngại bản quyền/i }),
    ).toBeInTheDocument();

    await user.selectOptions(select, "COPYRIGHT_CONCERN");
    await user.type(
      screen.getByLabelText(/Mô tả vấn đề/i),
      "Nghi ngờ tài liệu chưa có giấy phép sử dụng.",
    );

    // 1st attempt fails transiently
    await user.click(screen.getByRole("button", { name: /Gửi báo cáo/i }));
    expect(
      await screen.findByText(/Chưa thể gửi báo cáo/i),
    ).toBeInTheDocument();

    // Retry reuses the exact same idempotency_key
    await user.click(screen.getByRole("button", { name: /Gửi báo cáo/i }));
    expect(
      await screen.findByText(/Báo cáo đã được lưu thành công/i),
    ).toBeInTheDocument();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0]?.[1].idempotency_key).toBe(
      createMock.mock.calls[1]?.[1].idempotency_key,
    );
  });

  it("displays parent reports and loads Admin resolution response on demand", async () => {
    vi.mocked(mockReportService.listMine).mockResolvedValue({
      items: [
        {
          id: REPORT_ID,
          book_id: BOOK_ID,
          book_title: "Truyện Thiếu Nhi",
          reporter_name: "Phụ huynh A",
          page_id: PAGE_ID,
          page_number: 2,
          page_revision_id: null,
          issue_type: "CHILD_SAFETY_CONCERN",
          description: "Cảnh báo từ ngữ không phù hợp trang 2.",
          reported_text: "từ ngữ nhạy cảm",
          suggested_correction: null,
          status: "RESOLVED",
          scan_run_id: null,
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });
    vi.mocked(mockReportService.getMine).mockResolvedValue({
      id: REPORT_ID,
      book_id: BOOK_ID,
      book_title: "Truyện Thiếu Nhi",
      reporter_id: "11000000-0000-4000-8000-000000000001",
      reporter_name: "Phụ huynh A",
      page_id: PAGE_ID,
      page_number: 2,
      page_revision_id: null,
      issue_type: "CHILD_SAFETY_CONCERN",
      description: "Cảnh báo từ ngữ không phù hợp trang 2.",
      reported_text: "từ ngữ nhạy cảm",
      suggested_correction: null,
      status: "RESOLVED",
      scan_run_id: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      verified_text_snapshot: null,
      content_hash_snapshot: null,
      admin_resolution_note: "Admin đã kiểm tra và gỡ nội dung không phù hợp.",
      reviewed_by: null,
      reviewed_by_name: "Admin QA",
      resolved_at: CREATED_AT,
      history: [
        {
          actor_name: "Admin QA",
          from_status: "OPEN",
          to_status: "RESOLVED",
          note: "Admin đã kiểm tra và gỡ nội dung không phù hợp.",
          created_at: CREATED_AT,
        },
      ],
      related_findings: [],
    });

    const user = userEvent.setup();
    render(<ParentBookReportsScreen />);

    expect(
      await screen.findByText(/Nội dung có dấu hiệu không phù hợp cho trẻ em/i),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Xem chi tiết & phản hồi Admin/i }),
    );
    await waitFor(() => {
      expect(mockReportService.getMine).toHaveBeenCalledWith(REPORT_ID);
    });
    expect(await screen.findByTestId("parent-report-detail")).toHaveTextContent(
      /Admin đã kiểm tra và gỡ nội dung không phù hợp/i,
    );
  });

  it("renders PageHeader, semantic status badges, 640px 2-col grid, compact PaginationBar (>20 items), and zero sm: classes", async () => {
    const listMineMock = vi.mocked(mockReportService.listMine);
    listMineMock.mockReset();
    listMineMock.mockResolvedValue({
      items: [
        {
          id: REPORT_ID,
          book_id: BOOK_ID,
          book_title: "Sách A",
          reporter_name: "Phụ huynh A",
          page_id: null,
          page_number: null,
          page_revision_id: null,
          issue_type: "SPELLING_ERROR",
          description: "Mô tả A",
          reported_text: null,
          suggested_correction: null,
          status: "OPEN",
          scan_run_id: null,
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
        },
        {
          id: "77000000-0000-4000-8000-000000000002",
          book_id: BOOK_ID,
          book_title: "Sách B",
          reporter_name: "Phụ huynh A",
          page_id: null,
          page_number: null,
          page_revision_id: null,
          issue_type: "SPELLING_ERROR",
          description: "Mô tả B",
          reported_text: null,
          suggested_correction: null,
          status: "UNDER_REVIEW",
          scan_run_id: null,
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
        },
        {
          id: "77000000-0000-4000-8000-000000000003",
          book_id: BOOK_ID,
          book_title: "Sách C",
          reporter_name: "Phụ huynh A",
          page_id: null,
          page_number: null,
          page_revision_id: null,
          issue_type: "SPELLING_ERROR",
          description: "Mô tả C",
          reported_text: null,
          suggested_correction: null,
          status: "RESOLVED",
          scan_run_id: null,
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
        },
        {
          id: "77000000-0000-4000-8000-000000000004",
          book_id: BOOK_ID,
          book_title: "Sách D",
          reporter_name: "Phụ huynh A",
          page_id: null,
          page_number: null,
          page_revision_id: null,
          issue_type: "SPELLING_ERROR",
          description: "Mô tả D",
          reported_text: null,
          suggested_correction: null,
          status: "REJECTED",
          scan_run_id: null,
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
        },
      ],
      total: 22,
      limit: 20,
      offset: 0,
    });

    const user = userEvent.setup();
    const { container } = render(<ParentBookReportsScreen />);

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Báo cáo chất lượng sách",
    });
    expect(heading.closest("header")?.className).toContain("border-b");

    expect((await screen.findByText("Đã tiếp nhận")).className).toContain(
      "bg-sky",
    );
    expect(screen.getByText("Đang kiểm tra").className).toContain(
      "bg-amber-50",
    );
    expect(screen.getByText("Đã xử lý").className).toContain("bg-emerald-50");
    expect(screen.getByText("Không đủ căn cứ").className).toContain(
      "bg-rose-50",
    );

    const grid = container.querySelector(".grid.grid-cols-1");
    expect(grid?.className).toContain("min-[640px]:grid-cols-2");
    expect(grid?.className).toContain("md:grid-cols-1");

    const detailButtons = screen.getAllByRole("button", {
      name: /Xem chi tiết & phản hồi Admin/i,
    });
    expect(detailButtons[0]?.className).toContain("min-h-11!");
    expect(detailButtons[0]?.className).toContain("px-3!");

    const pagination = screen.getByRole("navigation", {
      name: "Phân trang báo cáo chất lượng sách",
    });
    expect(pagination).toHaveTextContent("Trang 1 / 2");
    const nextBtn = within(pagination).getByRole("button", { name: "Tiếp" });
    expect(nextBtn.className).toContain("min-h-11");
    await user.click(nextBtn);
    await waitFor(() => {
      expect(listMineMock).toHaveBeenCalledWith({ limit: 20, offset: 20 });
    });

    expect(container.innerHTML).not.toMatch(/\b(?:max-)?sm:/);
  });
});
