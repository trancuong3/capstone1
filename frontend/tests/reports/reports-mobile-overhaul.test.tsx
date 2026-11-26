import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { DifficultWordBookCard } from "@/components/reports/difficult-word-book-card";
import { DifficultWordItem } from "@/components/reports/difficult-word-item";
import { DifficultWordPracticePanel } from "@/components/reports/difficult-word-practice-panel";
import { DifficultWordsScreen } from "@/components/reports/difficult-words-screen";
import { MetricCard } from "@/components/reports/metric-card";
import { ProgressReportFilters } from "@/components/reports/progress-report-filters";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import {
  childFixture,
  difficultWordFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import type { DifficultWordBookGroup, DifficultWordDTO } from "@/types/reports";

const {
  reportServicesMock,
  speechPlayerMock,
  speechRecorderMock,
  recordingPlaybackMock,
} = vi.hoisted(() => ({
  reportServicesMock: vi.fn(),
  speechPlayerMock: {
    isPlaying: false,
    isPaused: false,
    state: "idle" as const,
    fallbackNotice: null,
    play: vi.fn(async () => undefined),
    playPhonicsLesson: vi.fn(async () => undefined),
    playWithWordTimings: vi.fn(async () => undefined),
    pause: vi.fn(),
    resume: vi.fn(async () => undefined),
    stop: vi.fn(),
  },
  speechRecorderMock: {
    isRecording: false,
    isSpeaking: false,
    audioLevel: 0,
    prepare: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => new Blob(["wav"], { type: "audio/wav" })),
    cancel: vi.fn(),
    getStream: vi.fn(() => null),
    getIsSpeaking: vi.fn(() => false),
    getQuality: vi.fn(() => undefined),
  },
  recordingPlaybackMock: {
    playing: false,
    error: null,
    stop: vi.fn(),
    toggle: vi.fn(async () => undefined),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/reports/difficult-words",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-report-services", () => ({
  useReportServices: reportServicesMock,
}));
vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => speechPlayerMock,
}));
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => speechRecorderMock,
}));
vi.mock("@/hooks/use-recording-playback", () => ({
  useRecordingPlayback: () => recordingPlaybackMock,
}));
vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => ({
    listVoices: vi.fn().mockResolvedValue({ voices: [], default_voice_id: "" }),
    synthesizeTimed: vi.fn(),
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const LONG_COMPOUND_WORD: DifficultWordDTO = {
  ...difficultWordFixture,
  normalized_word: "nghiengngachongchenhdai",
  display_text: "nghiêngngảchôngchênhdài",
  practice_status: "NOT_PRACTICED",
  sources: [
    {
      book_id: "11111111-1111-4111-8111-111111111111",
      book_title: "Cuốn sách có tiêu đề rất dài cho màn hình nhỏ",
      page_number: 3,
      context_phrase: "con đường nghiêngngảchôngchênhdài quanh sườn đồi",
      last_seen_at: "2026-11-25T00:00:00Z",
    },
  ],
};

describe("F10.1 & F10.2 mobile overhaul layout and touch targets", () => {
  it("keeps ProgressReportFilters ChildSelector hidden on < md, >= 44px select, and min-[640px]:w-auto button", () => {
    render(
      <ProgressReportFilters
        childId={TEST_CHILD_ID}
        childrenProfiles={[childFixture]}
        hasMore
        loadingMore={false}
        onLoadMore={vi.fn()}
        periods={[
          {
            id: "period-1",
            child_id: TEST_CHILD_ID,
            period_start: "2026-10-01",
            period_end: "2026-10-31",
            generated_at: "2026-11-01T00:00:00Z",
          },
        ]}
        selectedPeriod={null}
      />,
    );

    const childSelect = screen.getByLabelText("Chọn hồ sơ bé để xem dữ liệu");
    expect(childSelect.parentElement?.className).toContain("hidden");
    expect(childSelect.parentElement?.className).toContain("md:block");

    const periodSelect = screen.getByLabelText("Kỳ báo cáo đã lưu");
    expect(periodSelect.className).toContain("min-h-11");

    const loadMoreBtn = screen.getByRole("button", { name: "Tải thêm kỳ" });
    expect(loadMoreBtn.className).toContain("min-h-11");
    expect(loadMoreBtn.className).toContain("min-[640px]:w-auto");
    expect(loadMoreBtn.className).not.toMatch(/\bsm:/);
  });

  it("uses 4-column retry metrics at >= 640px in ReadingAssessmentSummary and md: typography in MetricCard", () => {
    const { container } = render(
      <>
        <MetricCard
          delta={{ label: "+2 buổi", tone: "positive" }}
          metric={{
            id: "sessions",
            label: "Số buổi đọc",
            value: "8",
            hint: "Trong kỳ",
            unavailable: false,
          }}
        />
        <ReadingAssessmentSummary
          assessment={{
            first_pass_correct: 12,
            first_pass_incorrect: 3,
            self_corrected_words: 2,
            unresolved_words: 1,
            retry_attempts: 4,
            skipped_after_retry_limit: 0,
            recognition_uncertain: 1,
          }}
        />
      </>,
    );

    const retryDt = screen.getByText("Bé đã tự sửa đúng");
    const retryDl = retryDt.closest("dl");
    expect(retryDl).not.toBeNull();
    expect(retryDl!.className).toContain("min-[640px]:grid-cols-4");
    expect(retryDl!.className).not.toMatch(/\bsm:/);

    const metricHeading = screen.getByRole("heading", { name: "Số buổi đọc" });
    expect(metricHeading.className).toContain("md:text-sm");
    expect(metricHeading.className).not.toMatch(/\bsm:/);
    expect(container.innerHTML).not.toMatch(/\bsm:/);
  });

  it("renders DifficultWordsScreen mobile status pills (>= 44px) and desktop select without breaking selector contracts", async () => {
    reportServicesMock.mockReturnValue({
      childService: {
        list: vi.fn().mockResolvedValue([childFixture]),
        get: vi.fn().mockResolvedValue(childFixture),
      },
      difficultWordService: {
        list: vi.fn().mockResolvedValue([LONG_COMPOUND_WORD]),
        getPracticeHistory: vi
          .fn()
          .mockResolvedValue({ storage_ready: true, items: [] }),
      },
    });

    const { container } = render(
      <DifficultWordsScreen requestedChildId={TEST_CHILD_ID} />,
    );

    const pillGroup = await screen.findByRole("group", {
      name: "Lọc nhanh theo trạng thái luyện",
    });
    expect(pillGroup.parentElement?.className).toContain("md:hidden");

    for (const label of [
      "Tất cả",
      "Chưa luyện",
      "Đang luyện",
      "Cần thêm",
      "Đã xong",
    ]) {
      const btn = within(pillGroup).getByRole("button", { name: label });
      expect(btn.className).toContain("min-h-11");
    }

    const desktopSelect = screen.getByLabelText("Lọc theo trạng thái luyện");
    expect(desktopSelect.closest(".md\\:contents")).not.toBeNull();

    const chipBtn = screen.getByRole("button", {
      name: /Luyện từ nghiêngngảchôngchênhdài/,
    });
    expect(chipBtn.className).toContain("min-h-12");
    expect(chipBtn.className).toContain("max-w-full");
    expect(
      within(chipBtn).getByText("nghiêngngảchôngchênhdài").className,
    ).toContain("break-words");
    expect(container.innerHTML).not.toMatch(/\bsm:/);
  });

  it("wraps long book titles/chips in DifficultWordBookCard and uses min-[640px]:w-60 in DifficultWordItem", () => {
    const group: DifficultWordBookGroup = {
      key: "book-1",
      bookId: "11111111-1111-4111-8111-111111111111",
      bookTitle: "Cuốn sách siêu dài",
      bookAuthor: "Tác giả",
      bookCoverUrl: null,
      minGrade: 1,
      maxGrade: 2,
      words: [LONG_COMPOUND_WORD],
      completedWords: 0,
      totalWords: 1,
      progressPercent: 0,
      latestSeenAt: "2026-11-25T00:00:00Z",
    };

    const { container } = render(
      <AppServicesProvider>
        <DifficultWordBookCard
          group={group}
          onSelectWord={vi.fn()}
          onStartBookPractice={vi.fn()}
        />
        <DifficultWordItem childId={TEST_CHILD_ID} word={LONG_COMPOUND_WORD} />
      </AppServicesProvider>,
    );

    const practiceBtn = screen.getByRole("button", { name: "Luyện từ" });
    expect(practiceBtn.className).toContain("min-[640px]:w-60");
    expect(practiceBtn.className).not.toMatch(/\bsm:/);
    expect(container.innerHTML).not.toMatch(/\bsm:/);
  });

  it("toggles single VoiceEngineBadge on mobile, wraps long practice heading, and enforces >= 44px summary in DifficultWordPracticePanel", async () => {
    const user = userEvent.setup();
    reportServicesMock.mockReturnValue({
      childService: {
        list: vi.fn().mockResolvedValue([childFixture]),
        get: vi.fn().mockResolvedValue(childFixture),
      },
      difficultWordService: {
        list: vi.fn().mockResolvedValue([LONG_COMPOUND_WORD]),
        getPracticeHistory: vi
          .fn()
          .mockResolvedValue({ storage_ready: true, items: [] }),
        evaluatePracticeWord: vi.fn(),
      },
    });

    const { container } = render(
      <DifficultWordPracticePanel
        child={childFixture}
        onClose={vi.fn()}
        onProgressSaved={vi.fn()}
        onSelectWord={vi.fn()}
        word={LONG_COMPOUND_WORD}
        words={[LONG_COMPOUND_WORD]}
      />,
    );

    const heading = await screen.findByRole("heading", {
      name: "nghiêngngảchôngchênhdài",
    });
    expect(heading.className).toContain("max-w-full");
    expect(heading.className).toContain("break-words");
    expect(heading.className).toContain("[overflow-wrap:anywhere]");
    expect(heading.className).toContain("text-3xl");
    expect(heading.className).toContain("min-[640px]:text-4xl");
    expect(heading.className).toContain("md:text-6xl");

    // Exactly one VoiceEngineBadge instance in the DOM
    const badges = screen.getAllByTestId("voice-engine-status-badge");
    expect(badges).toHaveLength(1);
    const badgeWrapper = badges[0].parentElement!;
    expect(badgeWrapper.className).toContain("hidden");
    expect(badgeWrapper.className).toContain("md:inline-flex");

    const toggleBtn = screen.getByRole("button", {
      name: "Xem nguồn giọng đọc",
    });
    expect(toggleBtn.className).toContain("min-h-11");
    expect(toggleBtn.className).toContain("md:hidden");
    expect(toggleBtn).toHaveAttribute("aria-expanded", "false");

    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
    expect(badgeWrapper.className).toContain("flex");
    expect(badgeWrapper.className).not.toContain("hidden");
    expect(screen.getAllByTestId("voice-engine-status-badge")).toHaveLength(1);

    const historySummary = screen
      .getByText(/Lịch sử luyện từ này/)
      .closest("summary");
    expect(historySummary).not.toBeNull();
    expect(historySummary!.className).toContain("min-h-11");
    expect(container.innerHTML).not.toMatch(/\bsm:/);
  });
});
