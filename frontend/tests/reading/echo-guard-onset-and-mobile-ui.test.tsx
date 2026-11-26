import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComprehensionQuestion } from "@/components/reading/comprehension-question";
import { ReadingControls } from "@/components/reading/reading-controls";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import { DifficultWordsScreen } from "@/components/reports/difficult-words-screen";
import type { ReadingServices } from "@/hooks/use-reading-services";
import { BrowserTranscriptCollector } from "@/lib/reading/browser-transcript-collector";
import { EchoGuard } from "@/lib/reading/echo-guard";
import {
  childFixture,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type { DifficultWordDTO } from "@/types/reports";

const {
  readingServicesMock,
  reportServicesMock,
  speechPlayerMock,
  speechRecorderMock,
} = vi.hoisted(() => ({
  readingServicesMock: vi.fn<() => ReadingServices>(),
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
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/reports/difficult-words",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-reading-services", () => ({
  useReadingServices: readingServicesMock,
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
vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => ({
    listVoices: vi.fn().mockResolvedValue({ voices: [], default_voice_id: "" }),
    synthesizeTimed: vi.fn(),
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "SpeechRecognition");
});

describe("Bug 5b: BrowserTranscriptCollector -> EchoGuard onsetAt propagation", () => {
  it("blocks speaker echo during playback and within 800ms tail-overlap, while accepting child speech after tail-overlap or non-overlapping speech", () => {
    const guard = new EchoGuard({ onsetGraceMs: 250, tailMs: 1500 });
    const collector = new BrowserTranscriptCollector();

    // TTS plays "hoa thơm" from t=1000ms to t=1600ms
    guard.playbackStarted("tts-1", "hoa thơm", 1_000);
    guard.playbackEnded("tts-1", 1_600);

    // 1. Echo started during TTS (onsetAt=1550 < 1600+250) and arrived at t=1750 -> REJECTED!
    const rejectedEcho = collector.addResults(
      {
        resultIndex: 0,
        results: [
          {
            isFinal: true,
            onsetAt: 1_550,
            0: { transcript: "hoa thơm", confidence: 0.95 },
          },
        ],
      },
      (text, usable, _conf, meta) =>
        usable &&
        guard.evaluate({
          text,
          receivedAt: 1_750,
          onsetAt: meta?.onsetAt ?? null,
        }).accept,
    );
    expect(rejectedEcho).toEqual([]);

    // 2. Reverb bleed repeating exact TTS at +300ms (onsetAt=1900 <= 1600+800) -> REJECTED (tail-overlap)!
    const rejectedTailReverb = collector.addResults(
      {
        resultIndex: 1,
        results: [
          {
            isFinal: true,
            onsetAt: 1_550,
            0: { transcript: "hoa thơm", confidence: 0.95 },
          },
          {
            isFinal: true,
            onsetAt: 1_900,
            0: { transcript: "hoa thơm", confidence: 0.96 },
          },
        ],
      },
      (text, usable, _conf, meta) =>
        usable &&
        guard.evaluate({
          text,
          receivedAt: 2_200,
          onsetAt: meta?.onsetAt ?? null,
        }).accept,
    );
    expect(rejectedTailReverb).toEqual([]);

    // 3. Child repeats exact word "hoa thơm" after 800ms tail-overlap (onsetAt=2450) -> ACCEPTED!
    const acceptedChild = collector.addResults(
      {
        resultIndex: 2,
        results: [
          {
            isFinal: true,
            onsetAt: 1_550,
            0: { transcript: "hoa thơm", confidence: 0.95 },
          },
          {
            isFinal: true,
            onsetAt: 1_900,
            0: { transcript: "hoa thơm", confidence: 0.96 },
          },
          {
            isFinal: true,
            onsetAt: 2_450,
            0: { transcript: "hoa thơm", confidence: 0.96 },
          },
        ],
      },
      (text, usable, _conf, meta) =>
        usable &&
        guard.evaluate({
          text,
          receivedAt: 2_750,
          onsetAt: meta?.onsetAt ?? null,
        }).accept,
    );
    expect(acceptedChild).toEqual(["hoa thơm"]);
    expect(collector.getTranscript()).toBe("hoa thơm");
  });
});

describe("ComprehensionQuestion rec.onerror + rec.onend infinite restart loop fix", () => {
  beforeEach(() => {
    speechPlayerMock.play.mockReset().mockResolvedValue(undefined);
    speechPlayerMock.stop.mockReset();
  });

  it("stops voice recognition cleanly on stt-unavailable/network without spinning rec.start() in onend", async () => {
    let startCalls = 0;
    class FailingQuizRecognition {
      static latest: FailingQuizRecognition | null = null;
      continuous = true;
      interimResults = true;
      lang = "vi-VN";
      maxAlternatives = 1;
      onresult: ((ev: unknown) => void) | null = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        FailingQuizRecognition.latest = this;
      }
      start() {
        startCalls += 1;
      }
      stop() {
        this.onend?.();
      }
    }
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FailingQuizRecognition,
    });

    readingServicesMock.mockReturnValue({
      comprehensionService: {
        getQuestion: vi.fn().mockResolvedValue({
          question: {
            id: "q-1",
            type: "FACTUAL",
            prompt: "Mèo con ăn gì?",
            page_revision_id: "rev-1",
            source_span: {
              start_word_index: 0,
              end_word_index_exclusive: 3,
              sentence_index: 0,
            },
            difficulty: 1,
            answered: false,
          },
          progress_label: "Câu 1/1",
          choices: [
            { id: "A", label: "Cá", value: "Cá" },
            { id: "B", label: "Rau", value: "Rau" },
          ],
          position: 1,
          total: 1,
        }),
        submitAnswer: vi.fn(),
      },
    } as unknown as ReadingServices);

    render(
      <ComprehensionQuestion
        child={childFixture}
        onComplete={vi.fn()}
        sessionId={TEST_SESSION_ID}
      />,
    );

    await waitFor(() => expect(startCalls).toBe(1));

    act(() => {
      FailingQuizRecognition.latest?.onerror?.({ error: "stt-unavailable" });
      FailingQuizRecognition.latest?.onend?.();
    });

    // Must NOT restart in a loop!
    expect(startCalls).toBe(1);
  });

  it("resets processedUpTo on rec.onend restart, deduplicates by turnId, and applies 850ms settle window to 'A ạ'", async () => {
    let startCalls = 0;
    class RestartingQuizRecognition {
      static latest: RestartingQuizRecognition | null = null;
      continuous = true;
      interimResults = true;
      lang = "vi-VN";
      maxAlternatives = 1;
      onresult: ((ev: unknown) => void) | null = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        RestartingQuizRecognition.latest = this;
      }
      start() {
        startCalls += 1;
      }
      stop() {}
    }
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: RestartingQuizRecognition,
    });

    const submitAnswer = vi.fn().mockResolvedValue({
      question_id: "q-2",
      is_correct: true,
      feedback: "Chính xác!",
      selected_answer: "Rau",
      correct_answer: "Rau",
    });
    readingServicesMock.mockReturnValue({
      comprehensionService: {
        getQuestion: vi.fn().mockResolvedValue({
          question: {
            id: "q-2",
            type: "FACTUAL",
            prompt: "Thỏ con ăn gì?",
            page_revision_id: "rev-1",
            source_span: {
              start_word_index: 0,
              end_word_index_exclusive: 3,
              sentence_index: 0,
            },
            difficulty: 1,
            answered: false,
          },
          progress_label: "Câu 1/1",
          choices: [
            { id: "A", label: "Cá", value: "Cá" },
            { id: "B", label: "Rau", value: "Rau" },
          ],
          position: 1,
          total: 1,
        }),
        submitAnswer,
      },
    } as unknown as ReadingServices);

    render(
      <ComprehensionQuestion
        child={childFixture}
        onComplete={vi.fn()}
        sessionId={TEST_SESSION_ID}
      />,
    );

    await waitFor(() => expect(startCalls).toBe(1));

    // Cycle 1: bare letter + polite particle "A ạ" must NOT submit immediately (850ms settle!)
    act(() => {
      RestartingQuizRecognition.latest?.onresult?.({
        resultIndex: 0,
        results: [
          {
            isFinal: true,
            turnId: "turn-a",
            0: { transcript: "A ạ", confidence: 0.95 },
          },
        ],
      });
    });
    expect(submitAnswer).not.toHaveBeenCalled();

    // Simulate recognition end & auto-restart -> processedUpTo must reset to -1!
    act(() => {
      RestartingQuizRecognition.latest?.onend?.();
    });
    expect(startCalls).toBe(2);

    // Cycle 2 starts at resultIndex=0 with self-correction "à không, con chọn B" + duplicate turnId
    act(() => {
      RestartingQuizRecognition.latest?.onresult?.({
        resultIndex: 0,
        results: [
          {
            isFinal: true,
            turnId: "turn-b",
            0: { transcript: "à không, con chọn B", confidence: 0.96 },
          },
        ],
      });
      // Duplicate final with identical turnId must be ignored
      RestartingQuizRecognition.latest?.onresult?.({
        resultIndex: 1,
        results: [
          {
            isFinal: true,
            turnId: "turn-b",
            0: { transcript: "à không, con chọn B", confidence: 0.96 },
          },
          {
            isFinal: true,
            turnId: "turn-b",
            0: { transcript: "à không, con chọn B", confidence: 0.96 },
          },
        ],
      });
    });

    await waitFor(() => expect(submitAnswer).toHaveBeenCalledTimes(1));
    expect(submitAnswer).toHaveBeenCalledWith(TEST_SESSION_ID, "q-2", "Rau");
  });
});

