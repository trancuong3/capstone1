import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DifficultWordPracticePanel } from "@/components/reports/difficult-word-practice-panel";
import { SHORT_WORD_CAPTURE_CONFIG } from "@/lib/reading/word-practice-engine";
import type {
  DifficultWordDTO,
  DifficultWordEvaluateDirectInput,
} from "@/types/reports";

const play = vi
  .fn<
    (
      text: string,
      options?: { wordSample?: boolean; coaching?: boolean },
    ) => Promise<void>
  >()
  .mockResolvedValue(undefined);
const recorder = {
  prepare: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => new Blob(["recording"], { type: "audio/webm" })),
  cancel: vi.fn(),
  getStream: () => null,
  getIsSpeaking: () => false,
  audioLevel: 0,
  getQuality: vi.fn(() => ({
    status: "SPEECH_DETECTED",
    durationMs: 650,
    rms: 0,
    speechDurationMs: 100,
  })),
};
const evaluate =
  vi.fn<
    (
      _child: string,
      _input: DifficultWordEvaluateDirectInput,
      _signal: AbortSignal,
    ) => Promise<unknown>
  >();
const service = {
  evaluatePracticeWord: evaluate,
  getPracticeHistory: async () => ({ storage_ready: true, items: [] }),
};
vi.mock("@/hooks/use-report-services", () => ({
  useReportServices: () => ({ difficultWordService: service }),
}));
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => recorder,
}));
vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => ({ play, isPlaying: false, stop: vi.fn() }),
}));
const word: DifficultWordDTO = {
  normalized_word: "một",
  display_text: "một",
  omission_count: 1,
  difficulty_score: 1,
  repetition_count: 0,
  long_pause_count: 0,
  read_example_count: 0,
  session_count: 1,
  last_seen_at: "",
  evidence_word_ids: [],
};
class Recognition {
  onresult?: (e: {
    resultIndex: number;
    results: {
      isFinal: boolean;
      0: { transcript: string; confidence: number };
    }[];
  }) => void;
  onend?: () => void;
  start() {
    recognitions.push(this);
  }
  stop() {
    this.onend?.();
  }
}
const recognitions: Recognition[] = [];
const result = (status: string, transcript: string) => ({
  assessment_status: status,
  spoken_transcript: transcript,
  audio_duration_ms: 650,
  word_progress: {
    practice_status: status === "CORRECT" ? "COMPLETED" : "IN_PROGRESS",
  },
});
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const sampleCount = () =>
  play.mock.calls.filter(
    ([text, options]) => text === "một" && options?.wordSample,
  ).length;
