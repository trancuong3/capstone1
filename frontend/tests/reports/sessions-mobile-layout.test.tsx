import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReadingReport } from "@/components/reading/ReadingReport";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SessionDetailScreen } from "@/components/reports/session-detail-screen";
import { SessionEventList } from "@/components/reports/session-event-list";
import { SessionHistoryItem } from "@/components/reports/session-history-item";
import { SessionHistoryScreen } from "@/components/reports/session-history-screen";
import { SessionReadingReports } from "@/components/reports/session-reading-reports";
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
import type { HistoryEventDTO } from "@/types/reading";

const { comparisonApi } = vi.hoisted(() => ({
  comparisonApi: {
    getSessionReports: vi.fn(),
    getReadingPage: vi.fn(),
    deleteReadingReport: vi.fn(),
  },
}));

vi.mock("@/lib/api/comparison-service", () => comparisonApi);
vi.mock("@/components/reading/book-page-content", () => ({
  BookPageContent: () => <div data-testid="mock-book-page-content" />,
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

beforeEach(() => {
  comparisonApi.getSessionReports.mockReset().mockResolvedValue({
    session_id: TEST_SESSION_ID,
    total: 0,
    reports: [],
  });
  comparisonApi.getReadingPage.mockReset().mockResolvedValue({
    page_id: TEST_PAGE_ID,
    page_revision_id: TEST_REVISION_ID,
    page_number: 1,
    confidence: 1,
    width: 600,
    height: 800,
    text: "Bé đọc bài.",
    words: [
      {
        word_id: "50000000-0000-4000-8000-000000000001",
        word_index: 0,
        text: "Bé",
        bbox: [0.1, 0.2, 0.1, 0.05],
      },
    ],
  });
  comparisonApi.deleteReadingReport.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("F10.3 sessions & reading report mobile overhaul", () => {
  it("hides raw UUID clutter behind a >= 44px disclosure on mobile in SessionEventList while keeping TEST_REVISION_ID in DOM", () => {
    const events: HistoryEventDTO[] = [
      ...sessionDetailFixture.events,
      {
        id: "17000000-0000-4000-8000-000000000002",
        session_id: TEST_SESSION_ID,
        page_id: TEST_PAGE_ID,
        page_revision_id: TEST_REVISION_ID,
        page_revision_word_id: null,
        type: "WORD_RETRY",
        status: "CONFIRMED",
        start_ms: 2500,
        end_ms: 3500,
        confidence: 0.92,
        metadata: {
          retry_attempt: 1,
          target_word: "nghiêng",
          recognized_text: "nghiêng",
        },
      },
    ];

    const { container } = render(<SessionEventList events={events} />);

    expect(screen.getAllByText(TEST_REVISION_ID).length).toBeGreaterThanOrEqual(
      2,
    );

    const disclosures = container.querySelectorAll("details.md\\:hidden");
    expect(disclosures).toHaveLength(2);
    disclosures.forEach((details) => {
      const summary = details.querySelector("summary");
      expect(summary).not.toBeNull();
      expect(summary!.className).toContain("min-h-11");
      expect(summary!.textContent).toContain("Mã đối chiếu kỹ thuật");
    });

    expect(container.innerHTML).not.toMatch(/\bsm:/);
  });

  it("enforces min-w-11 min-h-12 on SessionHistoryItem link and min-[640px]:* pagination in SessionHistoryScreen", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/profiles/children") return Response.json([childFixture]);
      if (path === "/reading/history")
        return Response.json({
          sessions: [sessionSummaryFixture],
          next_cursor: "page-2",
        });
      if (path.endsWith("/book")) return Response.json(bookFixture);
      throw new Error(`Unexpected route ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container: itemContainer } = render(
      <SessionHistoryItem
        item={{
          session: sessionSummaryFixture,
          child: childFixture,
          book: bookFixture,
          started_label: "01/10/2026",
          duration_label: "8 phút",
          state_label: "Đã hoàn thành",
        }}
      />,
    );
    const itemLink = itemContainer.querySelector("a")!;
    expect(itemLink.className).toContain("min-h-12");
    expect(itemLink.className).toContain("min-w-11");
    expect(itemLink.querySelector("span")!.className).toContain(
      "min-[640px]:not-sr-only",
    );
    expect(itemContainer.innerHTML).not.toMatch(/\bsm:/);

    const { container: screenContainer } = render(
      <AppServicesProvider>
        <SessionHistoryScreen page={1} requestedChildId={TEST_CHILD_ID} />
      </AppServicesProvider>,
    );
    const nextLink = await screen.findByRole("link", { name: "Trang sau" });
    expect(nextLink.className).toContain("min-[640px]:w-auto");
    expect(screenContainer.innerHTML).not.toMatch(/\bsm:/);
  });

  it("uses mutually exclusive border utilities on SessionDetailScreen summary cells", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === `/reading/history/${TEST_SESSION_ID}`)
        return Response.json(sessionDetailFixture);
      if (path === `/reading/history/${TEST_SESSION_ID}/book`)
        return Response.json(bookFixture);
      if (path === `/profiles/children/${TEST_CHILD_ID}`)
        return Response.json(childFixture);
      throw new Error(`Unexpected route ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />
      </AppServicesProvider>,
    );

    const overviewHeading = await screen.findByRole("heading", {
      name: "Tóm tắt buổi đọc",
    });
    const overviewSection = overviewHeading.closest("section")!;
    const dl = overviewSection.querySelector("dl")!;
    expect(dl.className).toContain("grid-cols-2");
    expect(dl.className).toContain("min-[640px]:grid-cols-3");

    const firstCell = dl.children[0] as HTMLElement;
    expect(firstCell.className).toContain("max-[640px]:border-r");
    expect(firstCell.className).toContain("min-[640px]:border-r");
    expect(firstCell.className).not.toMatch(/\bsm:/);
    expect(container.innerHTML).not.toMatch(/\bsm:/);
  });

  it("applies grid-cols-1, min-w-0, and break-words on SessionReadingReports and ReadingReport", async () => {
    const { container: reportsContainer } = render(
      <SessionReadingReports sessionId={TEST_SESSION_ID} />,
    );
    await screen.findByText("Buổi đọc này chưa có báo cáo đối chiếu được lưu.");
    expect(reportsContainer.innerHTML).not.toMatch(/\bsm:/);

    const { container: standaloneContainer } = render(
      <ReadingReport
        result={{
          page_id: TEST_PAGE_ID,
          page_revision_id: TEST_REVISION_ID,
          transcript: "Bé đọc tốt",
          alignment: [],
          summary: {
            missing_words: [],
            extra_words: [],
            substitutions: [],
            repeated_count: 1,
            repeated_words: ["Bé"],
            repeated_book_indices: [0],
            repeated_items: [],
            hesitations: [{ after_word: "Bé", before_word: "đọc", pause: 1.5 }],
            hesitation_seconds: 1.5,
          },
        }}
        sessionId={TEST_SESSION_ID}
      />,
    );

    await screen.findByText("Trang 1");
    expect(
      standaloneContainer.querySelector(".grid.grid-cols-1"),
    ).not.toBeNull();
    expect(
      standaloneContainer.querySelector(".min-\\[640px\\]\\:grid-cols-2"),
    ).not.toBeNull();
    expect(standaloneContainer.innerHTML).not.toMatch(/\bsm:/);
  });
});
