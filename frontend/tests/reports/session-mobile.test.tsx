import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReadingReportPage from "@/app/sessions/[sessionId]/report/page";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SessionDetailScreen } from "@/components/reports/session-detail-screen";
import { SessionHistoryScreen } from "@/components/reports/session-history-screen";
import { SessionReadingReports } from "@/components/reports/session-reading-reports";
import type {
  ReadingPage,
  SavedReadingReport,
} from "@/lib/api/comparison-service";
import {
  bookFixture,
  childFixture,
  sessionDetailFixture,
  sessionSummaryFixture,
  TEST_CHILD_ID,
  TEST_PAGE_ID,
  TEST_REVISION_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  query: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/sessions",
  useSearchParams: () => new URLSearchParams(navigation.query),
  useRouter: () => ({ push: navigation.push }),
  useParams: () => ({ sessionId: TEST_SESSION_ID }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const { comparisonApi } = vi.hoisted(() => ({
  comparisonApi: {
    getSessionReports: vi.fn(),
    getReadingPage: vi.fn(),
    deleteReadingReport: vi.fn(),
  },
}));

vi.mock("@/lib/api/comparison-service", () => comparisonApi);

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

function installMatchMediaController(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.add(listener);
      },
      removeEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.delete(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => true,
    })),
  );

  return {
    setMobile(nextMatches: boolean) {
      matches = nextMatches;
      for (const listener of listeners) {
        listener({
          matches: nextMatches,
          media: "(max-width: 767px)",
        } as MediaQueryListEvent);
      }
    },
  };
}

const sampleReport: SavedReadingReport = {
  report_id: "40000000-0000-4000-8000-000000000001",
  page_id: TEST_PAGE_ID,
  page_revision_id: TEST_REVISION_ID,
  transcript: "Bé đọc bài",
  created_at: "2026-11-06T10:00:00Z",
  distance: 0,
  alignment: [],
  summary: {
    missing_words: [],
    extra_words: [],
    substitutions: [],
    repeated_count: 0,
    repeated_words: [],
    repeated_book_indices: [],
    repeated_items: [],
    hesitations: [],
    hesitation_seconds: null,
  },
};

const samplePage: ReadingPage = {
  page_id: TEST_PAGE_ID,
  page_revision_id: TEST_REVISION_ID,
  page_number: 1,
  confidence: 1,
  width: 600,
  height: 800,
  text: "Bé đọc bài",
  words: [
    {
      word_id: "50000000-0000-4000-8000-000000000001",
      word_index: 0,
      text: "Bé",
      bbox: [0.1, 0.2, 0.1, 0.05],
    },
  ],
};