async function start(
  refresh = async () => {},
  target = word,
  onSelectWord = vi.fn(),
  words = [target],
) {
  await act(async () => {
    render(
      <DifficultWordPracticePanel
        child={{
          id: "child",
          parent_id: "parent",
          alias: "An",
          grade: 1,
          settings: {},
          created_at: "",
        }}
        word={target}
        words={words}
        onSelectWord={onSelectWord}
        onClose={vi.fn()}
        onProgressSaved={refresh}
      />,
    );
  });
  click("Bắt đầu luyện");
  await tick(SHORT_WORD_CAPTURE_CONFIG.acousticSettleMs + 30);
}
async function say(text: string, final = true) {
  act(() =>
    recognitions[recognitions.length - 1].onresult?.({
      resultIndex: 0,
      results: [{ isFinal: final, 0: { transcript: text, confidence: 0.95 } }],
    }),
  );
  const stop = screen.queryByRole("button", { name: "Dừng ghi âm" });
  if (stop) fireEvent.click(stop);
  await tick(SHORT_WORD_CAPTURE_CONFIG.acousticSettleMs + 30);
}
describe("hands-free word coaching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    recognitions.length = 0;
    evaluate.mockReset();
    vi.stubGlobal("SpeechRecognition", Recognition);
    recorder.getQuality.mockReturnValue({
      status: "SPEECH_DETECTED",
      durationMs: 650,
      rms: 0,
      speechDurationMs: 100,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ["INCORRECT", "CORRECT"],
    ["INCORRECT", "INCORRECT"],
    ["UNCERTAIN", "UNCERTAIN"],
  ] as const)(
    "uses the book phrase after two %s results and advances on %s",
    async (initialStatus, status) => {
      const target = {
        ...word,
        sources: [{ context_phrase: "Bé có một bông hoa.", last_seen_at: "" }],
      };
      const next = { ...word, normalized_word: "có", display_text: "có" };
      const selectWord = vi.fn();
      evaluate
        .mockResolvedValueOnce(result(initialStatus, "mốt"))
        .mockResolvedValueOnce(result(initialStatus, "mốt"))
        .mockResolvedValueOnce(
          result(
            status,
            status === "CORRECT" ? "một bông hoa" : "mốt bông hoa",
          ),
        );
      await start(undefined, target, selectWord, [target, next]);
      await say("mốt");
      expect(screen.queryByText("một bông hoa", { exact: true })).toBeNull();
      await say("mốt");
      expect(screen.getByText("một bông hoa", { exact: true })).toBeVisible();
      await say(status === "CORRECT" ? "một bông hoa" : "mốt bông hoa");
      if (status !== "CORRECT") {
        expect(screen.getByText(/Từ này chưa luyện xong/)).toBeVisible();
        expect(screen.queryByText("Hoàn thành từ này")).toBeNull();
      } else {
        expect(screen.getByText("Hoàn thành từ này")).toBeVisible();
      }
      await tick(SHORT_WORD_CAPTURE_CONFIG.autoAdvanceCorrectMs + 30);
      expect(selectWord).toHaveBeenCalledWith("có", { autoStart: true });
      expect(evaluate).toHaveBeenCalledTimes(3);
    },
  );

  it("models only the target after a final help request and pauses on the next request", async () => {
    await start();
    await say("Con không biết đọc.");
    expect(play.mock.calls.slice(-3)).toEqual([
      [
        "Không sao đâu. Con nghe cô đọc nhé.",
        { coaching: true, isPrivateBook: false, cacheScope: "COACHING" },
      ],
      [
        "một",
        expect.objectContaining({
          wordSample: true,
          cacheScope: expect.stringMatching(/^(CATALOG|PRIVATE)$/),
        }),
      ],
      [
        "Đến lượt con. Con đọc lại nhé.",
        { coaching: true, isPrivateBook: false, cacheScope: "COACHING" },
      ],
    ]);
    expect(recorder.start).toHaveBeenCalledTimes(2);
    await say("Con không biết.");
    await tick(20_000);
    expect(screen.getByRole("button", { name: "Tiếp tục thử" })).toBeEnabled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(recorder.start).toHaveBeenCalledTimes(2);
    expect(sampleCount()).toBe(1);
  });

  it("waits for two consecutive silent captures, opens one guided turn and then stops", async () => {
    recorder.getQuality.mockReturnValue({
      status: "SILENCE",
      durationMs: 4500,
      rms: 0,
      speechDurationMs: 0,
    });
    await start();
    await tick(4_600);
    expect(sampleCount()).toBe(0);
    await tick(4_700);
    expect(sampleCount()).toBe(1);
    await tick(10_000);
    expect(recorder.start).toHaveBeenCalledTimes(3);
    expect(evaluate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Tiếp tục thử" })).toBeEnabled();
  });

  it("uses server-only help, accepts the guided read and shows success while refresh is pending", async () => {
    evaluate
      .mockResolvedValueOnce(result("UNCERTAIN", "con chưa biết"))
      .mockResolvedValueOnce(result("CORRECT", "một"));
    await start(() => new Promise<void>(() => {}));
    await say("con chưa biết", false);
    expect(evaluate.mock.calls[0][1].browser_transcript).toBeUndefined();
    expect(sampleCount()).toBe(1);
    await say("một");
    expect(screen.getByText("Hoàn thành từ này")).toBeVisible();
    const stage = screen.getByRole("heading", { name: "một" }).parentElement!;
    expect(stage).toHaveClass("bg-emerald-50");
    expect(stage).toHaveAttribute("data-capture-ms", "650");
    click("Nghe phát âm mẫu");
    await tick(0);
    expect(sampleCount()).toBe(2);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled evaluation, reuses the same recording and ID, and ignores a late reply", async () => {
    let late!: (value: unknown) => void;
    evaluate
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            late = resolve;
          }),
      )
      .mockResolvedValueOnce(result("CORRECT", "một"));
    await start();
    await say("một");
    await tick(15_000);
    expect(evaluate.mock.calls[0][2].aborted).toBe(true);
    click("Lưu lại kết quả");
    await tick(0);
    const [first, second] = evaluate.mock.calls;
    expect(first[1].request_id).toBe(second[1].request_id);
    expect(first[1].audio).toBe(second[1].audio);
    await act(async () => late(result("INCORRECT", "mốt")));
    expect(screen.getByText("Hoàn thành từ này")).toBeVisible();
    expect(recorder.start).toHaveBeenCalledTimes(1);
  });
});
