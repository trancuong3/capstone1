import { render, screen, waitFor } from "@testing-library/react";
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

  it("paginates parent book reports at 10 per page and requests the next page offset", async () => {
    const listMineMock = vi.mocked(mockReportService.listMine);
    listMineMock.mockReset();
    listMineMock.mockImplementation(async ({ limit = 10, offset = 0 } = {}) => {
      const all = Array.from({ length: 12 }, (_, index) => ({
        id: `77000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        book_id: BOOK_ID,
        book_title: `Sách báo cáo ${index + 1}`,
        reporter_name: "Phụ huynh A",
        page_id: PAGE_ID,
        page_number: index + 1,
        page_revision_id: null,
        issue_type: "SPELLING_ERROR" as const,
        description: `Lỗi chính tả báo cáo ${index + 1}`,
        reported_text: null,
        suggested_correction: null,
        status: "OPEN" as const,
        scan_run_id: null,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
      }));
      return {
        items: all.slice(offset, offset + limit),
        total: all.length,
        limit,
        offset,
      };
    });

    const user = userEvent.setup();
    render(<ParentBookReportsScreen />);

    expect(await screen.findByText("Sách báo cáo 1")).toBeInTheDocument();
    expect(screen.getByText("Sách báo cáo 10")).toBeInTheDocument();
    expect(screen.queryByText("Sách báo cáo 11")).not.toBeInTheDocument();
    expect(screen.getByText("Trang 1 / 2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Tiếp/i }));
    expect(await screen.findByText("Sách báo cáo 11")).toBeInTheDocument();
    expect(screen.getByText("Sách báo cáo 12")).toBeInTheDocument();
    expect(screen.queryByText("Sách báo cáo 1")).not.toBeInTheDocument();
    expect(listMineMock).toHaveBeenLastCalledWith({ limit: 10, offset: 10 });
  });
});
