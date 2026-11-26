import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComprehensionQuestion } from "@/components/reading/comprehension-question";
import type { ReadingServices } from "@/hooks/use-reading-services";
import { matchComprehensionVoiceInput } from "@/lib/reading/comprehension-voice-matcher";
import {
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
} from "@/lib/reading/session-voice-lock";
import {
  childFixture,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type { ComprehensionQuestionViewModelUI } from "@/types/reading";

const { servicesHook, speechPlayerMock } = vi.hoisted(() => ({
  servicesHook: vi.fn<() => ReadingServices>(),
  speechPlayerMock: {
    isPlaying: false,
    isPaused: false,
    fallbackNotice: null,
    play: vi.fn(),
    playWithWordTimings: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock("@/hooks/use-reading-services", () => ({
  useReadingServices: servicesHook,
}));
vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => speechPlayerMock,
}));

class QuizRecognition {
  static instances: QuizRecognition[] = [];
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  stopped = false;
  private results: Array<{
    isFinal: boolean;
    length: number;
    epoch?: number;
    sessionId?: string | null;
    pageId?: string | null;
    0: { transcript: string; confidence: number };
  }> = [];

  constructor() {
    QuizRecognition.instances.push(this);
  }
  start() {
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  say(
    transcript: string,
    confidence = 0.95,
    meta?: {
      epoch?: number;
      sessionId?: string | null;
      pageId?: string | null;
    },
  ) {
    this.results.push({
      isFinal: true,
      length: 1,
      epoch: meta?.epoch,
      sessionId: meta?.sessionId,
      pageId: meta?.pageId,
      0: { transcript, confidence },
    });
    this.onresult?.({
      resultIndex: this.results.length - 1,
      results: [...this.results],
    });
  }
  sayInterim(
    transcript: string,
    meta?: {
      epoch?: number;
      sessionId?: string | null;
      pageId?: string | null;
    },
  ) {
    this.onresult?.({
      resultIndex: this.results.length,
      results: [
        ...this.results,
        {
          isFinal: false,
          length: 1,
          epoch: meta?.epoch,
          sessionId: meta?.sessionId,
          pageId: meta?.pageId,
          0: { transcript, confidence: 0 },
        },
      ],
    });
  }
}

const lastRec = () =>
  QuizRecognition.instances[QuizRecognition.instances.length - 1];

let previousRecognition: PropertyDescriptor | undefined;

beforeEach(() => {
  QuizRecognition.instances.length = 0;
  previousRecognition = Object.getOwnPropertyDescriptor(
    window,
    "SpeechRecognition",
  );
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    value: QuizRecognition,
  });
  speechPlayerMock.play.mockReset().mockResolvedValue(undefined);
  speechPlayerMock.stop.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetVoiceLockAndPolicyForTests();
  if (previousRecognition) {
    Object.defineProperty(window, "SpeechRecognition", previousRecognition);
  } else {
    Reflect.deleteProperty(window, "SpeechRecognition");
  }
});

function makeQuizQuestion(
  position: number,
  total: number,
  prompt: string,
  choices: readonly [string, string, string],
): ComprehensionQuestionViewModelUI {
  return {
    question: {
      id: `80000000-0000-4000-8000-00000000000${position}`,
      type: "FACTUAL",
      prompt,
      page_revision_id: "70000000-0000-4000-8000-000000000001",
      source_span: {
        start_word_index: 0,
        end_word_index_exclusive: 3,
        sentence_index: null,
      },
      difficulty: 1,
      answered: false,
    },
    progress_label: `Câu ${position}/${total}`,
    choices: [
      { id: "A", label: choices[0], value: choices[0] },
      { id: "B", label: choices[1], value: choices[1] },
      { id: "C", label: choices[2], value: choices[2] },
    ],
    position,
    total,
  };
}

describe("comprehension voice matcher (G24)", () => {
  const choices = [
    { id: "A", label: "Con mèo", value: "Con mèo" },
    { id: "B", label: "Con cá vàng", value: "Con cá vàng" },
    { id: "C", label: "Ông mặt trời", value: "Ông mặt trời" },
  ];

  it.each([
    ["A", "A", "letter"],
    ["đáp án a", "A", "letter"],
    ["bê", "B", "letter"],
    ["con chọn bê", "B", "letter"],
    ["xê", "C", "letter"],
    ["đáp án xê", "C", "letter"],
    ["câu một", "A", "ordinal"],
    ["chọn câu hai", "B", "ordinal"],
    ["số 3", "C", "ordinal"],
    ["con cá vàng", "B", "content"],
    ["ông mặt trời", "C", "content"],
  ] as const)("maps '%s' -> choice %s (%s)", (spoken, expectedId, kind) => {
    const matched = matchComprehensionVoiceInput(spoken, choices);
    expect(matched).toMatchObject({
      type: "CHOICE",
      matchedBy: kind,
      choice: { id: expectedId },
    });
  });

  it("ignores ambiguous speech ('a hay bê') and recognises replay/stop commands", () => {
    expect(matchComprehensionVoiceInput("a hay bê", choices)).toEqual({
      type: "NONE",
    });
    expect(matchComprehensionVoiceInput("cô đọc lại", choices)).toEqual({
      type: "REPLAY",
    });
    expect(matchComprehensionVoiceInput("dừng lại", choices)).toEqual({
      type: "STOP",
    });
  });
});

describe("hands-free voice comprehension quiz flow (G24)", () => {
  it("completes 3 questions with 0 clicks: reads question & A/B/C, blocks echo, accepts voice A/B/C & content, auto-advances", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const q1 = makeQuizQuestion(1, 3, "Bạn nào thích ăn cá?", [
      "Con mèo",
      "Con vịt",
      "Con gà",
    ]);
    const q2 = makeQuizQuestion(2, 3, "Bé đi đâu buổi sáng?", [
      "Đi ngủ",
      "Đi học",
      "Đi bơi",
    ]);
    const q3 = makeQuizQuestion(3, 3, "Ai nấu cơm cho bé?", [
      "Bác gấu",
      "Chú thỏ",
      "Mẹ của bé",
    ]);
    const correctValues = new Set(["Con mèo", "Đi học", "Mẹ của bé"]);

    const getQuestion = vi
      .fn()
      .mockResolvedValueOnce(q1)
      .mockResolvedValueOnce(q2)
      .mockResolvedValueOnce(q3);
    const submitAnswer = vi
      .fn()
      .mockImplementation(
        async (_session: string, questionId: string, answer: string) => ({
          answer_id: `ans-${questionId}`,
          question_id: questionId,
          submitted_answer: answer,
          is_correct: correctValues.has(answer),
          score: correctValues.has(answer) ? 1 : 0,
          feedback_code: correctValues.has(answer) ? "CORRECT" : "TRY_AGAIN",
        }),
      );
    servicesHook.mockReturnValue({
      comprehensionService: { getQuestion, submitAnswer },
    } as unknown as ReadingServices);

    const onComplete = vi.fn();
    render(
      <ComprehensionQuestion
        child={childFixture}
        onComplete={onComplete}
        sessionId={TEST_SESSION_ID}
      />,
    );

    // Q1: Reads question + A, B, C + asks "Bé chọn đáp án nào?", then opens mic
    await waitFor(() => expect(QuizRecognition.instances).toHaveLength(1));
    expect(speechPlayerMock.play.mock.calls.map(([t]) => t)).toEqual([
      "Bạn nào thích ăn cá?",
      "Đáp án A: Con mèo",
      "Đáp án B: Con vịt",
      "Đáp án C: Con gà",
      "Bé chọn đáp án nào?",
    ]);

    // Immediate echo of "Đáp án B: Con vịt" right after TTS ends is blocked!
    act(() => lastRec().say("Đáp án B: Con vịt"));
    expect(submitAnswer).not.toHaveBeenCalled();

    // Advance past 1.5s echo tail guard -> child answers Q1 by letter "A"
    now += 2_000;
    act(() => lastRec().say("đáp án A"));

    // Auto-advances to Q2 and opens mic #2 without any button click
    await screen.findByText("Bé đi đâu buổi sáng?");
    await waitFor(() => expect(QuizRecognition.instances).toHaveLength(2));
    expect(submitAnswer).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      q1.question.id,
      "Con mèo",
    );

    // Q2: Child answers using Vietnamese letter name "con chọn bê"
    now += 2_000;
    act(() => lastRec().say("con chọn bê"));

    // Auto-advances to Q3 and opens mic #3 with 0 clicks
    await screen.findByText("Ai nấu cơm cho bé?");
    await waitFor(() => expect(QuizRecognition.instances).toHaveLength(3));
    expect(submitAnswer).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      q2.question.id,
      "Đi học",
    );

    // Q3: Child answers by speaking the choice content "Mẹ của bé"
    now += 2_000;
    act(() => lastRec().say("Mẹ của bé"));

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(submitAnswer).toHaveBeenCalledTimes(3);
  });

  it("allows immediate touch/click interruption while TTS is reading the question and cancels old audio", async () => {
    let resolvePendingPlay: () => void = () => undefined;
    speechPlayerMock.play.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePendingPlay = resolve;
        }),
    );

    const q1 = makeQuizQuestion(1, 1, "Câu hỏi đang đọc dở?", [
      "Đáp án đúng",
      "Đáp án sai 1",
      "Đáp án sai 2",
    ]);
    const submitAnswer = vi.fn().mockResolvedValue({
      answer_id: "ans-1",
      question_id: q1.question.id,
      submitted_answer: "Đáp án đúng",
      is_correct: true,
      score: 1,
      feedback_code: "CORRECT",
    });
    servicesHook.mockReturnValue({
      comprehensionService: {
        getQuestion: vi.fn().mockResolvedValueOnce(q1),
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

    const choiceBtn = await screen.findByRole("button", {
      name: /Đáp án đúng/,
    });
    // Click mid-TTS before question finishes reading
    fireEvent.click(choiceBtn);
    expect(speechPlayerMock.stop).toHaveBeenCalled();
    await waitFor(() =>
      expect(submitAnswer).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        q1.question.id,
        "Đáp án đúng",
      ),
    );
    // Settling the aborted old TTS promise must NOT open recognition or advance
    act(() => resolvePendingPlay());
    expect(QuizRecognition.instances).toHaveLength(0);
  });

  it("waits 850ms for bare single-letter 'A', cancels on interim speech, and commits cross-segment self-correction 'B'", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const q1 = makeQuizQuestion(1, 1, "Mi che ô cho ai?", [
      "Bạn Lan",
      "Bạn An",
      "Cô giáo",
    ]);
    const submitAnswer = vi.fn().mockResolvedValue({
      answer_id: "ans-1",
      question_id: q1.question.id,
      submitted_answer: "Bạn An",
      is_correct: true,
      score: 1,
      feedback_code: "CORRECT",
    });
    servicesHook.mockReturnValue({
      comprehensionService: {
        getQuestion: vi.fn().mockResolvedValueOnce(q1),
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

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(QuizRecognition.instances).toHaveLength(1);
    now += 2_000;

    // Interim highlight only previews and NEVER submits
    act(() => lastRec().sayInterim("Bạn Lan"));
    expect(screen.getByRole("button", { name: /Bạn Lan/ })).toHaveAttribute(
      "data-preview-choice",
      "true",
    );
    expect(submitAnswer).not.toHaveBeenCalled();

    // Bare single-letter "A" previews A and does NOT submit at 500ms (< 850ms)
    act(() => lastRec().say("A"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(submitAnswer).not.toHaveBeenCalled();

    // New interim speech cancels the 850ms settle timer cleanly
    act(() => lastRec().sayInterim("à không"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(submitAnswer).not.toHaveBeenCalled();

    // Child completes self-correction "à không, con chọn B" -> submits Bạn An
    act(() => lastRec().say("à không, con chọn B"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(submitAnswer).toHaveBeenCalledTimes(1);
    expect(submitAnswer).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      q1.question.id,
      "Bạn An",
    );
  });

  it("fences late Q1 STT results out of Q2, adapts Thầy persona, speaks story_hint on wrong choice, and prevents double-submit", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    lockSessionVoice(TEST_SESSION_ID, {
      voiceId: "local_north_thien_minh",
      forceUpdate: true,
    });

    const q1 = makeQuizQuestion(1, 2, "Mi che ô cho ai?", [
      "Bạn Lan",
      "Bạn An",
      "Cô giáo",
    ]);
    const q2 = makeQuizQuestion(2, 2, "Trời hôm đó thế nào?", [
      "Trời nắng",
      "Trời đổ mưa",
      "Có tuyết",
    ]);
    const getQuestion = vi
      .fn()
      .mockResolvedValueOnce(q1)
      .mockResolvedValueOnce(q2);

    let resolveManual!: (val: unknown) => void;
    const submitAnswer = vi
      .fn()
      .mockResolvedValueOnce({
        answer_id: "ans-wrong",
        question_id: q1.question.id,
        submitted_answer: "Bạn Lan",
        is_correct: false,
        score: 0,
        feedback_code: "TRY_AGAIN",
        story_hint:
          "Con nhớ lại chi tiết: “Tan học, trời đổ mưa. Mi che ô cho…” nhé!",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveManual = resolve;
          }),
      );
    servicesHook.mockReturnValue({
      comprehensionService: { getQuestion, submitAnswer },
    } as unknown as ReadingServices);

    render(
      <ComprehensionQuestion
        child={childFixture}
        onComplete={vi.fn()}
        sessionId={TEST_SESSION_ID}
      />,
    );

    await waitFor(() => expect(QuizRecognition.instances).toHaveLength(1));
    const q1Rec = lastRec();
    // Male voice selected -> zero "Cô" in prompts
    expect(
      speechPlayerMock.play.mock.calls.map(([t]) => t).join(" "),
    ).not.toMatch(/(^|[^\p{L}])Cô(?=$|[^\p{L}])/u);

    // Wrong voice choice records exact choice first, speaks story_hint, and re-opens mic
    now += 2_000;
    act(() => q1Rec.say("Bạn Lan"));
    await waitFor(() => expect(QuizRecognition.instances).toHaveLength(2));
    expect(submitAnswer).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      q1.question.id,
      "Bạn Lan",
    );
    expect(
      screen.getByText(/Tan học, trời đổ mưa\. Mi che ô cho/),
    ).toBeInTheDocument();

    // Simultaneous click + STT does not double-submit
    const btnB = screen.getByRole("button", { name: /Bạn An/ });
    fireEvent.click(btnB);
    act(() => lastRec().say("con chọn B"));
    expect(submitAnswer).toHaveBeenCalledTimes(2);

    act(() =>
      resolveManual({
        answer_id: "ans-right",
        question_id: q1.question.id,
        submitted_answer: "Bạn An",
        is_correct: true,
        score: 1,
        feedback_code: "CORRECT",
      }),
    );

    // Advance to Q2 via click on "Câu tiếp theo"
    fireEvent.click(
      await screen.findByRole("button", { name: /Câu tiếp theo/ }),
    );
    await screen.findByText("Trời hôm đó thế nào?");
    await waitFor(() => expect(QuizRecognition.instances).toHaveLength(3));

    // Late result carrying Q1's pageId or stale epoch must NOT affect Q2
    now += 2_000;
    act(() =>
      lastRec().say("con chọn A", 0.95, {
        pageId: `quiz:${q1.question.id}`,
        sessionId: TEST_SESSION_ID,
      }),
    );
    expect(submitAnswer).toHaveBeenCalledTimes(2);
  });

  it("guarantees single submit on rapid clicks and duplicate STT final results", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const q1 = makeQuizQuestion(1, 1, "Ai nấu cơm cho bé?", [
      "Bác gấu",
      "Chú thỏ",
      "Mẹ của bé",
    ]);
    let resolveSubmit!: (val: unknown) => void;
    const submitAnswer = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    servicesHook.mockReturnValue({
      comprehensionService: {
        getQuestion: vi.fn().mockResolvedValueOnce(q1),
        submitAnswer,
      },
    } as unknown as ReadingServices);

    const onComplete = vi.fn();
    render(
      <ComprehensionQuestion
        child={childFixture}
        onComplete={onComplete}
        sessionId={TEST_SESSION_ID}
      />,
    );

    await waitFor(() => expect(QuizRecognition.instances).toHaveLength(1));
    const rec = lastRec();
    now += 2_000;

    // Duplicate final STT results fired back-to-back must only submit once
    act(() => {
      rec.say("đáp án B");
      rec.say("đáp án B");
    });
    expect(submitAnswer).toHaveBeenCalledTimes(1);

    // Rapid clicks while first submit is still in flight must not double-submit
    const btnA = screen.getByRole("button", { name: /Bác gấu/ });
    const btnC = screen.getByRole("button", { name: /Mẹ của bé/ });
    fireEvent.click(btnA);
    fireEvent.click(btnC);
    expect(submitAnswer).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSubmit({
        answer_id: "ans-1",
        question_id: q1.question.id,
        submitted_answer: "Chú thỏ",
        is_correct: true,
        score: 1,
        feedback_code: "CORRECT",
      });
    });

    // Clicking again after correct answer is solved must not re-submit
    fireEvent.click(btnC);
    expect(submitAnswer).toHaveBeenCalledTimes(1);
  });
});
