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

    expect(
      await screen.findByText(/chưa có báo cáo đối chiếu nào được lưu/i),
    ).toBeInTheDocument();
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
    expect(
      screen.queryByText(/chưa có báo cáo đối chiếu nào được lưu/i),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Thử tải lại" }));

    expect(
      await screen.findByTestId("saved-report-report-recovered"),
    ).toHaveTextContent("Transcript đã lưu.");
    expect(api.getSessionReports).toHaveBeenCalledTimes(2);
  });

  it("removes only the selected report after successful deletion", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const first = savedReport("report-to-delete", "Bài đọc cần xóa.");
    const second = savedReport("report-to-keep", "Bài đọc được giữ.");
    api.getSessionReports.mockResolvedValue(reportsResponse([first, second]));

    render(<ReadingReportPage />);

    await screen.findByTestId("saved-report-report-to-delete");
    await user.click(screen.getAllByRole("button", { name: "Xóa báo cáo" })[0]);

    await waitFor(() => {
      expect(api.deleteReadingReport).toHaveBeenCalledWith("report-to-delete");
      expect(
        screen.queryByTestId("saved-report-report-to-delete"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("saved-report-report-to-keep")).toHaveTextContent(
      "Bài đọc được giữ.",
    );
    confirm.mockRestore();
  });
});
