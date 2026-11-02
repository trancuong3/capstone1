import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReadingPronunciationReview } from "@/components/reading/reading-pronunciation-review";
import type { SpeechPlayOptions } from "@/hooks/use-speech-player";
import type { PronunciationReviewGroup } from "@/lib/utils/reading-pronunciation-alignment";

const mocks = vi.hoisted(() => ({
  recorderStart: vi.fn<() => Promise<void>>(),
  recorderStop: vi.fn<() => Promise<Blob | null>>(),
  recorderCancel: vi.fn(),
  playerPlay:
    vi.fn<(text: string, options?: SpeechPlayOptions) => Promise<void>>(),
  transcribe: vi.fn<
    (
      blob: Blob,
      options?: { languageCode?: string },
    ) => Promise<{
      text: string;
      words: { text: string; start: number; end: number; logprob: number }[];
      language_code: string;
      language_probability: number;
    }>
  >(),
}));

vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => ({
    isRecording: false,
    isSpeaking: false,
    audioLevel: 0,
    start: mocks.recorderStart,
    stop: mocks.recorderStop,
    cancel: mocks.recorderCancel,
    getStream: () => null,
  }),
}));

vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => ({
    isPlaying: false,
    play: mocks.playerPlay,
    stop: vi.fn(),
  }),
}));

vi.mock("@/lib/api/speech-service", () => ({
  createSpeechService: () => ({
    transcribe: mocks.transcribe,
  }),
}));

const candidateBase = {
  page_id: "30000000-0000-4000-8000-000000000001",
  page_number: 1,
  page_revision_id: "40000000-0000-4000-8000-000000000001",
  confidence: 0.95,
  sentence_text: "Bạn An khỏe không?",
  sentence_start_word_index: 0,
  sentence_end_word_index_exclusive: 4,
};

const reviewGroup: PronunciationReviewGroup = {
  key: "page-1:revision-1:sentence:0:4",
  page_id: candidateBase.page_id,
  page_number: 1,
  page_revision_id: candidateBase.page_revision_id,
  sentence_text: candidateBase.sentence_text,
  sentence_start_word_index: 0,
  sentence_end_word_index_exclusive: 4,
  words: [
    {
      ...candidateBase,
      word_id: "50000000-0000-4000-8000-000000000001",
      word_index: 1,
      expected_word: "An",
      recognized_word: "Anh",
    },
    {
      ...candidateBase,
      word_id: "50000000-0000-4000-8000-000000000002",
      word_index: 2,
      expected_word: "khỏe",
      recognized_word: "khẻo",
    },
  ],
};

function transcript(texts: string[]) {
  return {
    text: texts.join(" "),
    words: texts.map((text, index) => ({
      text,
      start: index * 0.25,
      end: index * 0.25 + 0.2,
      logprob: -0.05,
    })),
    language_code: "vi",
    language_probability: 0.99,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recorderStart.mockResolvedValue();
  mocks.recorderStop.mockResolvedValue(new Blob([new Uint8Array(1200)]));
  mocks.playerPlay.mockResolvedValue();
  mocks.transcribe
    .mockResolvedValueOnce(transcript(["An"]))
    .mockResolvedValueOnce(transcript(["khỏe"]))
    .mockResolvedValueOnce(transcript(["Bạn", "An", "khỏe", "không?"]));
});

