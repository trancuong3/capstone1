import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import { BookReportsView } from "@/components/reports/book-reports-view";
import { ChildProgressAssessmentCard } from "@/components/reports/child-progress-assessment";
import { DifficultWordsScreen } from "@/components/reports/difficult-words-screen";
import { ProgressReportScreen } from "@/components/reports/progress-report-screen";
import type { BookContentReportService } from "@/lib/api/book-content-report-service";
import type { ChildProgressAssessment } from "@/lib/api/child-progress-service";
import {
  childFixture,
  difficultWordFixture,
  progressReportFixture,
  TEST_BOOK_ID,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import type { DifficultWordDTO } from "@/types/reports";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/reports",
  query: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.query),
  useRouter: () => ({ push: navigation.push }),
}));

const { bookContentReportMock, reportServicesMock } = vi.hoisted(() => ({
  bookContentReportMock: {
    create: vi.fn(),
    listMine: vi.fn(),
    getMine: vi.fn(),
  } satisfies BookContentReportService,
  reportServicesMock: vi.fn(),
}));

vi.mock("@/hooks/use-report-services", () => ({
  useReportServices: () => reportServicesMock(),
}));

vi.mock("@/hooks/use-book-content-report-service", () => ({
  useBookContentReportService: () => bookContentReportMock,
}));

vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => ({
    isPlaying: false,
    isPaused: false,
    state: "idle" as const,
    play: vi.fn(async () => undefined),
    playWithWordTimings: vi.fn(async () => undefined),
    pause: vi.fn(),
    resume: vi.fn(async () => undefined),
    stop: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => ({
    isRecording: false,
    isSpeaking: false,
    audioLevel: 0,
    prepare: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => new Blob(["audio"], { type: "audio/webm" })),
    cancel: vi.fn(),
    getStream: vi.fn(() => null),
    getIsSpeaking: vi.fn(() => false),
    getQuality: vi.fn(() => ({
      status: "SPEECH_DETECTED" as const,
      durationMs: 900,
      speechDurationMs: 600,
      silenceDurationMs: 200,
      rms: 0.08,
      peak: 0.2,
      noiseFloor: 0.01,
      clipped: false,
      isSpeaking: false,
    })),
    getSettings: vi.fn(() => null),
  }),
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

const difficultWordWithBook: DifficultWordDTO = {
  ...difficultWordFixture,
  normalized_word: "thơm",
  display_text: "thơm",
  practice_status: "NOT_PRACTICED",
  sources: [
    {
      book_id: TEST_BOOK_ID,
      book_title: "Hoa Mùa Xuân",
      page_number: 2,
      context_phrase: "hoa thơm ngát",
      last_seen_at: "2026-10-01T00:08:00Z",
    },
  ],
};

describe("F12 Mobile Reports, Difficult Words & Book Reports (< 768px)", () => {
  beforeEach(() => {
    navigation.push.mockReset();
    navigation.pathname = "/reports";
    navigation.query = "";
    bookContentReportMock.listMine.mockReset();
    bookContentReportMock.getMine.mockReset();
    reportServicesMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders airy MobileProgressReport without .report-metrics/.pb-24 and switches cleanly to desktop", async () => {
    const media = installMatchMediaController(true);
    reportServicesMock.mockReturnValue({
      childService: {
        list: vi.fn().mockResolvedValue([childFixture]),
        get: vi.fn().mockResolvedValue(childFixture),
      },
      reportService: {
        listPeriods: vi.fn().mockResolvedValue({
          items: [
            {
              id: "period-1",
              child_id: TEST_CHILD_ID,
              period_start: "2026-09-02",
              period_end: "2026-10-01",
              generated_at: "2026-10-01T00:10:00Z",
            },
          ],
          next_cursor: null,
        }),
        get: vi.fn().mockResolvedValue(progressReportFixture),
      },
    });

    const { container } = render(
      <ProgressReportScreen requestedChildId={TEST_CHILD_ID} />,
    );

    expect(
      await screen.findByRole("heading", {
        name: `Tiến bộ của ${childFixture.alias}`,
      }),
    ).toBeInTheDocument();
    expect(container.querySelector(".report-metrics")).toBeNull();
    expect(container.querySelector(".report-metric")).toBeNull();
    expect(container.querySelector(".pb-24")).toBeNull();

    const historyLink = screen.getByRole("link", { name: "Lịch sử đọc" });
    expect(historyLink.className).toContain("min-h-11");

    const openDifficultWords = screen.getByRole("link", {
      name: "Mở mục Từ cần luyện",
    });
    expect(openDifficultWords.className).toContain("min-h-11");

    const entertainmentSummary = screen
      .getByText("Học tập qua Giải trí & Kỹ năng ngôn ngữ (V4.0)")
      .closest("summary");
    expect(entertainmentSummary?.className).toContain("min-h-11");

    act(() => {
      media.setMobile(false);
    });
    expect(container.querySelector(".report-metrics")).not.toBeNull();
    expect(
      screen.getAllByRole("heading", {
        name: `Tiến bộ của ${childFixture.alias}`,
      }),
    ).toHaveLength(1);
  });

  it("keeps ChildProgressAssessmentCard mounted and preserves selected window across mobile -> desktop -> mobile toggles", async () => {
    const media = installMatchMediaController(true);
    const user = userEvent.setup();

    reportServicesMock.mockReturnValue({
      childService: {
        list: vi.fn().mockResolvedValue([childFixture]),
        get: vi.fn().mockResolvedValue(childFixture),
      },
      reportService: {
        listPeriods: vi.fn().mockResolvedValue({
          items: [
            {
              id: "period-1",
              child_id: TEST_CHILD_ID,
              period_start: "2026-09-02",
              period_end: "2026-10-01",
              generated_at: "2026-10-01T00:10:00Z",
            },
          ],
          next_cursor: null,
        }),
        get: vi.fn().mockResolvedValue(progressReportFixture),
      },
    });

    const baseAssessment: ChildProgressAssessment = {
      child_id: TEST_CHILD_ID,
      period_start: "2026-09-01",
      period_end: "2026-11-09",
      days: 30,
      generated_at: "2026-11-09T12:00:00+07:00",
      data_status: "OK",
      score: {
        overall: 72,
        previous_overall: 68,
        delta: 4,
        grade: "GOOD",
        grade_label: "Tốt",
        components: [],
      },
      metrics: {
        sessions: 10,
        active_days: 6,
        reading_minutes: 95,
        books: 3,
        pages_compared: 12,
        words_read: 320,
        coverage_pct: 40,
        accuracy_pct: 82,
        skipped_rate_pct: 8,
        substitution_rate_pct: 10,
        hesitations: 12,
        repeated_words: 3,
        hesitations_per_100_words: 3.7,
        words_per_minute: null,
        comprehension_answered: 0,
        comprehension_first_try_pct: null,
        comprehension_by_type: [],
        retry_confirmed: 0,
        retry_failed: 0,
      },
      weekly: [],
      difficult_words: [],
      assessment: {
        source: "AI",
        model: "gemini-test",
        headline: "Đọc ổn định",
        summary: "Bé đọc đều.",
        strengths: [],
        weaknesses: [],
        actions: [],
        practice_words: [],
        encouragement: "Tiếp tục nhé!",
      },
      ai_cached: true,
    };

    const getAssessment = vi.fn(
      async (_childId: string, days: 7 | 30 | 90) => ({
        ...baseAssessment,
        days,
      }),
    );

    const { container } = render(
      <AppServicesContext.Provider
        value={
          {
            childProgressService: {
              get: getAssessment,
              generate: vi.fn(),
            },
          } as never
        }
      >
        <ProgressReportScreen requestedChildId={TEST_CHILD_ID} />
      </AppServicesContext.Provider>,
    );

    expect(await screen.findByText("Đọc ổn định")).toBeInTheDocument();
    expect(getAssessment).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("radio", { name: "90 ngày" }));
    expect(await screen.findByText("Đọc ổn định")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "90 ngày" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(getAssessment).toHaveBeenCalledTimes(2);

    const entertainmentDetails = screen
      .getByText("Học tập qua Giải trí & Kỹ năng ngôn ngữ (V4.0)")
      .closest("details") as HTMLDetailsElement;
    entertainmentDetails.open = true;

    act(() => {
      media.setMobile(false);
    });
    expect(container.querySelector(".report-metrics")).not.toBeNull();
    expect(screen.getByRole("radio", { name: "90 ngày" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(getAssessment).toHaveBeenCalledTimes(2);
    expect(entertainmentDetails.open).toBe(true);

    act(() => {
      media.setMobile(true);
    });
    expect(container.querySelector(".report-metrics")).toBeNull();
    expect(screen.getByRole("radio", { name: "90 ngày" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(getAssessment).toHaveBeenCalledTimes(2);
    expect(entertainmentDetails.open).toBe(true);
  });

  it("renders >= 44px period radio buttons and scrollable weekly chart in ChildProgressAssessmentCard", async () => {
    installMatchMediaController(true);
    const assessmentData: ChildProgressAssessment = {
      child_id: TEST_CHILD_ID,
      period_start: "2026-09-01",
      period_end: "2026-11-09",
      days: 30,
      generated_at: "2026-11-09T12:00:00+07:00",
      data_status: "OK",
      score: {
        overall: 72,
        previous_overall: 68,
        delta: 4,
        grade: "GOOD",
        grade_label: "Tốt",
        components: [],
      },
      metrics: {
        sessions: 10,
        active_days: 6,
        reading_minutes: 95,
        books: 3,
        pages_compared: 12,
        words_read: 320,
        coverage_pct: 40,
        accuracy_pct: 82,
        skipped_rate_pct: 8,
        substitution_rate_pct: 10,
        hesitations: 12,
        repeated_words: 3,
        hesitations_per_100_words: 3.7,
        words_per_minute: null,
        comprehension_answered: 0,
        comprehension_first_try_pct: null,
        comprehension_by_type: [],
        retry_confirmed: 0,
        retry_failed: 0,
      },
      weekly: Array.from({ length: 7 }, (_, i) => ({
        week_start: `2026-09-${String(1 + i * 7).padStart(2, "0")}`,
        sessions: 2,
        minutes: 15 + i * 5,
        accuracy_pct: 80,
      })),
      difficult_words: [],
      assessment: {
        source: "AI",
        model: "gemini-test",
        headline: "Đọc ổn định",
        summary: "Bé đọc đều.",
        strengths: [],
        weaknesses: [],
        actions: [],
        practice_words: [],
        encouragement: "Tiếp tục nhé!",
      },
      ai_cached: true,
    };

    const { container } = render(
      <AppServicesContext.Provider
        value={
          {
            childProgressService: {
              get: vi.fn().mockResolvedValue(assessmentData),
              generate: vi.fn(),
            },
          } as never
        }
      >
        <ChildProgressAssessmentCard
          childId={TEST_CHILD_ID}
          childName={childFixture.alias}
        />
      </AppServicesContext.Provider>,
    );

    expect(await screen.findByText("Đọc ổn định")).toBeInTheDocument();
    for (const label of ["7 ngày", "30 ngày", "90 ngày"]) {
      const radio = screen.getByRole("radio", { name: label });
      expect(radio.className).toContain("min-h-11");
    }
    expect(container.querySelector(".overflow-x-auto")).not.toBeNull();
  });

  it("renders MobileDifficultWordsList with >= 44px pills, min-h-12 chips, and viread:immersive-mode", async () => {
    installMatchMediaController(true);
    navigation.pathname = "/reports/difficult-words";
    const user = userEvent.setup();

    reportServicesMock.mockReturnValue({
      childService: {
        list: vi.fn().mockResolvedValue([childFixture]),
        get: vi.fn().mockResolvedValue(childFixture),
      },
      difficultWordService: {
        list: vi.fn().mockResolvedValue([difficultWordWithBook]),
        getPracticeHistory: vi
          .fn()
          .mockResolvedValue({ storage_ready: true, items: [] }),
        evaluatePracticeWord: vi.fn(),
      },
    });

    const immersiveEvents: boolean[] = [];
    const listener = (ev: Event) => {
      immersiveEvents.push(
        Boolean((ev as CustomEvent<{ active?: boolean }>).detail?.active),
      );
    };
    window.addEventListener("viread:immersive-mode", listener);

    const { container, unmount } = render(
      <DifficultWordsScreen requestedChildId={TEST_CHILD_ID} />,
    );

    expect(
      await screen.findByRole("heading", {
        name: `Từ cần luyện của ${childFixture.alias}`,
      }),
    ).toBeInTheDocument();
    expect(container.querySelector(".pb-24")).toBeNull();

    const backLink = screen.getByRole("link", { name: "Báo cáo" });
    expect(backLink.className).toContain("min-h-11");

    const allPill = screen.getByRole("button", { name: "Tất cả" });
    expect(allPill.className).toContain("min-h-11");

    const wordChip = screen.getByRole("button", { name: /Luyện từ thơm/i });
    expect(wordChip.className).toContain("min-h-12");

    const parentDetailsSummary = screen
      .getByText("Chi tiết cho phụ huynh")
      .closest("summary");
    expect(parentDetailsSummary?.className).toContain("min-h-11");

    await user.click(wordChip);
    await waitFor(() => {
      expect(immersiveEvents).toContain(true);
    });

    const practiceHistorySummary = screen
      .getByText(/Lịch sử luyện từ này/i)
      .closest("summary");
    expect(practiceHistorySummary?.className).toContain("min-h-11");

    await user.click(
      screen.getByRole("button", { name: /Quay về danh sách/i }),
    );
    await waitFor(() => {
      expect(immersiveEvents.at(-1)).toBe(false);
    });

    unmount();
    window.removeEventListener("viread:immersive-mode", listener);
  });

  it("renders MobileBookReportsScreen on < 768px with min-h-11 buttons (no h-9) and switches to desktop", async () => {
    const media = installMatchMediaController(true);
    const user = userEvent.setup();
    const reportId = "77000000-0000-4000-8000-000000000001";

    bookContentReportMock.listMine.mockResolvedValue({
      items: [
        {
          id: reportId,
          book_id: TEST_BOOK_ID,
          book_title: "Truyện Thiếu Nhi",
          reporter_name: "Phụ huynh A",
          page_id: null,
          page_number: 2,
          page_revision_id: null,
          issue_type: "CHILD_SAFETY_CONCERN",
          description: "Cảnh báo từ ngữ không phù hợp.",
          reported_text: null,
          suggested_correction: null,
          status: "RESOLVED",
          scan_run_id: null,
          created_at: "2026-11-21T08:30:00Z",
          updated_at: "2026-11-21T08:30:00Z",
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });
    bookContentReportMock.getMine.mockResolvedValue({
      id: reportId,
      book_id: TEST_BOOK_ID,
      book_title: "Truyện Thiếu Nhi",
      reporter_id: "11000000-0000-4000-8000-000000000001",
      reporter_name: "Phụ huynh A",
      page_id: null,
      page_number: 2,
      page_revision_id: null,
      issue_type: "CHILD_SAFETY_CONCERN",
      description: "Cảnh báo từ ngữ không phù hợp.",
      reported_text: null,
      suggested_correction: null,
      status: "RESOLVED",
      scan_run_id: null,
      created_at: "2026-11-21T08:30:00Z",
      updated_at: "2026-11-21T08:30:00Z",
      verified_text_snapshot: null,
      content_hash_snapshot: null,
      admin_resolution_note: "Admin đã xử lý xong.",
      reviewed_by: null,
      reviewed_by_name: "Admin QA",
      resolved_at: "2026-11-21T09:00:00Z",
      history: [],
      related_findings: [],
    });

    render(<BookReportsView />);

    expect(
      await screen.findByRole("heading", { name: "Báo cáo chất lượng sách" }),
    ).toBeInTheDocument();

    const detailBtn = await screen.findByRole("button", {
      name: /Xem chi tiết & phản hồi Admin/i,
    });
    expect(detailBtn.className).toContain("min-h-11");
    expect(detailBtn.className).not.toContain("h-9");

    await user.click(detailBtn);
    expect(await screen.findByTestId("parent-report-detail")).toHaveTextContent(
      /Admin đã xử lý xong/i,
    );

    act(() => {
      media.setMobile(false);
    });
    expect(
      await screen.findByRole("button", {
        name: /Xem chi tiết & phản hồi Admin/i,
      }),
    ).toBeInTheDocument();
  });
});