describe("Child Focus Mobile UI (ReadingControls 1-tap dock + DifficultWords immersive mode)", () => {
  it("renders 1-tap mobile-first dock with Bé đọc, Nghe mẫu, Tạm dừng, Giọng đọc, Chọn trang, and Xong", async () => {
    const user = userEvent.setup();
    const onPause = vi.fn();
    render(
      <ReadingControls
        onChoosePage={vi.fn()}
        onFinish={vi.fn()}
        onHelp={vi.fn()}
        onPause={onPause}
        onSpellWord={vi.fn()}
        voiceSettings={
          <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />
        }
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Điều khiển buổi đọc" });
    expect(
      within(nav).getByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("button", { name: "Giọng đọc" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("button", { name: "Chọn trang" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("button", { name: "Kết thúc buổi đọc" }),
    ).toBeInTheDocument();

    const pauseBtn = within(nav).getByRole("button", {
      name: "Tạm dừng buổi đọc",
    });
    await user.click(pauseBtn);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it("dispatches viread:immersive-mode on DifficultWords practice enter/exit and renders min-h-12 word chips", async () => {
    const user = userEvent.setup();
    const word: DifficultWordDTO = {
      normalized_word: "thơm",
      display_text: "thơm",
      difficulty_score: 4,
      omission_count: 0,
      repetition_count: 0,
      long_pause_count: 0,
      read_example_count: 0,
      session_count: 1,
      mispronunciation_count: 1,
      last_seen_at: "2026-11-25T00:00:00Z",
      practice_status: "NOT_PRACTICED",
      evidence_word_ids: ["33333333-3333-4333-8333-333333333333"],
      sources: [
        {
          book_id: "11111111-1111-4111-8111-111111111111",
          book_title: "Hoa Mùa Xuân",
          page_number: 1,
          context_phrase: "hoa thơm ngát",
          last_seen_at: "2026-11-25T00:00:00Z",
        },
      ],
    };

    reportServicesMock.mockReturnValue({
      childService: {
        list: vi.fn().mockResolvedValue([childFixture]),
        get: vi.fn().mockResolvedValue(childFixture),
      },
      difficultWordService: {
        list: vi.fn().mockResolvedValue([word]),
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

    const { unmount } = render(
      <DifficultWordsScreen requestedChildId={TEST_CHILD_ID} />,
    );

    const wordChip = await screen.findByRole("button", {
      name: /Luyện từ thơm/i,
    });
    expect(wordChip.className).toContain("min-h-12");

    // Enter practice mode -> dispatches active: true
    await user.click(wordChip);
    await waitFor(() => {
      expect(immersiveEvents).toContain(true);
    });

    // Exit practice mode -> dispatches active: false
    await user.click(
      screen.getByRole("button", { name: /Quay về danh sách/i }),
    );
    await waitFor(() => {
      expect(immersiveEvents.at(-1)).toBe(false);
    });

    unmount();
    window.removeEventListener("viread:immersive-mode", listener);
  });
});
