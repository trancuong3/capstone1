import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionReadingReports } from "@/components/reports/session-reading-reports";
import type {
  ReadingPage,
  SavedReadingReport,
} from "@/lib/api/comparison-service";

const { comparisonApi } = vi.hoisted(() => ({
  comparisonApi: {
    getSessionReports: vi.fn(),
    getReadingPage: vi.fn(),
  },
}));

vi.mock("@/lib/api/comparison-service", () => comparisonApi);

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const PAGE_ID = "20000000-0000-4000-8000-000000000001";
const REVISION_ID = "30000000-0000-4000-8000-000000000001";
const REPORT_ID = "40000000-0000-4000-8000-000000000001";

const report: SavedReadingReport = {
  report_id: REPORT_ID,
  page_id: PAGE_ID,
  page_revision_id: REVISION_ID,
  transcript: "Bé đọc khóe đọc",
  created_at: "2026-11-06T10:00:00Z",
  distance: 2,
  alignment: [
    {
      book_word: "Bé",
      spoken_word: "Bé",
      book_index: 0,
      spoken_index: 0,
      status: "MATCH",
    },
    {
      book_word: "khỏe",
      spoken_word: "khóe",
      book_index: 1,
      spoken_index: 1,
      status: "SUBSTITUTE",
    },
    {
      book_word: "đang",
      spoken_word: null,
      book_index: 2,
      spoken_index: null,
      status: "DELETE",
    },
    {
      book_word: null,
      spoken_word: "đọc",
      book_index: null,
      spoken_index: 2,
      status: "INSERT",
    },
  ],
  summary: {
    missing_words: ["đang"],
    extra_words: ["đọc"],
    substitutions: [{ book_word: "khỏe", spoken_word: "khóe", book_index: 1 }],
    repeated_count: 0,
    repeated_words: [],
    repeated_book_indices: [],
    repeated_items: [],
    hesitations: [],
    hesitation_seconds: null,
  },
};

const historicalPage: ReadingPage = {
  page_id: PAGE_ID,
  page_revision_id: REVISION_ID,
  page_number: 7,
  confidence: 1,
  width: 600,
  height: 800,
  text: "Bé khỏe đang đọc.",
  words: ["Bé", "khỏe", "đang", "đọc"].map((text, index) => ({
    word_id: `50000000-0000-4000-8000-00000000000${index + 1}`,
    word_index: index,
    text,
    bbox: [0.1 + index * 0.15, 0.2, 0.1, 0.05] as [number, number, number, number],
  })),
};

beforeEach(() => {
  comparisonApi.getSessionReports.mockReset().mockResolvedValue({
    session_id: SESSION_ID,
    total: 1,
    reports: [report],
  });
  comparisonApi.getReadingPage.mockReset().mockResolvedValue(historicalPage);
});

describe("SessionReadingReports", () => {
  it("loads every saved report and the exact page revision that was read", async () => {
    render(<SessionReadingReports sessionId={SESSION_ID} />);

    expect(
      await screen.findByRole("heading", { name: "Trang 7" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Bé", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("khỏe", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("đang", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("đọc", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Bé đọc khóe đọc")).toBeInTheDocument();
    const substitutionMetric = await screen.findByText("Đọc nhầm");
    const substitutionMetricButton = substitutionMetric.closest("button");
    if (!substitutionMetricButton) {
      throw new Error("The substitution metric must be an interactive button.");
    }
    fireEvent.click(substitutionMetricButton);
    expect(screen.getByText("khỏe → khóe")).toBeInTheDocument();
    expect(screen.getByText("đang", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("đọc", { exact: true })).toBeInTheDocument();
    expect(comparisonApi.getReadingPage).toHaveBeenCalledWith(
      PAGE_ID,
      SESSION_ID,
      REVISION_ID,
    );
  });

  it("does not substitute a different revision returned for a historical report", async () => {
    comparisonApi.getReadingPage.mockResolvedValueOnce({
      ...historicalPage,
      page_revision_id: "35000000-0000-4000-8000-000000000001",
    });
    render(<SessionReadingReports sessionId={SESSION_ID} />);

    expect(
      await screen.findByText("Báo cáo chỉ tải được một phần"),
    ).toBeInTheDocument();
    expect(screen.getByText("Bé đọc khóe đọc")).toBeInTheDocument();
    expect(
      screen.getByText(/Không tải được nội dung của đúng revision đã đọc/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Bé khỏe đang đọc.")).not.toBeInTheDocument();
    expect(comparisonApi.getReadingPage).toHaveBeenCalledWith(
      PAGE_ID,
      SESSION_ID,
      REVISION_ID,
    );
  });

  it("shows an accurate empty state when the database has no report", async () => {
    comparisonApi.getSessionReports.mockResolvedValueOnce({
      session_id: SESSION_ID,
      total: 0,
      reports: [],
    });
    render(<SessionReadingReports sessionId={SESSION_ID} />);
    expect(
      await screen.findByText(
        "Buổi đọc này chưa có báo cáo đối chiếu được lưu.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps reports visible when historical page text is only partially available", async () => {
    comparisonApi.getReadingPage.mockRejectedValueOnce(
      new Error("not available"),
    );
    render(<SessionReadingReports sessionId={SESSION_ID} />);

    expect(
      await screen.findByText("Báo cáo chỉ tải được một phần"),
    ).toBeInTheDocument();
    expect(screen.getByText("Bé đọc khóe đọc")).toBeInTheDocument();
    expect(
      screen.getByText(/không thay bằng trang mới hơn/i),
    ).toBeInTheDocument();
  });

  it("offers retry after a report API error", async () => {
    comparisonApi.getSessionReports
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({
        session_id: SESSION_ID,
        total: 1,
        reports: [report],
      });
    render(<SessionReadingReports sessionId={SESSION_ID} />);

    expect(
      await screen.findByText("Có lỗi khi tải báo cáo"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Thử tải lại báo cáo" }),
    );
    await waitFor(() =>
      expect(comparisonApi.getSessionReports).toHaveBeenCalledTimes(2),
    );
    expect(
      await screen.findByRole("heading", { name: "Trang 7" }),
    ).toBeInTheDocument();
  });
});