describe("end-of-session pronunciation review", () => {
  it("records each wrong word individually, then reads the original sentence once", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    const onPracticeOutcome = vi.fn().mockResolvedValue(undefined);

    render(
      <ReadingPronunciationReview
        groups={[reviewGroup]}
        onComplete={onComplete}
        onPracticeOutcome={onPracticeOutcome}
      />,
    );

    expect(screen.getByTestId("pronunciation-review-target")).toHaveTextContent(
      "An",
    );

    await user.click(screen.getByRole("button", { name: "Bắt đầu đọc" }));
    await screen.findByRole("button", { name: "Dừng và kiểm tra" });
    await user.click(screen.getByRole("button", { name: "Dừng và kiểm tra" }));

    await waitFor(() => {
      expect(onPracticeOutcome).toHaveBeenCalledWith(
        reviewGroup.words[0],
        "WORD",
        "CORRECT",
        expect.any(Number),
        "An",
      );
    });

    expect(screen.getByTestId("pronunciation-review-target")).toHaveTextContent(
      "khỏe",
    );

    await user.click(screen.getByRole("button", { name: "Bắt đầu đọc" }));
    await screen.findByRole("button", { name: "Dừng và kiểm tra" });
    await user.click(screen.getByRole("button", { name: "Dừng và kiểm tra" }));

    await waitFor(() => {
      expect(onPracticeOutcome).toHaveBeenCalledWith(
        reviewGroup.words[1],
        "WORD",
        "CORRECT",
        expect.any(Number),
        "khỏe",
      );
    });

    expect(screen.getByTestId("pronunciation-review-target")).toHaveTextContent(
      "Bạn An khỏe không?",
    );
    expect(screen.getByTestId("reading-pronunciation-review")).toHaveAttribute(
      "data-review-phase",
      "sentence",
    );

    await user.click(screen.getByRole("button", { name: "Bắt đầu đọc" }));
    await screen.findByRole("button", { name: "Dừng và kiểm tra" });
    await user.click(screen.getByRole("button", { name: "Dừng và kiểm tra" }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
    expect(mocks.transcribe).toHaveBeenCalledTimes(3);
    expect(onPracticeOutcome).toHaveBeenCalledWith(
      reviewGroup.words[0],
      "SENTENCE",
      "CORRECT",
      expect.any(Number),
      "Bạn An khỏe không?",
    );
    expect(onPracticeOutcome).toHaveBeenCalledWith(
      reviewGroup.words[1],
      "SENTENCE",
      "CORRECT",
      expect.any(Number),
      "Bạn An khỏe không?",
    );
  });

  it("allows the child to stop a recording and does not trap an empty attempt in a retry loop", async () => {
    const user = userEvent.setup();
    mocks.recorderStop
      .mockResolvedValueOnce(new Blob([]))
      .mockResolvedValueOnce(new Blob([]));

    render(
      <ReadingPronunciationReview
        groups={[reviewGroup]}
        onComplete={vi.fn()}
        onPracticeOutcome={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Bắt đầu đọc" }));
    await screen.findByRole("button", { name: "Dừng và kiểm tra" });
    await user.click(screen.getByRole("button", { name: "Dừng và kiểm tra" }));
    expect(
      await screen.findByText("Mình chưa nghe rõ. Con thử đọc lại nhé."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Bắt đầu đọc" }));
    await screen.findByRole("button", { name: "Dừng và kiểm tra" });
    await user.click(screen.getByRole("button", { name: "Dừng và kiểm tra" }));

    expect(
      await screen.findByText(/Mình chưa nghe thấy giọng đọc rõ ràng/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tiếp tục" })).toBeEnabled();
  });

  it("records assisted practice only after the sample audio has fully ended", async () => {
    const user = userEvent.setup();
    const onPracticeOutcome = vi.fn().mockResolvedValue(undefined);
    let finishPlayback: (() => void) | undefined;

    mocks.playerPlay.mockImplementation(async (_text, options) => {
      finishPlayback = options?.onEnded;
    });

    render(
      <ReadingPronunciationReview
        groups={[reviewGroup]}
        onComplete={vi.fn()}
        onPracticeOutcome={onPracticeOutcome}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Nghe đọc mẫu" }));
    await waitFor(() => expect(mocks.playerPlay).toHaveBeenCalledOnce());

    expect(finishPlayback).toBeTypeOf("function");
    expect(onPracticeOutcome).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Tiếp tục" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      finishPlayback?.();
    });

    await waitFor(() => {
      expect(onPracticeOutcome).toHaveBeenCalledWith(
        reviewGroup.words[0],
        "WORD",
        "ASSISTED",
        null,
        null,
      );
    });
    expect(screen.getByRole("button", { name: "Tiếp tục" })).toBeEnabled();
  });

  it("does not persist assisted practice when the sample audio fails", async () => {
    const user = userEvent.setup();
    const onPracticeOutcome = vi.fn().mockResolvedValue(undefined);

    mocks.playerPlay.mockImplementation(async (_text, options) => {
      options?.onError?.();
    });

    render(
      <ReadingPronunciationReview
        groups={[reviewGroup]}
        onComplete={vi.fn()}
        onPracticeOutcome={onPracticeOutcome}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Nghe đọc mẫu" }));

    expect(
      await screen.findByText(
        "Chưa phát được giọng mẫu. Con vẫn có thể chuyển tiếp.",
      ),
    ).toBeInTheDocument();
    expect(onPracticeOutcome).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Tiếp tục" })).toBeEnabled();
  });
});
