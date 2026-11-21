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
  say(transcript: string, confidence = 0.95) {
    this.results.push({
      isFinal: true,
      length: 1,
      0: { transcript, confidence },
    });
    this.onresult?.({
      resultIndex: this.results.length - 1,
      results: [...this.results],
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
});