describe("F12 Mobile Sessions & Session Reports (< 768px)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    navigation.push.mockReset();
    navigation.query = "";
    comparisonApi.getSessionReports.mockReset().mockResolvedValue({
      session_id: TEST_SESSION_ID,
      total: 1,
      reports: [sampleReport],
    });
    comparisonApi.getReadingPage.mockReset().mockResolvedValue(samplePage);
    comparisonApi.deleteReadingReport.mockReset().mockResolvedValue(undefined);
    fetchMock
      .mockReset()
      .mockImplementation(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === "/profiles/children") return Response.json([childFixture]);
        if (path === `/profiles/children/${TEST_CHILD_ID}`)
          return Response.json(childFixture);
        if (path.endsWith("/book")) return Response.json(bookFixture);
        if (path === `/reading/history/${TEST_SESSION_ID}`)
          return Response.json(sessionDetailFixture);
        if (path === "/reading/history")
          return Response.json({
            sessions: [sessionSummaryFixture],
            next_cursor: "page-3",
          });
        throw new Error(`Unexpected route: ${path}`);
      });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders MobileSessionHistory without .history-entry or .pb-24 and restores .history-entry on desktop", async () => {
    const media = installMatchMediaController(true);

    const { container } = render(
      <AppServicesProvider>
        <SessionHistoryScreen page={2} requestedChildId={TEST_CHILD_ID} />
      </AppServicesProvider>,
    );

    await screen.findByRole("heading", { name: bookFixture.title });
    expect(container.querySelector(".history-entry")).toBeNull();
    expect(container.querySelector(".pb-24")).toBeNull();

    const progressLink = screen.getByRole("link", { name: "Xem tiến bộ" });
    expect(progressLink.className).toContain("min-h-11");

    const detailLink = screen.getByRole("link", { name: "Xem chi tiết" });
    expect(detailLink.className).toContain("min-h-11");
    expect(detailLink.className).toContain("min-w-11");

    expect(
      screen.getByRole("link", { name: "Trang trước" }).className,
    ).toContain("min-h-11");
    expect(screen.getByRole("link", { name: "Trang sau" }).className).toContain(
      "min-h-11",
    );

    act(() => {
      media.setMobile(false);
    });
    expect(container.querySelector(".history-entry")).not.toBeNull();
  });

  it("renders MobileSessionDetail with top touch back link, 2-col metrics, and >= 44px controls", async () => {
    installMatchMediaController(true);

    render(
      <AppServicesProvider>
        <SessionDetailScreen
          page={2}
          requestedChildId={TEST_CHILD_ID}
          sessionId={TEST_SESSION_ID}
        />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Buổi đọc đã hoàn thành" }),
    ).toBeInTheDocument();

    const historyBack = screen.getByRole("link", { name: "Lịch sử" });
    expect(historyBack.className).toContain("min-h-11");
    expect(historyBack).toHaveAttribute(
      "href",
      `/sessions?childId=${TEST_CHILD_ID}&page=2`,
    );

    const otherInfoSummary = screen
      .getByText("Thông tin khác của buổi đọc")
      .closest("summary");
    expect(otherInfoSummary?.className).toContain("min-h-11");

    expect(
      screen.getAllByRole("heading", { name: "Báo cáo đọc" }),
    ).toHaveLength(1);
  });

  it("keeps SessionReadingReports single-mounted across mobile -> desktop -> mobile toggles without re-fetching", async () => {
    const media = installMatchMediaController(true);

    render(
      <AppServicesProvider>
        <SessionDetailScreen
          page={2}
          requestedChildId={TEST_CHILD_ID}
          sessionId={TEST_SESSION_ID}
        />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Trang 1" }),
    ).toBeInTheDocument();
    expect(screen.getByText(sampleReport.transcript)).toBeInTheDocument();
    expect(comparisonApi.getSessionReports).toHaveBeenCalledTimes(1);
    expect(comparisonApi.getReadingPage).toHaveBeenCalledTimes(1);

    const otherInfoDetails = screen
      .getByText("Thông tin khác của buổi đọc")
      .closest("details") as HTMLDetailsElement;
    otherInfoDetails.open = true;

    act(() => {
      media.setMobile(false);
    });
    expect(screen.getByText(sampleReport.transcript)).toBeInTheDocument();
    expect(comparisonApi.getSessionReports).toHaveBeenCalledTimes(1);
    expect(otherInfoDetails.open).toBe(true);

    act(() => {
      media.setMobile(true);
    });
    expect(screen.getByText(sampleReport.transcript)).toBeInTheDocument();
    expect(comparisonApi.getSessionReports).toHaveBeenCalledTimes(1);
    expect(comparisonApi.getReadingPage).toHaveBeenCalledTimes(1);
    expect(otherInfoDetails.open).toBe(true);
  });

  it("enforces >= 44px touch targets inside SessionReadingReports on mobile", async () => {
    installMatchMediaController(true);

    const page2Id = "20000000-0000-4000-8000-000000000002";
    const rev2Id = "30000000-0000-4000-8000-000000000002";
    const extraReport: SavedReadingReport = {
      ...sampleReport,
      report_id: "40000000-0000-4000-8000-000000000002",
      created_at: "2026-11-06T10:02:00Z",
      transcript: "Lượt đối chiếu bổ sung",
    };
    const firstPassReport: SavedReadingReport = {
      ...sampleReport,
      summary: { ...sampleReport.summary, assessment_version: 1 },
    };
    const page2Report: SavedReadingReport = {
      ...sampleReport,
      report_id: "40000000-0000-4000-8000-000000000003",
      page_id: page2Id,
      page_revision_id: rev2Id,
    };

    comparisonApi.getSessionReports.mockResolvedValueOnce({
      session_id: TEST_SESSION_ID,
      total: 3,
      reports: [extraReport, firstPassReport, page2Report],
    });

    render(<SessionReadingReports sessionId={TEST_SESSION_ID} />);

    expect(
      await screen.findByRole("heading", { name: "Trang 1" }),
    ).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", {
      name: "Thử tải lại báo cáo",
    });
    expect(retryBtn.className).toContain("min-h-11");

    const page1Btn = screen.getByRole("button", { name: "Trang 1" });
    const page2Btn = screen.getByRole("button", { name: "Trang 2" });
    expect(page1Btn.className).toContain("min-h-11");
    expect(page1Btn.className).toContain("min-w-11");
    expect(page2Btn.className).toContain("min-h-11");
    expect(page2Btn.className).toContain("min-w-11");

    const otherSummary = screen
      .getByText("Các lượt đối chiếu khác của trang này (1)")
      .closest("summary");
    expect(otherSummary?.className).toContain("min-h-11");
    fireEvent.click(otherSummary!);

    expect(
      screen.getByRole("button", { name: "Xem lượt này" }).className,
    ).toContain("min-h-11");
    expect(
      screen.getByRole("button", { name: "Xóa báo cáo" }).className,
    ).toContain("min-h-11");
  });

  it("renders standalone ReadingReportPage mobile links and page buttons with >= 44px targets", async () => {
    installMatchMediaController(true);

    const page2Report: SavedReadingReport = {
      ...sampleReport,
      report_id: "40000000-0000-4000-8000-000000000009",
      page_id: "20000000-0000-4000-8000-000000000009",
      page_revision_id: "30000000-0000-4000-8000-000000000009",
    };

    comparisonApi.getSessionReports.mockResolvedValueOnce({
      session_id: TEST_SESSION_ID,
      total: 2,
      reports: [sampleReport, page2Report],
    });

    render(<ReadingReportPage />);

    expect(
      await screen.findByTestId("standalone-session-report"),
    ).toBeInTheDocument();

    const detailLink = screen.getByRole("link", { name: "Chi tiết buổi đọc" });
    expect(detailLink.className).not.toContain("min-h-0");
    expect(detailLink.className).toContain("min-h-11");

    const historyLink = screen.getByRole("link", { name: "Lịch sử đọc" });
    expect(historyLink.className).toContain("min-h-11");

    const page1Btn = screen.getByRole("button", { name: "Trang 1" });
    const page2Btn = screen.getByRole("button", { name: "Trang 2" });
    expect(page1Btn.className).toContain("min-h-11");
    expect(page1Btn.className).toContain("min-w-11");
    expect(page2Btn.className).toContain("min-h-11");
    expect(page2Btn.className).toContain("min-w-11");

    expect(
      screen.getAllByRole("heading", { name: "Báo cáo đọc" }),
    ).toHaveLength(1);
  });
});
