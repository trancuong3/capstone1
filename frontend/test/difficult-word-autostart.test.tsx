import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DifficultWordPracticePanel } from "@/components/reports/difficult-word-practice-panel";
import type { DifficultWordDTO } from "@/types/reports";

// ---------------------------------------------------------------------------
// Mocks (same pattern as difficult-word-coaching.test.tsx)
// ---------------------------------------------------------------------------

const play = vi
  .fn<(text: string, options?: { wordSample?: boolean }) => Promise<void>>()
  .mockResolvedValue(undefined);

const recorder = {
  prepare: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => new Blob(["recording"], { type: "audio/webm" })),
  cancel: vi.fn(),
  getIsSpeaking: () => false,
  audioLevel: 0,
  getQuality: vi.fn(() => ({
    status: "SPEECH_DETECTED",
    durationMs: 650,
    rms: 0,
    speechDurationMs: 100,
  })),
};

const service = {
  evaluatePracticeWord: vi.fn(),
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
  normalized_word: "bướm",
  display_text: "bướm",
  omission_count: 1,
  difficulty_score: 1,
  repetition_count: 0,
  long_pause_count: 0,
  read_example_count: 0,
  session_count: 1,
  last_seen_at: "",
  evidence_word_ids: [],
};

const child = {
  id: "child-1",
  parent_id: "parent-1",
  alias: "An",
  grade: 1,
  settings: {},
  created_at: "",
};

// Stub SpeechRecognition
class Recognition {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives?: number;
  onresult: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onend: (() => void) | null = null;
  start() {}
  stop() {
    this.onend?.();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DifficultWordPracticePanel – autoStart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("auto-starts the practice flow when autoStart=true (no extra click needed)", async () => {
    await act(async () => {
      render(
        <DifficultWordPracticePanel
          autoStart={true}
          child={child}
          onAttemptCompleted={vi.fn()}
          onClose={vi.fn()}
          onProgressSaved={vi.fn()}
          onSelectWord={vi.fn()}
          word={word}
          words={[word]}
        />,
      );
    });

    // Let the useEffect's setTimeout(…, 0) fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // `recorder.prepare` is called → the hands-free flow started automatically.
    expect(recorder.prepare).toHaveBeenCalledOnce();

    // Keep the coaching cue separate from pronunciation playback.
    expect(play).toHaveBeenNthCalledWith(1, "Con đọc từ trên màn hình nhé.");
  });

  it("does NOT auto-start when autoStart is false (URL-based entry)", async () => {
    await act(async () => {
      render(
        <DifficultWordPracticePanel
          autoStart={false}
          child={child}
          onAttemptCompleted={vi.fn()}
          onClose={vi.fn()}
          onProgressSaved={vi.fn()}
          onSelectWord={vi.fn()}
          word={word}
          words={[word]}
        />,
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // `recorder.prepare` should NOT have been called.
    expect(recorder.prepare).not.toHaveBeenCalled();
    // No coaching TTS should have played.
    expect(play).not.toHaveBeenCalled();
  });

  it("falls back to PAUSED state with retry when microphone is denied during autoStart", async () => {
    recorder.prepare.mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), {
        name: "NotAllowedError",
      }),
    );

    await act(async () => {
      render(
        <DifficultWordPracticePanel
          autoStart={true}
          child={child}
          onAttemptCompleted={vi.fn()}
          onClose={vi.fn()}
          onProgressSaved={vi.fn()}
          onSelectWord={vi.fn()}
          word={word}
          words={[word]}
        />,
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(recorder.prepare).toHaveBeenCalledOnce();

    // Should show a microphone error message.
    expect(screen.getByText(/quyền Micro|micro/i)).toBeDefined();

    // Should show a retry/"Tiếp tục luyện" button so the user has exactly one clear action.
    const retryButton = screen.queryByRole("button", {
      name: /Tiếp tục luyện|Bắt đầu luyện|Thử lại từ này/i,
    });
    expect(retryButton).not.toBeNull();
  });

  it("does not trigger autoStart twice on re-render", async () => {
    const { rerender } = await act(async () =>
      render(
        <DifficultWordPracticePanel
          autoStart={true}
          child={child}
          onAttemptCompleted={vi.fn()}
          onClose={vi.fn()}
          onProgressSaved={vi.fn()}
          onSelectWord={vi.fn()}
          word={word}
          words={[word]}
        />,
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(recorder.prepare).toHaveBeenCalledOnce();

    // Trigger a re-render with same props.
    recorder.prepare.mockClear();
    await act(async () => {
      rerender(
        <DifficultWordPracticePanel
          autoStart={true}
          child={child}
          onAttemptCompleted={vi.fn()}
          onClose={vi.fn()}
          onProgressSaved={vi.fn()}
          onSelectWord={vi.fn()}
          word={word}
          words={[word]}
        />,
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // `didAutoStartRef` should prevent a second invocation.
    expect(recorder.prepare).not.toHaveBeenCalled();
  });
});
