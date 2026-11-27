import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SessionHistoryScreen } from "@/components/reports/session-history-screen";
import { SessionDetailScreen } from "@/components/reports/session-detail-screen";
import { ProgressReportScreen } from "@/components/reports/progress-report-screen";
import { DifficultWordsScreen } from "@/components/reports/difficult-words-screen";
import { DifficultWordItem } from "@/components/reports/difficult-word-item";

const mockSpeechPlayer = {
  isPlaying: false,
  isPaused: false,
  state: "idle" as const,
  play: vi.fn(async () => undefined),
  playWithWordTimings: vi.fn(async () => undefined),
  pause: vi.fn(),
  resume: vi.fn(async () => undefined),
  stop: vi.fn(),
};

const mockSpeechRecorder = {
  isRecording: false,
  isSpeaking: false,
  audioLevel: 0,
  prepare: vi.fn(async () => undefined),
  start: vi.fn(async () => {
    mockSpeechRecorder.isRecording = true;
    mockSpeechRecorder.isSpeaking = true;
    mockSpeechRecorder.audioLevel = 45;
  }),
  stop: vi.fn(async () => {
    mockSpeechRecorder.isRecording = false;
    mockSpeechRecorder.isSpeaking = false;
    mockSpeechRecorder.audioLevel = 0;
    return new Blob(["audio-sample"], { type: "audio/webm" });
  }),
  cancel: vi.fn(() => {
    mockSpeechRecorder.isRecording = false;
    mockSpeechRecorder.isSpeaking = false;
    mockSpeechRecorder.audioLevel = 0;
  }),
  getStream: vi.fn(() => null),
  getIsSpeaking: vi.fn(() => false),
  getQuality: vi.fn(() => ({
    status: "SPEECH_DETECTED" as const,
    durationMs: 1100,
    speechDurationMs: 750,
    silenceDurationMs: 200,
    rms: 0.08,
    peak: 0.2,
    noiseFloor: 0.01,
    clipped: false,
    isSpeaking: false,
  })),
  getSettings: vi.fn(() => null),
};

vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => mockSpeechPlayer,
}));
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => {
    const [isRecording, setIsRecording] = useState(false);
    return {
      ...mockSpeechRecorder,
      isRecording,
      start: async () => {
        await mockSpeechRecorder.start();
        setIsRecording(true);
      },
      stop: async () => {
        const blob = await mockSpeechRecorder.stop();
        setIsRecording(false);
        return blob;
      },
      cancel: () => {
        mockSpeechRecorder.cancel();
        setIsRecording(false);
      },
    };
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/sessions",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
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

const childId = "22222222-2222-4222-8222-222222222222";
const sessionId = "44444444-4444-4444-8444-444444444444";
const bookId = "33333333-3333-4333-8333-333333333333";
const child = {
  id: childId,
  parent_id: bookId,
  alias: "Bé từ API",
  grade: 2,
  settings: {},
  created_at: "2026-10-08T00:00:00Z",
};
const book = {
  id: bookId,
  title: "Sách lịch sử đã ngừng phát hành",
  author: null,
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "RETIRED",
};
const summary = {
  id: sessionId,
  child_id: childId,
  book_id: bookId,
  state: "ABORTED",
  started_at: "2026-10-08T01:00:00Z",
  ended_at: null,
  duration_ms: null,
};
const detail = {
  ...summary,
  selected_page_revision_ids: [],
  reference_page_revision_ids: [],
  events: [],
  fluency_assessment: null,
  comprehension: [],
  report_id: null,
  availability: {
    events: "absent",
    fluency: "absent",
    comprehension: "absent",
  },
};
const word = {
  normalized_word: "meo",
  display_text: "Mèo API",
  difficulty_score: 3,
  omission_count: 1,
  repetition_count: 0,
  long_pause_count: 0,
  read_example_count: 0,
  session_count: 1,
  last_seen_at: "2026-10-08T01:00:00Z",
  evidence_word_ids: [bookId],
};
const fetchMock = vi.fn();

function readyResponse(url: string): Response {
  if (url.includes("/profiles/children/")) return Response.json(child);
  if (url.includes("/profiles/children")) return Response.json([child]);
  if (url.endsWith("/book")) return Response.json(book);
  if (url.includes(`/reading/history/${sessionId}`))
    return Response.json(detail);
  if (url.includes("/reading/history?"))
    return Response.json({ sessions: [summary], next_cursor: "page-2" });
  if (url.includes("/system/difficult-words/")) return Response.json([word]);
  if (url.includes("/system/progress/")) {
    const query = new URL(url).searchParams;
    if (new URL(url).pathname.endsWith("/periods"))
      return Response.json({
        items: [
          {
            id: sessionId,
            child_id: childId,
            period_start: "2026-09-09",
            period_end: "2026-10-08",
            generated_at: "2026-10-08T01:00:00Z",
          },
        ],
        next_cursor: null,
      });
    return Response.json({
      id: sessionId,
      generated_at: "2026-10-08T01:00:00Z",
      legacy: null,
      data_status: "complete",
      availability: {
        metrics: "available",
        difficult_words: "available",
        comparison: "absent",
      },
      child_id: childId,
      period_start: query.get("period_start") ?? "2026-09-09",
      period_end: query.get("period_end") ?? "2026-10-08",
      completed_sessions: 2,
      reading_duration_ms: 120000,
      omission_count: 1,
      repetition_count: 0,
      long_pause_count: 0,
      omission_rate: null,
      repetition_rate: null,
      long_pause_rate: null,
      comprehension_accuracy: null,
      difficult_words: [],
      previous_period: null,
      trend_deltas: {
        completed_sessions: null,
        reading_duration_ms: null,
        omission_rate: null,
        repetition_rate: null,
        long_pause_rate: null,
        comprehension_accuracy: null,
      },
    });
  }
  throw new Error("Unexpected test API route");
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => readyResponse(url));
  vi.stubGlobal("fetch", fetchMock);
  mockSpeechPlayer.play.mockReset().mockResolvedValue(undefined);
  mockSpeechPlayer.stop.mockReset();
  mockSpeechRecorder.isRecording = false;
  mockSpeechRecorder.isSpeaking = false;
  mockSpeechRecorder.audioLevel = 0;
  mockSpeechRecorder.start.mockClear();
  mockSpeechRecorder.stop.mockClear();
  mockSpeechRecorder.cancel.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("Parent report UI through real adapters and HTTP test doubles", () => {
  it.each([0, -1, 100001, Number.NaN, Number.POSITIVE_INFINITY, 2.5])(
    "uses first page for invalid history page %s without forwarding an invalid cursor",
    async (page) => {
      render(
        <AppServicesProvider>
          <SessionHistoryScreen page={page} />
        </AppServicesProvider>,
      );
      await screen.findByRole("heading", { name: book.title });
      expect(
        fetchMock.mock.calls
          .filter(([url]) => String(url).includes("/reading/history?"))
          .every(([url]) => !new URL(String(url)).searchParams.has("cursor")),
      ).toBe(true);
      expect(
        screen.queryByRole("link", { name: "Trang trước" }),
      ).not.toBeInTheDocument();
    },
  );
  it("shows loading while history has not arrived", async () => {
    let resolveHistory: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveHistory = resolve;
    });
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/reading/history?") ? pending : readyResponse(url),
    );
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={1} />
      </AppServicesProvider>,
    );
    expect(screen.getByLabelText("Đang tải lịch sử đọc")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/reading/history?"),
        ),
      ).toBe(true),
    );
    resolveHistory(Response.json({ sessions: [], next_cursor: null }));
    expect(
      await screen.findByRole("heading", { name: "Chưa có buổi đọc" }),
    ).toBeInTheDocument();
  });
  it("shows owned history for retired books without requesting current catalog", async () => {
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={1} />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
    expect(screen.getByText("Chưa có dữ liệu thời lượng")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trang sau" })).toHaveAttribute(
      "href",
      `/sessions?childId=${childId}&page=2`,
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/books/catalog"),
      ),
    ).toBe(false);
  });
  it("passes page cursor and shows previous-page navigation", async () => {
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={2} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: book.title });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("cursor=page-2"),
      ),
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Trang trước" })).toHaveAttribute(
      "href",
      `/sessions?childId=${childId}&page=1`,
    );
  });
  it("keeps optional details unknown instead of displaying sample metrics", async () => {
    render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={sessionId} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Buổi đọc đã dừng" });
    expect(screen.getByText("Chưa đánh giá")).toBeInTheDocument();
    expect(screen.getAllByText("Chưa ghi nhận")).toHaveLength(2);
    expect(
      screen.getByText("Buổi đọc này chưa có sự kiện để hiển thị."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Buổi đọc này không có câu hỏi đọc hiểu."),
    ).toBeInTheDocument();
    expect(screen.queryByText("0 từ/phút")).not.toBeInTheDocument();
  });
  it("shows actual report counts with missing previous period", async () => {
    render(
      <AppServicesProvider>
        <ProgressReportScreen />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", {
      name: `Tiến bộ của ${child.alias}`,
    });
    expect(screen.getByText("2 buổi")).toBeInTheDocument();
    expect(screen.getByText("Chưa đủ kỳ so sánh")).toBeInTheDocument();
  });
  it("shows actual stored words grouped by book", async () => {
    render(
      <AppServicesProvider>
        <DifficultWordsScreen />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("button", {
        name: new RegExp(word.display_text),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Chưa xác định nguồn sách" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Điểm 3/)).toBeInTheDocument();
  });
  it("distinguishes an actual empty word list from unavailable data", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/system/difficult-words/")
        ? Response.json([])
        : readyResponse(url),
    );
    render(
      <AppServicesProvider>
        <DifficultWordsScreen />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Chưa có từ cần luyện" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Dữ liệu đang chờ bổ sung"),
    ).not.toBeInTheDocument();
  });
  it.each([
    ["history", <SessionHistoryScreen key="history" page={1} />],
    ["detail", <SessionDetailScreen key="detail" sessionId={sessionId} />],
    ["progress", <ProgressReportScreen key="progress" />],
    ["words", <DifficultWordsScreen key="words" />],
  ])(
    "shows unavailable and retries %s without runtime fallback",
    async (_name, element) => {
      const user = userEvent.setup();
      fetchMock.mockImplementation(async (url: string) =>
        url.includes("/profiles/children")
          ? readyResponse(url)
          : Response.json({ detail: "private sql token" }, { status: 501 }),
      );
      render(<AppServicesProvider>{element}</AppServicesProvider>);
      expect(
        await screen.findByRole("heading", {
          name: "Dữ liệu đang chờ bổ sung",
        }),
      ).toBeInTheDocument();
      expect(screen.queryByText("private sql token")).not.toBeInTheDocument();
      fetchMock.mockImplementation(async (url: string) => readyResponse(url));
      await user.click(screen.getByRole("button", { name: "Thử lại" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "Dữ liệu đang chờ bổ sung" }),
        ).not.toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(screen.queryByLabelText(/Đang tải/)).not.toBeInTheDocument(),
      );
    },
  );
  it("does not request history for an inaccessible child", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/profiles/children/")
        ? Response.json({}, { status: 404 })
        : readyResponse(url),
    );
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={1} requestedChildId={bookId} />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByText("Không tìm thấy lịch sử"),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/reading/")),
    ).toBe(false);
  });
  it("no children prompts profile creation without reading reports", async () => {
    fetchMock.mockImplementation(async () => Response.json([]));
    render(
      <AppServicesProvider>
        <ProgressReportScreen />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Chưa có dữ liệu báo cáo" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tạo hồ sơ bé" })).toHaveAttribute(
      "href",
      "/children/new",
    );
    expect(
      fetchMock.mock.calls.every(([url]) =>
        String(url).includes("/profiles/children"),
      ),
    ).toBe(true);
  });
  it("practice starts real backend attempt and handles unmigrated 503 safely", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { detail: "DIFFICULT_WORD_PRACTICE_STORAGE_UNAVAILABLE" },
        { status: 503 },
      ),
    );
    render(
      <AppServicesProvider>
        <DifficultWordItem childId={childId} word={word} />
      </AppServicesProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Luyện từ" }));
    expect(
      await screen.findByText(/chưa được khởi tạo bảng dữ liệu/i),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/mô phỏng chữ/)).not.toBeInTheDocument();
  });

  it("opens book-grouped hands-free practice flow, completes in 1 read, recovers save failures, and syncs progress", async () => {
    const user = userEvent.setup();
    const attemptId1 = "88888888-8888-4888-8888-888888888881";
    const wordCo = {
      ...word,
      normalized_word: "có",
      display_text: "có",
      difficulty_score: 4,
      practice_status: "NOT_PRACTICED",
      practice_attempts_count: 0,
      consecutive_correct_count: 0,
      sources: [
        {
          book_id: bookId,
          book_title: "Chào ngày mới",
          book_author: "Minh Anh",
          min_grade: 1,
          max_grade: 1,
          session_id: sessionId,
          page_number: 2,
          context_phrase: "Bé có một bông hoa.",
          last_seen_at: "2026-11-18T02:00:00Z",
        },
      ],
    };
    const wordNgapNgung = {
      ...word,
      normalized_word: "ngập ngừng",
      display_text: "ngập ngừng",
      difficulty_score: 2,
      practice_status: "COMPLETED",
      practice_attempts_count: 1,
      consecutive_correct_count: 1,
      sources: [
        {
          book_id: bookId,
          book_title: "Chào ngày mới",
          book_author: "Minh Anh",
          min_grade: 1,
          max_grade: 1,
          session_id: sessionId,
          page_number: 3,
          last_seen_at: "2026-11-18T02:00:00Z",
        },
      ],
    };
    let wordsState = [wordCo, wordNgapNgung];
    const historyItems: Record<string, unknown>[] = [];
    let failFirstSave = true;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/practice/history")) {
        return Response.json({ storage_ready: true, items: historyItems });
      }
      if (url.endsWith("/practice/evaluate") && init?.method === "POST") {
        if (failFirstSave) {
          failFirstSave = false;
          return Response.json(
            { detail: "Temporary save failure" },
            { status: 500 },
          );
        }
        wordsState = [
          {
            ...wordCo,
            practice_status: "COMPLETED",
            practice_attempts_count: 1,
            consecutive_correct_count: 1,
          },
          wordNgapNgung,
        ];
        historyItems.unshift({
          attempt_id: attemptId1,
          normalized_word: "có",
          display_text: "có",
          attempt_number: 1,
          state: "COMPLETED",
          assessment_status: "CORRECT",
          recognition_source: "SERVER_STT",
          spoken_transcript: "có",
          confidence: null,
          audio_duration_ms: 820,
          assessment_version: 1,
          started_at: "2026-11-18T02:00:00Z",
          completed_at: "2026-11-18T02:00:02Z",
        });
        return Response.json({
          attempt_id: attemptId1,
          child_id: childId,
          normalized_word: "có",
          display_text: "có",
          attempt_number: 1,
          state: "COMPLETED",
          assessment_status: "CORRECT",
          recognition_source: "SERVER_STT",
          spoken_transcript: "có",
          confidence: null,
          audio_duration_ms: 820,
          assessment_version: 1,
          evidence_word_ids: [bookId],
          persistence_backend: "READING_EVENT",
          resolved_in_session: true,
          started_at: "2026-11-18T02:00:00Z",
          completed_at: "2026-11-18T02:00:02Z",
          feedback_message: "Chính xác rồi! Con giỏi lắm!",
          word_progress: {
            normalized_word: "có",
            practice_status: "COMPLETED",
            practice_attempts_count: 1,
            practice_correct_count: 1,
            practice_incorrect_count: 0,
            practice_uncertain_count: 0,
            consecutive_correct_count: 1,
            required_consecutive_correct: 1,
            last_practiced_at: "2026-11-18T02:00:02Z",
            last_practice_status: "CORRECT",
          },
          next_recommended_word: null,
          evidence_count_unchanged: true,
        });
      }
      if (url.includes("/system/difficult-words/")) {
        return Response.json(wordsState);
      }
      return readyResponse(url);
    });

    render(
      <AppServicesProvider>
        <DifficultWordsScreen />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Chào ngày mới" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Đã luyện đúng 1\/2 từ/)).toBeInTheDocument();

    // Status filter pills narrow chips inside book group
    await user.click(screen.getByRole("button", { name: /^Đã thuộc/ }));
    expect(
      screen.queryByRole("button", { name: /Luyện từ có/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Luyện từ ngập ngừng/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Tất cả/ }));

    mockSpeechRecorder.start.mockRejectedValueOnce(
      new DOMException("Denied", "NotAllowedError"),
    );
    // Start practice from the book CTA and exercise automatic mic denial.
    await user.click(screen.getByRole("button", { name: "Luyện cùng bé" }));
    expect(
      await screen.findByRole("heading", { name: "có" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Bé có một bông hoa\./)).toBeInTheDocument();
    expect(
      await screen.findByText(/chưa được cấp quyền Micro/i),
    ).toBeInTheDocument();

    // Sample TTS failure shows honest guidance
    mockSpeechPlayer.play.mockRejectedValueOnce(new Error("No vi-VN voice"));
    await user.click(screen.getByRole("button", { name: "Nghe phát âm mẫu" }));
    expect(
      await screen.findByText(/chưa phát được giọng đọc mẫu tiếng Việt/i),
    ).toBeInTheDocument();

    // Sample TTS success
    mockSpeechPlayer.play.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Nghe phát âm mẫu" }));
    expect(mockSpeechPlayer.play).toHaveBeenCalledWith(
      "có",
      expect.objectContaining({
        wordSample: true,
        cacheScope: expect.stringMatching(/^(CATALOG|PRIVATE)$/),
      }),
    );

    // The retry action reopens the microphone. Saving reuses the same recording.
    await user.click(screen.getByRole("button", { name: /Tiếp tục luyện/ }));
    expect(
      await screen.findByRole("button", { name: "Dừng ghi âm" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dừng ghi âm" }));

    expect(
      await screen.findByRole("button", { name: "Lưu lại kết quả" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lưu lại kết quả" }));

    expect(
      await screen.findByText(/Chính xác rồi! Con giỏi lắm!/i),
    ).toBeInTheDocument();

    // Return to list -> progress bar updates immediately to 2/2 (100%)
    await user.click(screen.getByRole("button", { name: "Quay về danh sách" }));
    expect(
      await screen.findByText(/Đã luyện đúng 2\/2 từ/),
    ).toBeInTheDocument();
  });

  it("audits tap budget and auto-completes 'một' -> 'bông' in hands-free mode with zero extra taps", async () => {
    const user = userEvent.setup();
    const attemptId1 = "93000000-0000-4000-8000-000000000001";
    const attemptId2 = "93000000-0000-4000-8000-000000000002";
    const wordMot = {
      normalized_word: "một",
      display_text: "một",
      difficulty_score: 4,
      omission_count: 0,
      repetition_count: 0,
      long_pause_count: 0,
      read_example_count: 0,
      session_count: 1,
      last_seen_at: "2026-11-18T02:00:00Z",
      evidence_word_ids: [bookId],
      mispronunciation_count: 1,
      encounter_count: 1,
      practice_status: "NOT_PRACTICED",
      practice_attempts_count: 0,
      practice_correct_count: 0,
      practice_incorrect_count: 0,
      practice_uncertain_count: 0,
      consecutive_correct_count: 0,
      last_practiced_at: null,
      last_practice_status: null,
      sources: [
        {
          book_id: bookId,
          book_title: "Chào ngày mới",
          book_author: "Minh Anh",
          min_grade: 1,
          max_grade: 1,
          session_id: sessionId,
          page_number: 1,
          context_phrase: "Bé có một bông hoa.",
          last_seen_at: "2026-11-18T02:00:00Z",
        },
      ],
    };
    const wordBong = {
      ...wordMot,
      normalized_word: "bông",
      display_text: "bông",
      difficulty_score: 3,
    };
    let wordsState = [wordMot, wordBong];
    const submittedContextPhrases: string[] = [];

    mockSpeechRecorder.getIsSpeaking.mockReturnValue(true);
    mockSpeechRecorder.getQuality.mockReturnValue({
      status: "LOW_VOLUME" as unknown as "SPEECH_DETECTED",
      durationMs: 700,
      speechDurationMs: 220,
      silenceDurationMs: 300,
      rms: 0.006,
      peak: 0.012,
      noiseFloor: 0.002,
      clipped: false,
      isSpeaking: false,
    });
    mockSpeechRecorder.start.mockImplementation(async () => {
      mockSpeechRecorder.isRecording = true;
      mockSpeechRecorder.isSpeaking = true;
      mockSpeechRecorder.audioLevel = 0.06;
      mockSpeechRecorder.getIsSpeaking.mockReturnValue(true);
      // Child speaks shortly after mic opens, then goes quiet -> VAD stops automatically
      setTimeout(() => {
        mockSpeechRecorder.isSpeaking = false;
        mockSpeechRecorder.audioLevel = 0;
        mockSpeechRecorder.getIsSpeaking.mockReturnValue(false);
      }, 200);
    });

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/practice/history")) {
        return Response.json({ storage_ready: true, items: [] });
      }
      if (url.endsWith("/practice/evaluate") && init?.method === "POST") {
        const body = init.body as FormData;
        const norm = String(body.get("normalized_word") ?? "");
        const ctx = body.get("context_phrase");
        if (typeof ctx === "string") submittedContextPhrases.push(ctx);
        wordsState = wordsState.map((item) =>
          item.normalized_word === norm
            ? {
                ...item,
                practice_status: "COMPLETED",
                practice_attempts_count: 1,
                practice_correct_count: 1,
                consecutive_correct_count: 1,
              }
            : item,
        );
        return Response.json({
          attempt_id: norm === "một" ? attemptId1 : attemptId2,
          child_id: childId,
          normalized_word: norm,
          display_text: norm,
          attempt_number: 1,
          state: "COMPLETED",
          assessment_status: "CORRECT",
          recognition_source: "SERVER_STT",
          spoken_transcript: norm,
          confidence: null,
          audio_duration_ms: 700,
          assessment_version: 1,
          evidence_word_ids: [bookId],
          persistence_backend: "READING_EVENT",
          resolved_in_session: true,
          started_at: "2026-11-18T02:00:00Z",
          completed_at: "2026-11-18T02:00:01Z",
          feedback_message: "Chính xác rồi! Con giỏi lắm!",
          word_progress: {
            normalized_word: norm,
            practice_status: "COMPLETED",
            practice_attempts_count: 1,
            practice_correct_count: 1,
            practice_incorrect_count: 0,
            practice_uncertain_count: 0,
            consecutive_correct_count: 1,
            required_consecutive_correct: 1,
            last_practiced_at: "2026-11-18T02:00:01Z",
            last_practice_status: "CORRECT",
          },
          next_recommended_word: norm === "một" ? "bông" : null,
          evidence_count_unchanged: true,
        });
      }
      if (url.includes("/system/difficult-words/")) {
        return Response.json(wordsState);
      }
      return readyResponse(url);
    });

    render(
      <AppServicesProvider>
        <DifficultWordsScreen />
      </AppServicesProvider>,
    );

    // Tap #1: Open word stage directly from card/chip
    const cta = await screen.findByRole("button", { name: "Luyện cùng bé" });
    await user.click(cta);
    expect(
      await screen.findByRole("heading", { name: /^một$/ }),
    ).toBeInTheDocument();

    // The book CTA already starts capture and hands-free practice.

    // Word 1 ('một') auto-stops via VAD without clicking Stop -> marked green in 1 read
    expect(
      await screen.findByText(/Hoàn thành từ này/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();

    // Auto-advances to word #2 ('bông') AND automatically enters LISTENING ("Dừng ghi âm") with ZERO extra taps!
    expect(
      await screen.findByRole("heading", { name: /^bông$/ }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Dừng ghi âm" }),
    ).toBeInTheDocument();

    // Word 2 ('bông') also auto-stops & completes via VAD with zero taps
    await waitFor(
      () => {
        expect(submittedContextPhrases).toEqual([
          "Bé có một bông hoa.",
          "Bé có một bông hoa.",
        ]);
      },
      { timeout: 5000 },
    );
    expect(
      await screen.findByText(/Hoàn thành từ này/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quay về danh sách" }));
    expect(
      await screen.findByText(/Đã luyện đúng 2\/2 từ/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2\/2 từ đã đọc đúng \(100%\)/),
    ).toBeInTheDocument();
  });
});
