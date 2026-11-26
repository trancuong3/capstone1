"use client";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ReadingReportPage from "@/app/sessions/[sessionId]/report/page";

const api = vi.hoisted(() => ({
  getSessionReports: vi.fn(),
  deleteReadingReport: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  }),
}));

vi.mock("@/lib/api/comparison-service", () => ({
  getSessionReports: api.getSessionReports,
  deleteReadingReport: api.deleteReadingReport,
}));

vi.mock("@/components/reading/ReadingReport", () => ({
  ReadingReport: ({
    result,
  }: {
    result: { report_id: string; transcript: string };
  }) => (
    <article data-testid={`saved-report-${result.report_id}`}>
      {result.transcript}
    </article>
  ),
}));

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function savedReport(reportId: string, transcript: string) {
  return {
    report_id: reportId,
    page_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    page_revision_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    transcript,
    distance: 0,
    alignment: [],
    summary: {
      missing_words: [],
      extra_words: [],
      substitutions: [],
      repeated_count: 0,
      repeated_words: [],
      hesitations: [],
      hesitation_seconds: null,
    },
    created_at: "2026-11-02T10:00:00Z",
  };
}

function reportsResponse(reports: ReturnType<typeof savedReport>[]) {
  return {
    session_id: sessionId,
    total: reports.length,
    reports,
  };
}

beforeEach(() => {
  api.getSessionReports.mockReset();
  api.deleteReadingReport.mockReset().mockResolvedValue(undefined);
});

