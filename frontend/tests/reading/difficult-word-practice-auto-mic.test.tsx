import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DifficultWordPracticePanel } from "@/components/reports/difficult-word-practice-panel";
import type { AudioQualitySnapshot } from "@/lib/reading/audio-quality";
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
      getQuality: vi.fn<() => AudioQualitySnapshot>(),
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
    speechRecorderMock.getQuality.mockReset().mockReturnValue({
      status: "SPEECH_DETECTED",
      durationMs: 700,
      speechDurationMs: 180,
      silenceDurationMs: 400,
      rms: 0.02,
      peak: 0.07,
      noiseFloor: 0.001,
      clipped: false,
      isSpeaking: false,
    });
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

    evaluatePracticeWordMock.mockResolvedValueOnce(
      makeAttempt("INCORRECT", "mốt"),
    );

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
      "tts:Con đọc từ trên màn hình nhé.",
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

    speechRecorderMock.getQuality.mockReturnValue({
      ...speechRecorderMock.getQuality(),
      status: "SILENCE",
      speechDurationMs: 0,
      rms: 0,
      peak: 0,
    });
    // The first silent capture retries, while the second plays one model.
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
    );

    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(4),
    );
    expect(speechPlayerMock.play).toHaveBeenCalledWith(
      "một",
      expect.objectContaining({
        wordSample: true,
      }),
    );

    // Silence after the model pauses the automatic loop.
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    expect(
      await screen.findByRole("button", { name: /Tiếp tục thử/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Nhờ ba mẹ giúp/ }),
    ).toBeInTheDocument();
    expect(speechRecorderMock.cancel).toHaveBeenCalled();
    expect(speechRecorderMock.start).toHaveBeenCalledTimes(4);
    expect(evaluatePracticeWordMock).toHaveBeenCalledTimes(1);

    // Explicit continue button resumes fresh cycle
    await user.click(screen.getByRole("button", { name: /Tiếp tục thử/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(5),
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

  it("isolates PARENT_PRIVATE book difficult words to PRIVATE TTS cache scope (never shared CATALOG)", async () => {
    const user = userEvent.setup();
    const privateWord: DifficultWordDTO = {
      ...wordItem,
      normalized_word: "bướm",
      display_text: "bướm",
      sources: [
        {
          book_id: "99999999-9999-4999-8999-999999999999",
          visibility_scope: "PARENT_PRIVATE",
          is_private_book: true,
          page_id: "88888888-8888-4888-8888-888888888888",
          page_revision_id: "77777777-7777-4777-8777-777777777777",
          context_phrase: "con bướm vàng",
          last_seen_at: "2026-11-26T00:00:00Z",
        },
      ],
    };

    render(
      <DifficultWordPracticePanel
        child={childFixture}
        onClose={vi.fn()}
        onProgressSaved={vi.fn(async () => {})}
        onSelectWord={vi.fn()}
        word={privateWord}
        words={[privateWord]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Nghe phát âm mẫu/i }));
    await waitFor(() =>
      expect(speechPlayerMock.play).toHaveBeenCalledWith(
        "bướm",
        expect.objectContaining({
          wordSample: true,
          bookId: "99999999-9999-4999-8999-999999999999",
          isPrivateBook: true,
          cacheScope: "PRIVATE",
        }),
      ),
    );
  });

  it("AUTO-DW-01: hands-free ladder (wrong -> context phrase -> 'đánh vần giúp con' -> partial syllable SPELLING_STEP_ONLY -> full word CORRECT -> auto-advances with autoStart=true)", async () => {
    class DwRecognition {
      static instances: DwRecognition[] = [];
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      continuous = true;
      interimResults = true;
      lang = "vi-VN";
      constructor() {
        DwRecognition.instances.push(this);
      }
      start() {}
      stop() {
        this.onend?.();
      }
      abort() {}
      say(transcript: string, confidence = 0.95) {
        this.onresult?.({
          resultIndex: 0,
          results: [
            { isFinal: true, length: 1, 0: { transcript, confidence } },
          ],
        });
      }
    }
    const prevRec = Object.getOwnPropertyDescriptor(
      window,
      "SpeechRecognition",
    );
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: DwRecognition,
    });
    try {
      const phraseWord: DifficultWordDTO = {
        ...wordItem,
        normalized_word: "có",
        display_text: "có",
        sources: [
          {
            book_id: "33333333-3333-4333-8333-333333333333",
            visibility_scope: "PUBLIC_CATALOG",
            is_private_book: false,
            page_id: "55555555-5555-4555-8555-555555555555",
            page_revision_id: "66666666-6666-4666-8666-666666666666",
            context_phrase: "Bé có một bông hoa.",
            last_seen_at: "2026-11-26T00:00:00Z",
          },
        ],
      };
      const secondWord: DifficultWordDTO = {
        ...wordItem,
        normalized_word: "ngập ngừng",
        display_text: "ngập ngừng",
      };
      const onSelectWord = vi.fn();

      // Turn 1: INCORRECT ("cò") -> switches to context phrase
      // Turn 4 (after phonics + SPELLING_STEP_ONLY): CORRECT ("có")
      evaluatePracticeWordMock
        .mockResolvedValueOnce({
          ...makeAttempt("INCORRECT", "cò"),
          normalized_word: "có",
          display_text: "có",
        })
        .mockResolvedValueOnce({
          ...makeAttempt("CORRECT", "có"),
          normalized_word: "có",
          display_text: "có",
          next_recommended_word: "ngập ngừng",
        });

      const user = userEvent.setup();
      render(
        <DifficultWordPracticePanel
          child={childFixture}
          onClose={vi.fn()}
          onProgressSaved={vi.fn(async () => {})}
          onSelectWord={onSelectWord}
          word={phraseWord}
          words={[phraseWord, secondWord]}
        />,
      );

      await user.click(screen.getByRole("button", { name: /Bắt đầu luyện/ }));
      await waitFor(() =>
        expect(speechRecorderMock.start).toHaveBeenCalledTimes(1),
      );

      // Attempt 1: wrong -> context phrase cue & displayed phrase ("có một bông")
      await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
      await waitFor(() =>
        expect(speechPlayerMock.play).toHaveBeenCalledWith(
          expect.stringContaining("có một bông"),
          expect.any(Object),
        ),
      );
      expect(screen.getByText("có một bông")).toBeInTheDocument();
      await waitFor(() =>
        expect(speechRecorderMock.start).toHaveBeenCalledTimes(2),
      );

      // Attempt 2: child asks "đánh vần giúp con" -> runs phonics steps & reopens mic
      DwRecognition.instances.at(-1)!.say("đánh vần giúp con");
      await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
      await waitFor(() =>
        expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
      );
      expect(speechPlayerMock.play).toHaveBeenCalledWith(
        expect.stringContaining("Đến lượt con"),
        expect.any(Object),
      );

      // Attempt 3: child says partial syllable ("cờ o") -> SPELLING_STEP_ONLY (must NOT evaluate or advance!)
      const evalCallsBeforePartial = evaluatePracticeWordMock.mock.calls.length;
      DwRecognition.instances.at(-1)!.say("cờ o");
      await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
      await waitFor(() =>
        expect(speechRecorderMock.start).toHaveBeenCalledTimes(4),
      );
      expect(evaluatePracticeWordMock).toHaveBeenCalledTimes(
        evalCallsBeforePartial,
      );
      expect(speechPlayerMock.play).toHaveBeenCalledWith(
        expect.stringContaining("Con đánh vần đúng nhịp rồi!"),
        expect.any(Object),
      );
      expect(onSelectWord).not.toHaveBeenCalled();

      // Attempt 4: child says full word "có" -> CORRECT_AFTER_SPELLING -> auto-advances with autoStart=true
      DwRecognition.instances.at(-1)!.say("có");
      await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
      await waitFor(
        () =>
          expect(onSelectWord).toHaveBeenCalledWith("ngập ngừng", {
            autoStart: true,
          }),
        { timeout: 4000 },
      );
      expect(screen.getByTestId("word-mastery-outcome")).toHaveAttribute(
        "data-mastery-outcome",
        "CORRECT_AFTER_SPELLING",
      );
    } finally {
      if (prevRec) Object.defineProperty(window, "SpeechRecognition", prevRec);
      else Reflect.deleteProperty(window, "SpeechRecognition");
    }
  }, 15_000);

  it("AUTO-DW-02: max attempts encourages & advances, voice 'từ tiếp theo'/'dừng luyện' work, and offline evaluate retries idempotently with same request_id", async () => {
    class DwRecognition {
      static instances: DwRecognition[] = [];
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      continuous = true;
      interimResults = true;
      lang = "vi-VN";
      constructor() {
        DwRecognition.instances.push(this);
      }
      start() {}
      stop() {
        this.onend?.();
      }
      abort() {}
      say(transcript: string, confidence = 0.95) {
        this.onresult?.({
          resultIndex: 0,
          results: [
            { isFinal: true, length: 1, 0: { transcript, confidence } },
          ],
        });
      }
    }
    const prevRec = Object.getOwnPropertyDescriptor(
      window,
      "SpeechRecognition",
    );
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: DwRecognition,
    });
    try {
      const onSelectWord = vi.fn();
      const user = userEvent.setup();

      // 1) Offline failure -> idempotent retry keeps exact same request_id
      evaluatePracticeWordMock
        .mockRejectedValueOnce(new Error("Network offline"))
        .mockResolvedValueOnce(makeAttempt("CORRECT", "một"));

      const { unmount } = render(
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
        expect(speechRecorderMock.start).toHaveBeenCalledTimes(1),
      );
      await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));

      const retrySaveBtn = await screen.findByRole("button", {
        name: /Lưu lại kết quả/,
      });
      const firstRequestId =
        evaluatePracticeWordMock.mock.calls[0][1].request_id;
      await user.click(retrySaveBtn);
      await waitFor(() =>
        expect(evaluatePracticeWordMock).toHaveBeenCalledTimes(2),
      );
      expect(evaluatePracticeWordMock.mock.calls[1][1].request_id).toBe(
        firstRequestId,
      );
      unmount();

      // 2) Voice "dừng luyện" -> PAUSED, then "từ tiếp theo" -> auto-advances
      const { unmount: unmountPause } = render(
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
      DwRecognition.instances.at(-1)!.say("dừng luyện");
      await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
      expect(
        await screen.findByRole("button", { name: /Tiếp tục luyện/ }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /Tiếp tục luyện/ }));
      await waitFor(() =>
        expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
      );
      onSelectWord.mockClear();
      DwRecognition.instances.at(-1)!.say("từ tiếp theo");
      await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
      expect(onSelectWord).toHaveBeenCalledWith("có", { autoStart: true });
      unmountPause();

      // 3) Max attempts (3 incorrect) -> encourages & auto-advances
      evaluatePracticeWordMock.mockResolvedValue(
        makeAttempt("INCORRECT", "mốt"),
      );
      onSelectWord.mockClear();
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
      for (let i = 1; i <= 3; i += 1) {
        await waitFor(() =>
          expect(speechRecorderMock.start).toHaveBeenCalledTimes(3 + i),
        );
        await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
      }
      await waitFor(() =>
        expect(speechPlayerMock.play).toHaveBeenCalledWith(
          expect.stringContaining("từ này mình luyện thêm sau"),
          expect.any(Object),
        ),
      );
      await waitFor(
        () =>
          expect(onSelectWord).toHaveBeenCalledWith("có", { autoStart: true }),
        { timeout: 4000 },
      );
    } finally {
      if (prevRec) Object.defineProperty(window, "SpeechRecognition", prevRec);
      else Reflect.deleteProperty(window, "SpeechRecognition");
    }
  }, 20_000);
});
