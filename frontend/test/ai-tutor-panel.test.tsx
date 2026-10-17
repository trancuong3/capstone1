// Isolated tutor interactions; voice and AI use test doubles only.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiTutorPanel } from "@/components/reading/ai-tutor-panel";
import { createTutorService, type TutorService } from "@/lib/api/tutor-service";

const { play, stop } = vi.hoisted(() => ({
  play: vi.fn<(text: string) => Promise<void>>(),
  stop: vi.fn(),
}));
vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => ({ play, stop, isPlaying: false }),
}));

const selection = {
  page_revision_id: "55555555-5555-4555-8555-555555555555",
  word_id: "66666666-6666-4666-8666-666666666666",
  word: "nghiêng",
};
const explanation = {
  ...selection,
  explanation: "Lệch sang một bên.",
  reading_hint: "Bé đọc lại câu nhé.",
};

function fixture(selected = true) {
  const explainWord = vi
    .fn<TutorService["explainWord"]>()
    .mockResolvedValue(explanation);
  const props = {
    sessionId: "77777777-7777-4777-8777-777777777777",
    selection: selected ? selection : null,
    service: { ...createTutorService(), explainWord },
    onOpen: vi.fn(),
    onDismiss: vi.fn(),
    onContinue: vi.fn(),
  };
  return { props, explainWord };
}

beforeEach(() => {
  play.mockReset().mockResolvedValue();
  stop.mockReset();
});

describe("AI tutor panel", () => {
  it("asks for an explicit word selection without requesting AI", () => {
    const { props, explainWord } = fixture(false);
    render(<AiTutorPanel {...props} />);
    expect(
      screen.getByRole("button", { name: "Giải thích từ" }),
    ).toBeDisabled();
    expect(screen.getByText(/Bé chọn một từ/)).toBeInTheDocument();
    expect(explainWord).not.toHaveBeenCalled();
  });

  it("opens an accessible dialog, plays only on request and reuses the result", async () => {
    const user = userEvent.setup();
    const { props, explainWord } = fixture();
    render(<AiTutorPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Giải thích từ" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Mình cùng hiểu từ này nhé!",
    });
    expect(
      await within(dialog).findByText(explanation.explanation),
    ).toBeInTheDocument();
    expect(props.onOpen).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Nghe giải thích" }),
    );
    expect(play).toHaveBeenCalledWith(
      `${explanation.explanation} ${explanation.reading_hint}`,
    );
    await user.click(within(dialog).getByRole("button", { name: "Đọc tiếp" }));
    expect(props.onContinue).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Giải thích từ" }));
    expect(
      await screen.findByText(explanation.explanation),
    ).toBeInTheDocument();
    expect(explainWord).toHaveBeenCalledOnce();
  });

  it("shows provider failures with retry and a way to keep reading", async () => {
    const user = userEvent.setup();
    const { props, explainWord } = fixture();
    explainWord.mockRejectedValueOnce(new Error("private upstream details"));
    render(<AiTutorPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Giải thích từ" }));
    await user.click(await screen.findByRole("button", { name: "Thử lại" }));
    expect(
      await screen.findByText(explanation.explanation),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("private upstream details");
    expect(screen.getByRole("button", { name: "Đọc tiếp" })).toBeEnabled();
  });

  it("keeps explanation text and reading available when audio fails", async () => {
    play.mockRejectedValueOnce(new Error("TTS unavailable"));
    const user = userEvent.setup();
    const { props } = fixture();
    render(<AiTutorPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Giải thích từ" }));
    await user.click(
      await screen.findByRole("button", { name: "Nghe giải thích" }),
    );
    expect(
      await screen.findByText(/Mình chưa phát được âm thanh/),
    ).toBeInTheDocument();
    expect(screen.getByText(explanation.explanation)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Đọc tiếp" }));
    expect(props.onContinue).toHaveBeenCalledOnce();
  });

  it("Escape aborts pending requests and never resumes the microphone implicitly", async () => {
    const user = userEvent.setup();
    const { props, explainWord } = fixture();
    let resolve: (value: typeof explanation) => void = () => undefined;
    explainWord.mockReturnValueOnce(
      new Promise((settle) => {
        resolve = settle;
      }),
    );
    render(<AiTutorPanel {...props} />);
    const trigger = screen.getByRole("button", { name: "Giải thích từ" });
    await user.click(trigger);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(explainWord.mock.calls[0][2]?.aborted).toBe(true);
    expect(props.onContinue).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    await act(async () => resolve(explanation));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders model text as text rather than injecting HTML", async () => {
    const user = userEvent.setup();
    const { props, explainWord } = fixture();
    explainWord.mockResolvedValueOnce({
      ...explanation,
      explanation: "<img src=x onerror=alert(1)>",
    });
    render(<AiTutorPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Giải thích từ" }));
    expect(
      await screen.findByText("<img src=x onerror=alert(1)>"),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog").querySelector("img")).toBeNull();
  });
});