describe("per-session reading report page", () => {
  it("renders every report returned by the API", async () => {
    const first = savedReport("report-1", "Con mèo đang ngủ.");
    const second = savedReport("report-2", "Con chó đang chạy.");
    api.getSessionReports.mockResolvedValue(reportsResponse([first, second]));

    render(<ReadingReportPage />);

    expect(
      await screen.findByText("Có 2 báo cáo trong phiên đọc này."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("saved-report-report-1")).toHaveTextContent(
      "Con mèo đang ngủ.",
    );
    expect(screen.getByTestId("saved-report-report-2")).toHaveTextContent(
      "Con chó đang chạy.",
    );
    expect(api.getSessionReports).toHaveBeenCalledWith(sessionId);
  });

  it("distinguishes a real empty report list and retries it", async () => {
    const user = userEvent.setup();
    api.getSessionReports
      .mockResolvedValueOnce(reportsResponse([]))
      .mockResolvedValueOnce(
        reportsResponse([savedReport("report-after-retry", "Bé đọc thật.")]),
      );

    render(<ReadingReportPage />);

    expect(await screen.findByText(/Buổi đọc đã được lưu/)).toBeInTheDocument();
    expect(
      screen.queryByText("Không thể tải báo cáo đọc."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Kiểm tra lại" }));

    expect(
      await screen.findByTestId("saved-report-report-after-retry"),
    ).toHaveTextContent("Bé đọc thật.");
    expect(api.getSessionReports).toHaveBeenCalledTimes(2);
  });

  it("shows an API failure separately from empty data and supports retry", async () => {
    const user = userEvent.setup();
    api.getSessionReports
      .mockRejectedValueOnce(new Error("Không thể tải báo cáo đọc."))
      .mockResolvedValueOnce(
        reportsResponse([
          savedReport("report-recovered", "Transcript đã lưu."),
        ]),
      );

    render(<ReadingReportPage />);

    expect(
      await screen.findByText("Không thể tải báo cáo đọc."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Buổi đọc đã được lưu/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Thử tải lại" }));

    expect(
      await screen.findByTestId("saved-report-report-recovered"),
    ).toHaveTextContent("Transcript đã lưu.");
    expect(api.getSessionReports).toHaveBeenCalledTimes(2);
  });

  it("removes only the selected report after successful deletion", async () => {
    const user = userEvent.setup();
    const first = savedReport("report-to-delete", "Bài đọc cần xóa.");
    const second = savedReport("report-to-keep", "Bài đọc được giữ.");
    api.getSessionReports.mockResolvedValue(reportsResponse([first, second]));

    render(<ReadingReportPage />);

    await screen.findByTestId("saved-report-report-to-delete");
    await user.click(screen.getAllByRole("button", { name: "Xóa báo cáo" })[0]);
    await user.click(
      await screen.findByRole("button", { name: "Xác nhận xóa" }),
    );

    await waitFor(() => {
      expect(api.deleteReadingReport).toHaveBeenCalledWith("report-to-delete");
      expect(
        screen.queryByTestId("saved-report-report-to-delete"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("saved-report-report-to-keep")).toHaveTextContent(
      "Bài đọc được giữ.",
    );
  });

  it("renders a single Báo cáo đọc heading, groups multi-page sessions by page switcher, and protects immutable v1 first-pass reports", async () => {
    const user = userEvent.setup();
    const page1FirstPass = {
      ...savedReport("rep-p1-v1", "Trang 1 lượt đầu"),
      page_id: "11111111-1111-4111-8111-111111111111",
      page_revision_id: "11111111-1111-4111-8111-111111111112",
      created_at: "2026-11-02T10:00:00Z",
      summary: {
        ...savedReport("rep-p1-v1", "").summary,
        assessment_version: 1,
      },
    };
    const page1Retry = {
      ...savedReport("rep-p1-retry", "Trang 1 đối chiếu bổ sung"),
      page_id: "11111111-1111-4111-8111-111111111111",
      page_revision_id: "11111111-1111-4111-8111-111111111112",
      created_at: "2026-11-02T10:01:00Z",
    };
    const page2Report = {
      ...savedReport("rep-p2-v1", "Trang 2 lượt đầu"),
      page_id: "22222222-2222-4222-8222-222222222221",
      page_revision_id: "22222222-2222-4222-8222-222222222222",
      created_at: "2026-11-02T10:03:00Z",
      summary: {
        ...savedReport("rep-p2-v1", "").summary,
        assessment_version: 1,
      },
    };
    api.getSessionReports.mockResolvedValue(
      reportsResponse([page1Retry, page1FirstPass, page2Report]),
    );

    render(<ReadingReportPage />);

    expect(
      await screen.findByTestId("saved-report-rep-p1-v1"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", { name: "Báo cáo đọc" }),
    ).toHaveLength(1);
    expect(
      screen.getByText("Kết quả lượt đầu được giữ nguyên"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Các lượt đối chiếu khác của trang này (1)"),
    ).toBeInTheDocument();
    // Page 2 is not stacked vertically below Page 1; user switches cleanly.
    expect(
      screen.queryByTestId("saved-report-rep-p2-v1"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Trang 2" }));
    expect(
      await screen.findByTestId("saved-report-rep-p2-v1"),
    ).toHaveTextContent("Trang 2 lượt đầu");
    expect(
      screen.queryByTestId("saved-report-rep-p1-v1"),
    ).not.toBeInTheDocument();
  });

  it("enforces M3.1 4-band breakpoints, >= 44px touch targets, and zero legacy sm: classes across loaded, empty, and error states", async () => {
    const page1FirstPass = {
      ...savedReport("rep-p1-v1", "Trang 1 lượt đầu"),
      page_id: "11111111-1111-4111-8111-111111111111",
      page_revision_id: "11111111-1111-4111-8111-111111111112",
      created_at: "2026-11-02T10:00:00Z",
      summary: {
        ...savedReport("rep-p1-v1", "").summary,
        assessment_version: 1,
      },
    };
    const page1Retry = {
      ...savedReport("rep-p1-retry", "Trang 1 đối chiếu bổ sung"),
      page_id: "11111111-1111-4111-8111-111111111111",
      page_revision_id: "11111111-1111-4111-8111-111111111112",
      created_at: "2026-11-02T10:01:00Z",
    };
    const page2Report = {
      ...savedReport("rep-p2-v1", "Trang 2 lượt đầu"),
      page_id: "22222222-2222-4222-8222-222222222221",
      page_revision_id: "22222222-2222-4222-8222-222222222222",
      created_at: "2026-11-02T10:03:00Z",
      summary: {
        ...savedReport("rep-p2-v1", "").summary,
        assessment_version: 1,
      },
    };

    api.getSessionReports.mockResolvedValueOnce(
      reportsResponse([page1Retry, page1FirstPass, page2Report]),
    );
    const { container, unmount } = render(<ReadingReportPage />);
    await screen.findByTestId("saved-report-rep-p1-v1");

    const header = container.querySelector("header")!;
    expect(header.className).toContain("min-[640px]:flex-row");
    expect(header.className).toContain("min-[640px]:items-end");
    expect(
      screen.getByRole("heading", { name: "Báo cáo đọc" }).className,
    ).toContain("min-[640px]:text-3xl");
    expect(
      screen.getByRole("link", { name: /Chi tiết buổi đọc/ }).className,
    ).toContain("min-h-11");
    expect(
      screen.getByRole("link", { name: "Lịch sử đọc" }).className,
    ).toContain("min-h-11");

    const nav = screen.getByRole("navigation", {
      name: "Chọn trang có báo cáo",
    });
    expect(nav.className).toContain("md:px-5");
    for (const btn of [
      screen.getByRole("button", { name: "Trang trước" }),
      screen.getByRole("button", { name: "Trang 1" }),
      screen.getByRole("button", { name: "Trang 2" }),
      screen.getByRole("button", { name: "Trang sau" }),
    ]) {
      expect(btn.className).toContain("min-h-11");
      expect(btn.className).toContain("min-w-11");
      expect(btn.className).toContain("min-[640px]:px-3");
    }
    expect(
      screen.getByRole("button", { name: "Trang 1" }).querySelector("span")!
        .className,
    ).toContain("min-[640px]:inline");

    const details = container.querySelector("details")!;
    expect(details.className).toContain("md:p-5");
    expect(details.querySelector("summary")!.className).toContain("min-h-11");
    expect(container.innerHTML).not.toMatch(
      /(?:^|[\s"'])(?:sm|max-sm|max-\[639px\]|max-\[767px\]):/,
    );
    unmount();

    api.getSessionReports.mockResolvedValueOnce(reportsResponse([]));
    const emptyRender = render(<ReadingReportPage />);
    const emptyRetryBtn = await screen.findByRole("button", {
      name: "Kiểm tra lại",
    });
    expect(emptyRetryBtn.className).toContain("w-full");
    expect(emptyRetryBtn.className).toContain("min-[640px]:w-auto");
    expect(emptyRetryBtn.className).toContain("min-[640px]:self-start");
    expect(emptyRender.container.innerHTML).not.toMatch(
      /(?:^|[\s"'])(?:sm|max-sm|max-\[639px\]|max-\[767px\]):/,
    );
    emptyRender.unmount();

    api.getSessionReports.mockRejectedValueOnce(new Error("Lỗi mạng"));
    const errorRender = render(<ReadingReportPage />);
    const errorRetryBtn = await screen.findByRole("button", {
      name: "Thử tải lại",
    });
    expect(errorRetryBtn.className).toContain("w-full");
    expect(errorRetryBtn.className).toContain("min-[640px]:w-auto");
    expect(errorRetryBtn.className).toContain("min-[640px]:self-start");
    expect(errorRender.container.innerHTML).not.toMatch(
      /(?:^|[\s"'])(?:sm|max-sm|max-\[639px\]|max-\[767px\]):/,
    );
  });
});
