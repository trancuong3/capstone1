import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DifficultWordPracticePanel } from "@/components/reports/difficult-word-practice-panel";
import type {
  DifficultWordDTO,
  DifficultWordPracticeAttemptDTO,
} from "@/types/reports";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";

const { speechPlayerMock, speechRecorderMock, evaluatePracticeWordMock } =
  vi.hoisted(() => ({
    speechPlayerMock: {
      isPlaying: false,
      isPaused: false,
      state: "idle" as const,
      fallbackNotice: null,
      play: vi.fn<(text: string) => Promise<void>>(async () => {}),
      playWithWordTimings: vi.fn(async () => {}),
      pause: vi.fn(),
      resume: vi.fn(async () => {}),
      stop: vi.fn(),
    },
    speechRecorderMock: {
      isRecording: false,
      isSpeaking: false,
      audioLevel: 0,
      prepare: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => new Blob(["wav-bytes"], { type: "audio/webm" })),
      cancel: vi.fn(),
      getStream: vi.fn(() => null),
      getIsSpeaking: vi.fn(() => false),
      getQuality: vi.fn(() => ({
        status: "SILENCE" as const,
        durationMs: 700,
        speechDurationMs: 0,
        silenceDurationMs: 700,
        rms: 0,
        peak: 0,
        noiseFloor: 0.001,
        clipped: false,
        isSpeaking: false,
      })),
      getSettings: vi.fn(() => ({})),
    },
    evaluatePracticeWordMock: vi.fn(),
  }));

vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => speechPlayerMock,
}));
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => speechRecorderMock,
}));
vi.mock("@/hooks/use-report-services", () => ({
  useReportServices: () => ({
    difficultWordService: {
      getPracticeHistory: vi.fn(async () => ({
        storage_ready: true,
        items: [],
      })),
      evaluatePracticeWord: evaluatePracticeWordMock,
    },
  }),
}));

const wordItem: DifficultWordDTO = {
  normalized_word: "một",
  display_text: "một",
  difficulty_score: 3,
  omission_count: 0,
  repetition_count: 0,
  long_pause_count: 0,
  read_example_count: 0,
  session_count: 1,
  mispronunciation_count: 1,
  last_seen_at: "2026-11-18T00:00:00Z",
  practice_status: "NOT_PRACTICED",
  evidence_word_ids: ["33333333-3333-4333-8333-333333333333"],
};

const nextWordItem: DifficultWordDTO = {
  ...wordItem,
  normalized_word: "có",
  display_text: "có",
  evidence_word_ids: ["33333333-3333-4333-8333-333333333334"],
};

function makeAttempt(
  status: DifficultWordPracticeAttemptDTO["assessment_status"],
  transcript: string | null,
): DifficultWordPracticeAttemptDTO {
  return {
    attempt_id: "44444444-4444-4444-8444-444444444444",
    child_id: TEST_CHILD_ID,
    normalized_word: "một",
    display_text: "một",
    attempt_number: 1,
    state: "COMPLETED",
    assessment_status: status,
    recognition_source:
      status === "NO_CLEAR_AUDIO" ? "AUDIO_QUALITY_GATE" : "SERVER_STT",
    spoken_transcript: transcript,
    confidence: null,
    audio_duration_ms: 700,
    assessment_version: 1,
    evidence_word_ids: ["33333333-3333-4333-8333-333333333333"],
    evidence_count_unchanged: true,
    started_at: "2026-11-18T00:00:00Z",
    completed_at: "2026-11-18T00:00:01Z",
    feedback_message:
      status === "INCORRECT"
        ? "Con nghe lại rồi đọc theo nhé!"
        : "Máy chưa nghe rõ giọng của con.",
    next_recommended_word: null,
    word_progress: {
      normalized_word: "một",
      practice_status:
        status === "CORRECT" ? "IN_PROGRESS" : "NEEDS_MORE_PRACTICE",
      practice_attempts_count: 1,
      practice_correct_count: status === "CORRECT" ? 1 : 0,
      practice_incorrect_count: status === "INCORRECT" ? 1 : 0,
      practice_uncertain_count:
        status === "UNCERTAIN" || status === "NO_CLEAR_AUDIO" ? 1 : 0,
      consecutive_correct_count: status === "CORRECT" ? 1 : 0,
      required_consecutive_correct: 2,
      last_practiced_at: "2026-11-18T00:00:01Z",
      last_practice_status: status,
    },
  };
}

