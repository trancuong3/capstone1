import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BookContentReportDialog } from "@/components/books/book-content-report-dialog";
import { ParentBookReportsScreen } from "@/components/books/parent-book-reports-screen";
import type { BookContentReportService } from "@/lib/api/book-content-report-service";

const createMock = vi.fn<BookContentReportService["create"]>();
const listMineMock = vi.fn<BookContentReportService["listMine"]>();

vi.mock("@/hooks/use-book-content-report-service", () => ({
  useBookContentReportService: () => ({
    create: createMock,
    listMine: listMineMock,
  }),
}));

describe("Parent book content reports", () => {
  it("supports CHILD_UNSAFE_CONTENT and COPYRIGHT_CONCERN alongside legacy issue types in BookContentReportDialog", async () => {
    createMock.mockReset();
    createMock.mockResolvedValue({
      id: "91000000-0000-4000-8000-000000000010",
      book_id: "81000000-0000-4000-8000-000000000001",
      book_title: "Sách tập đọc",
      reporter_id: "20000000-0000-4000-8000-000000000001",
      reporter_name: "Phụ huynh A",
      page_id: "83000000-0000-4000-8000-000000000001",
      page_number: 2,
      page_revision_id: "84000000-0000-4000-8000-000000000001",
      current_page_revision_id: null,
      page_revision_changed: false,
      issue_type: "CHILD_UNSAFE_CONTENT",
      description: "Trang này có nội dung không phù hợp cho bé lớp 1.",
      reported_text: null,
      suggested_correction: null,
      status: "OPEN",
      scan_run_id: null,
      verified_text_snapshot: null,
      content_hash_snapshot: null,
      admin_resolution_note: null,
      reviewed_by: null,
      reviewed_by_name: null,
      resolved_at: null,
      history: [],
      related_findings: [],
      created_at: "2026-11-21T01:00:00Z",
      updated_at: "2026-11-21T01:00:00Z",
    });

    const user = userEvent.setup();
    render(
      <BookContentReportDialog
        bookId="81000000-0000-4000-8000-000000000001"
        bookTitle="Sách tập đọc"
        onClose={vi.fn()}
        pageId="83000000-0000-4000-8000-000000000001"
        pageNumber={2}
      />,
    );

    const select = screen.getByLabelText("Loại vấn đề");
    expect(
      screen.getByRole("option", { name: "Nội dung không phù hợp với trẻ" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Nghi vấn quyền sử dụng" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Sai chính tả" }),
    ).toBeInTheDocument();

    await user.selectOptions(select, "CHILD_UNSAFE_CONTENT");
    await user.type(
      screen.getByLabelText(/Mô tả vấn đề/),
      "Trang này có nội dung không phù hợp cho bé lớp 1.",
    );
    await user.click(screen.getByRole("button", { name: "Gửi báo cáo" }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        "81000000-0000-4000-8000-000000000001",
        expect.objectContaining({
          issue_type: "CHILD_UNSAFE_CONTENT",
          page_id: "83000000-0000-4000-8000-000000000001",
        }),
      ),
    );
    expect(
      await screen.findByText("Báo cáo đã được lưu thành công."),
    ).toBeInTheDocument();
  });

  it("renders new safety and copyright issue labels in ParentBookReportsScreen", async () => {
    listMineMock.mockResolvedValue({
      items: [
        {
          id: "91000000-0000-4000-8000-000000000011",
          book_id: "81000000-0000-4000-8000-000000000001",
          book_title: "Truyện cổ tích",
          reporter_name: "Phụ huynh A",
          page_id: null,
          page_number: null,
          page_revision_id: null,
          issue_type: "COPYRIGHT_CONCERN",
          description: "Cần xem lại thông tin nguồn xuất bản sách này.",
          reported_text: null,
          suggested_correction: null,
          status: "OPEN",
          scan_run_id: null,
          created_at: "2026-11-21T01:00:00Z",
          updated_at: "2026-11-21T01:00:00Z",
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });

    render(<ParentBookReportsScreen />);
    expect(
      await screen.findByText(/Nghi vấn quyền sử dụng · Toàn bộ sách/),
    ).toBeInTheDocument();
  });
});
