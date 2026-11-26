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
    deleteReadingReport: vi.fn(),
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
    bbox: [0.1 + index * 0.15, 0.2, 0.1, 0.05] as [
      number,
      number,
      number,
      number,
    ],
  })),
};

beforeEach(() => {
  comparisonApi.getSessionReports.mockReset().mockResolvedValue({
    session_id: SESSION_ID,
    total: 1,
    reports: [report],
  });
  comparisonApi.getReadingPage.mockReset().mockResolvedValue(historicalPage);
  comparisonApi.deleteReadingReport.mockReset().mockResolvedValue(undefined);
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
      screen.getByText(
        /Chưa tải được nội dung trang sách đã đọc theo đúng phiên bản lúc bé đọc/,
      ),
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

  it("renders 'có' in 'Bé có một bông hoa.' red before practice and green once self_corrected_word_ids includes it", async () => {
    const words = ["Bé", "có", "một", "bông", "hoa."].map((text, index) => ({
      word_id: `60000000-0000-4000-8000-00000000000${index + 1}`,
      word_index: index,
      text,
      bbox: [0.05 + index * 0.16, 0.2, 0.12, 0.05] as [
        number,
        number,
        number,
        number,
      ],
    }));
    const coId = words[1].word_id;
    const baseReport: SavedReadingReport = {
      ...report,
      transcript: "Bé một bông hoa",
      alignment: [],
      summary: {
        ...report.summary,
        assessment_version: 1,
        initial_assessment: [
          {
            word_id: words[0].word_id,
            word_index: 0,
            text: "Bé",
            status: "CORRECT",
          },
          { word_id: coId, word_index: 1, text: "có", status: "OMISSION" },
          {
            word_id: words[2].word_id,
            word_index: 2,
            text: "một",
            status: "CORRECT",
          },
          {
            word_id: words[3].word_id,
            word_index: 3,
            text: "bông",
            status: "CORRECT",
          },
          {
            word_id: words[4].word_id,
            word_index: 4,
            text: "hoa.",
            status: "CORRECT",
          },
        ],
      },
    };
    const sentencePage: ReadingPage = {
      ...historicalPage,
      text: "Bé có một bông hoa.",
      words,
    };
    comparisonApi.getReadingPage.mockResolvedValue(sentencePage);

    // 1) Before practice -> 'có' is red
    comparisonApi.getSessionReports.mockResolvedValueOnce({
      session_id: SESSION_ID,
      total: 1,
      reports: [{ ...baseReport, self_corrected_word_ids: [] }],
    });
    const { rerender } = render(
      <SessionReadingReports sessionId={SESSION_ID} />,
    );
    const coBefore = await screen.findByText("có");
    expect(coBefore.className).toContain("bg-red-200");

    // 2) After self-correction / difficult-word practice saved -> 'có' turns green
    comparisonApi.getSessionReports.mockResolvedValueOnce({
      session_id: SESSION_ID,
      total: 1,
      reports: [{ ...baseReport, self_corrected_word_ids: [coId] }],
    });
    rerender(<SessionReadingReports sessionId={SESSION_ID} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Thử tải lại báo cáo" }),
    );
    const coAfter = await screen.findByText("có");
    await waitFor(() => {
      expect(coAfter.className).toContain("bg-green-200");
    });
    expect(coAfter.className).not.toContain("bg-red-200");
    expect(screen.getByText(/Đã đọc lại đúng: 1 từ/)).toBeInTheDocument();
  });

  it("lazy-loads only the active page on mount and caches visited pages without re-fetching", async () => {
    const page2Id = "20000000-0000-4000-8000-000000000002";
    const rev2Id = "30000000-0000-4000-8000-000000000002";
    const page3Id = "20000000-0000-4000-8000-000000000003";
    const rev3Id = "30000000-0000-4000-8000-000000000003";
    const page2: ReadingPage = {
      ...historicalPage,
      page_id: page2Id,
      page_revision_id: rev2Id,
      page_number: 8,
      text: "Trang tám đã lưu.",
    };
    comparisonApi.getSessionReports.mockResolvedValueOnce({
      session_id: SESSION_ID,
      total: 3,
      reports: [
        { ...report, report_id: "rep-1", created_at: "2026-11-06T10:00:00Z" },
        {
          ...report,
          report_id: "rep-2",
          page_id: page2Id,
          page_revision_id: rev2Id,
          created_at: "2026-11-06T10:02:00Z",
          transcript: "Trang tám",
        },
        {
          ...report,
          report_id: "rep-3",
          page_id: page3Id,
          page_revision_id: rev3Id,
          created_at: "2026-11-06T10:04:00Z",
          transcript: "Trang chín",
        },
      ],
    });
    comparisonApi.getReadingPage.mockImplementation(async (id: string) =>
      id === page2Id ? page2 : historicalPage,
    );

    render(<SessionReadingReports sessionId={SESSION_ID} />);
    expect(
      await screen.findByRole("heading", { name: "Trang 7" }),
    ).toBeInTheDocument();
    // Only the initial page is requested on mount — NOT eager N-page Promise.all.
    expect(comparisonApi.getReadingPage).toHaveBeenCalledTimes(1);
    expect(comparisonApi.getReadingPage).toHaveBeenCalledWith(
      PAGE_ID,
      SESSION_ID,
      REVISION_ID,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Báo cáo trang tiếp theo" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Trang 8" }),
    ).toBeInTheDocument();
    expect(comparisonApi.getReadingPage).toHaveBeenCalledTimes(2);
    expect(comparisonApi.getReadingPage).toHaveBeenLastCalledWith(
      page2Id,
      SESSION_ID,
      rev2Id,
    );

    // Navigating back to page 1 uses the in-session cache without another network call.
    fireEvent.click(
      screen.getByRole("button", { name: "Báo cáo trang trước" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Trang 7" }),
    ).toBeInTheDocument();
    expect(comparisonApi.getReadingPage).toHaveBeenCalledTimes(2);
  });

  it("renders a single primary report per page, discloses extra comparisons, preserves immutable v1 and allows deleting non-v1 comparisons", async () => {
    const firstPassReport: SavedReadingReport = {
      ...report,
      report_id: "rep-v1-first",
      created_at: "2026-11-06T10:00:00Z",
      transcript: "Lời đọc lượt đầu",
      summary: {
        ...report.summary,
        assessment_version: 1,
      },
    };
    const retryComparison: SavedReadingReport = {
      ...report,
      report_id: "rep-extra-retry",
      created_at: "2026-11-06T10:01:00Z",
      transcript: "Lời đọc đối chiếu bổ sung",
    };
    comparisonApi.getSessionReports.mockResolvedValueOnce({
      session_id: SESSION_ID,
      total: 2,
      reports: [retryComparison, firstPassReport],
    });

    render(<SessionReadingReports sessionId={SESSION_ID} />);
    expect(
      await screen.findByRole("heading", { name: "Trang 7" }),
    ).toBeInTheDocument();

    // P0: Only ONE "Báo cáo đọc" heading and ONE primary report region.
    expect(
      screen.getAllByRole("heading", { name: "Báo cáo đọc" }),
    ).toHaveLength(1);
    expect(
      screen.getByTestId("session-primary-reading-report"),
    ).toBeInTheDocument();
    expect(
      screen
        .getByTestId("session-primary-reading-report")
        .querySelector('[data-active-report-id="rep-v1-first"]'),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Lời đọc lượt đầu").length).toBeGreaterThan(0);

    // Extra comparison is preserved inside collapsible disclosure, not silently dropped or duplicated.
    const disclosureSummary = screen.getByText(
      "Các lượt đối chiếu khác của trang này (1)",
    );
    fireEvent.click(disclosureSummary);
    expect(screen.getByText("Được giữ nguyên")).toBeInTheDocument();

    // Switching to inspect the extra comparison works.
    fireEvent.click(screen.getByRole("button", { name: "Xem lượt này" }));
    expect(
      screen.getAllByText("Lời đọc đối chiếu bổ sung").length,
    ).toBeGreaterThan(0);

    // Deleting only the non-v1 comparison preserves the immutable first-pass report.
    fireEvent.click(screen.getByRole("button", { name: "Xóa báo cáo" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Xác nhận xóa" }),
    );

    await waitFor(() =>
      expect(comparisonApi.deleteReadingReport).toHaveBeenCalledWith(
        "rep-extra-retry",
      ),
    );
    expect(
      screen.queryByText("Các lượt đối chiếu khác của trang này (1)"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Lời đọc lượt đầu")).toBeInTheDocument();
  });
});