describe("DifficultWordPracticePanel hands-free pre-warm + auto-retry + loop breaker", () => {
  beforeEach(() => {
    speechPlayerMock.play.mockReset().mockResolvedValue(undefined);
    speechPlayerMock.stop.mockClear();
    speechRecorderMock.prepare.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.start.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.stop
      .mockReset()
      .mockResolvedValue(new Blob(["wav-bytes"], { type: "audio/webm" }));
    speechRecorderMock.cancel.mockClear();
    evaluatePracticeWordMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("pre-warms mic before prompt, auto-reopens mic after wrong pronunciation, and pauses with explicit buttons on repeated silence", async () => {
    const order: string[] = [];
    speechRecorderMock.prepare.mockImplementation(async () => {
      order.push("prepare");
    });
    speechPlayerMock.play.mockImplementation(async (txt: string) => {
      order.push(`tts:${txt}`);
    });
    speechRecorderMock.start.mockImplementation(async () => {
      order.push("start");
    });

    evaluatePracticeWordMock
      .mockResolvedValueOnce(makeAttempt("INCORRECT", "mốt"))
      .mockResolvedValueOnce(makeAttempt("NO_CLEAR_AUDIO", null))
      .mockResolvedValueOnce(makeAttempt("NO_CLEAR_AUDIO", null));

    const user = userEvent.setup();
    render(
      <DifficultWordPracticePanel
        child={childFixture}
        onClose={vi.fn()}
        onProgressSaved={vi.fn(async () => {})}
        onSelectWord={vi.fn()}
        word={wordItem}
        words={[wordItem]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Bắt đầu luyện/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(1),
    );
    // Verify pre-warmed mic order: prepare -> TTS prompt -> warm start(short-word, retainStream)
    expect(order.slice(0, 3)).toEqual([
      "prepare",
      "tts:Bé hãy đọc từ một nhé.",
      "start",
    ]);
    expect(speechRecorderMock.start).toHaveBeenCalledWith({
      mode: "short-word",
      retainStream: true,
    });
    expect(screen.getByText("Đang nghe bé")).toBeInTheDocument();

    // Turn 1: INCORRECT ("mốt") -> auto-reopens mic WITHOUT extra user taps
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByText("Đọc sai")).toBeInTheDocument();

    // Turn 2: NO_CLEAR_AUDIO (silence #1) -> auto-reopens mic once more
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
    );

    // Turn 3: NO_CLEAR_AUDIO (silence #2 -> hits silence streak loop breaker)
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    expect(
      await screen.findByRole("button", { name: /Tiếp tục thử/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Nhờ ba mẹ giúp/ }),
    ).toBeInTheDocument();
    expect(speechRecorderMock.cancel).toHaveBeenCalled();
    expect(speechRecorderMock.start).toHaveBeenCalledTimes(3);

    // Explicit continue button resumes fresh cycle
    await user.click(screen.getByRole("button", { name: /Tiếp tục thử/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(4),
    );
  }, 15_000);

  it("cancels TTS/recorder on exit during evaluation (discarding late responses) and advances to next word after retry-then-CORRECT", async () => {
    const onSelectWord = vi.fn();
    const onClose = vi.fn();
    let resolveLateEval:
      ((value: DifficultWordPracticeAttemptDTO) => void) | undefined;

    evaluatePracticeWordMock.mockImplementationOnce(
      () =>
        new Promise<DifficultWordPracticeAttemptDTO>((resolve) => {
          resolveLateEval = resolve;
        }),
    );

    const user = userEvent.setup();
    const { unmount } = render(
      <DifficultWordPracticePanel
        child={childFixture}
        onClose={onClose}
        onProgressSaved={vi.fn(async () => {})}
        onSelectWord={onSelectWord}
        word={wordItem}
        words={[wordItem, nextWordItem]}
      />,
    );

    // Scenario A: Exit while EVALUATING is in flight -> cancels mic & ignores late evaluation
    await user.click(screen.getByRole("button", { name: /Bắt đầu luyện/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(1),
    );
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(evaluatePracticeWordMock).toHaveBeenCalledTimes(1),
    );

    await user.click(screen.getByRole("button", { name: /Quay về danh sách/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(speechPlayerMock.stop).toHaveBeenCalled();
    expect(speechRecorderMock.cancel).toHaveBeenCalled();

    // Resolving late promise after close/unmount must not call onSelectWord
    resolveLateEval?.(makeAttempt("CORRECT", "một"));
    await Promise.resolve();
    expect(onSelectWord).not.toHaveBeenCalled();
    unmount();

    // Scenario B: UNCERTAIN -> auto-retry -> CORRECT resets loop and auto-advances to next word
    evaluatePracticeWordMock
      .mockResolvedValueOnce(makeAttempt("UNCERTAIN", "bé hãy đọc"))
      .mockResolvedValueOnce(makeAttempt("CORRECT", "một"));

    render(
      <DifficultWordPracticePanel
        child={childFixture}
        onClose={vi.fn()}
        onProgressSaved={vi.fn(async () => {})}
        onSelectWord={onSelectWord}
        word={wordItem}
        words={[wordItem, nextWordItem]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Bắt đầu luyện/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(2),
    );
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
    );
    expect(screen.getByText("Nghe chưa rõ")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(
      () =>
        expect(onSelectWord).toHaveBeenCalledWith("có", {
          autoStart: true,
        }),
      { timeout: 4000 },
    );
  }, 15_000);
});
