import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import { previewDetail, syllableLyrics } from "@/test/karaoke-fixtures";

const audios: StageAudio[] = [];
class StageAudio extends EventTarget {
  src = "";
  preload = "";
  volume = 1;
  currentTime = 0;
  duration = 20;
  paused = true;
  ended = false;
  playbackRate = 1;
  preservesPitch = true;
  play = vi.fn(async () => {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause = vi.fn(() => {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  });
  load = vi.fn();
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  constructor() {
    super();
    audios.push(this);
  }
}
beforeEach(() => {
  audios.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("Audio", StageAudio);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function stage() {
  const source = {
    ...previewDetail(),
    lyrics: syllableLyrics(),
    author:
      "Alexander Blu · CC BY 4.0 https://creativecommons.org/licenses/by/4.0/",
  };
  const result = render(
    <KaraokePlayer
      source={source}
      presentation="child"
      childAlias="Bé Tú"
      label="Hát cùng bé"
      onReload={vi.fn()}
    />,
  );
  act(() => audios[0].dispatchEvent(new Event("loadedmetadata")));
  return result;
}
async function finishPreparation() {
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
}

describe("child karaoke stage", () => {
  it("waits for a gesture, counts in without moving lyrics, and cancels preparation", async () => {
    stage();
    const audio = audios[0];
    expect(audio.play).not.toHaveBeenCalled();
    expect(screen.getByTestId("karaoke-cue")).toHaveTextContent(
      "Bấm Bắt đầu hát",
    );
    expect(screen.queryByTestId("karaoke-countdown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bắt đầu hát" }));
    expect(screen.getByTestId("karaoke-countdown")).toHaveTextContent("3");
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("karaoke-countdown")).toHaveTextContent("2");
    act(() => vi.advanceTimersByTime(1000));
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.currentTime).toBe(0);
    expect(screen.getByTestId("karaoke-countdown")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "Hủy chuẩn bị" }));
    expect(screen.queryByTestId("karaoke-countdown")).toBeNull();
    await finishPreparation();
    expect(audio.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Bắt đầu hát" }));
    await finishPreparation();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("karaoke-countdown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng" }));
    fireEvent.click(screen.getByRole("button", { name: "Hát tiếp" }));
    await act(async () => {});
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
  it("never starts a pending countdown after leaving the stage", async () => {
    const { unmount } = stage();
    const audio = audios[0];
    fireEvent.click(screen.getByRole("button", { name: "Bắt đầu hát" }));
    unmount();
    await finishPreparation();
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.src).toBe("");
  });
  it("follows the audio clock across notes, buffering and seeking; slows native audio", async () => {
    const { container } = stage();
    const audio = audios[0];
    fireEvent.change(screen.getByRole("combobox", { name: "Tốc độ hát" }), {
      target: { value: "0.75" },
    });
    expect(audio.playbackRate).toBe(0.75);
    expect(audio.preservesPitch).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Bắt đầu hát" }));
    await finishPreparation();
    act(() => {
      audio.currentTime = 1.25;
      audio.dispatchEvent(new Event("timeupdate"));
    });
    expect(container.querySelector('[data-state="active"]')).toHaveStyle({
      "--karaoke-fill": "50%",
    });
    act(() => audio.dispatchEvent(new Event("stalled")));
    expect(screen.getByTestId("karaoke-cue")).toHaveTextContent("Câu đang hát");
    act(() => audio.dispatchEvent(new Event("waiting")));
    expect(screen.getByTestId("karaoke-cue")).toHaveTextContent(
      "Đang tải nhạc",
    );
    act(() => vi.advanceTimersByTime(10000));
    expect(container.querySelector('[data-state="active"]')).toHaveStyle({
      "--karaoke-fill": "50%",
    });
    fireEvent.change(screen.getByRole("slider", { name: "Vị trí phát" }), {
      target: { value: "1600" },
    });
    expect(container.querySelector('[data-state="active"]')).toBeNull();
  });
  it("prepares a selected line and resumes loops from the line start rather than the pause position", async () => {
    stage();
    const audio = audios[0];
    fireEvent.click(screen.getByText("Chọn câu để luyện"));
    fireEvent.click(
      screen.getByRole("button", { name: "Luyện câu 1: Bé hát, vui!" }),
    );
    await finishPreparation();
    expect(audio.currentTime).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Lặp câu" }));
    await act(async () => {});
    act(() => {
      audio.currentTime = 2;
      audio.dispatchEvent(new Event("timeupdate"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng" }));
    fireEvent.click(screen.getByRole("button", { name: "Hát tiếp" }));
    await act(async () => {});
    act(() => {
      audio.currentTime = 4.1;
      audio.dispatchEvent(new Event("timeupdate"));
    });
    expect(audio.currentTime).toBe(1);
    fireEvent.change(screen.getByRole("slider", { name: "Vị trí phát" }), {
      target: { value: "6000" },
    });
    expect(
      screen.queryByRole("button", { name: "Đang lặp câu" }),
    ).not.toBeInTheDocument();
  });
  it("offers a friendly finish and gesture-only replay, with attribution available in details", async () => {
    stage();
    const audio = audios[0];
    expect(
      screen.getByRole("heading", { name: "Bài hát của bé" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Âm lượng và thông tin bài hát"));
    expect(screen.getByText(/Alexander Blu/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Bắt đầu hát" }));
    await finishPreparation();
    act(() => {
      audio.currentTime = 20;
      audio.ended = true;
      audio.paused = true;
      audio.dispatchEvent(new Event("ended"));
    });
    expect(
      screen.getByRole("heading", { name: "Bé Tú đã hát xong rồi!" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Chọn bài khác" })).toHaveAttribute(
      "href",
      "/karaoke",
    );
    fireEvent.click(screen.getByRole("button", { name: "Hát lại bài này" }));
    expect(audio.play).toHaveBeenCalledOnce();
    await finishPreparation();
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
  it("celebrates the native ending despite tolerated MP3 duration precision", () => {
    stage();
    const audio = audios[0];
    act(() => {
      audio.duration = 19.998;
      audio.currentTime = 19.998;
      audio.ended = true;
      audio.dispatchEvent(new Event("ended"));
    });
    expect(
      screen.getByRole("button", { name: "Hát lại bài này" }),
    ).toBeVisible();
    fireEvent.change(screen.getByRole("slider", { name: "Vị trí phát" }), {
      target: { value: "5000" },
    });
    expect(
      screen.queryByRole("button", { name: "Hát lại bài này" }),
    ).toBeNull();
  });
  it("has a keyboard-accessible enlarged fallback and Escape restores focus", async () => {
    stage();
    const root = screen.getByRole("region", { name: "Hát cùng bé" });
    const expand = screen.getByRole("button", { name: "Mở rộng màn hát" });
    fireEvent.click(expand);
    await act(async () => {});
    expect(
      screen.getByRole("button", { name: "Thu gọn màn hát" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(root, { key: "Escape" });
    expect(
      screen.getByRole("button", { name: "Mở rộng màn hát" }),
    ).toHaveFocus();
  });
});

// SpeechRecognition delivers permission, final results and end as independent
// events. Tests control the order, just as the browser can delay the last words.
function installRecognition() {
  const instances: Recognition[] = [];
  class Recognition {
    onspeechstart: (() => void) | null = null;
    onspeechend: (() => void) | null = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onresult: ((event: ReturnType<typeof finalResults>) => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  vi.stubGlobal("SpeechRecognition", Recognition);
  return instances;
}
function finalResults(...phrases: string[]) {
  return {
    resultIndex: 0,
    results: phrases.map((transcript) => ({
      isFinal: true,
      0: { transcript, confidence: 0.99 },
    })),
  };
}
function clickButton(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}
function phrase(
  capture: ReturnType<typeof installRecognition>[number],
  from: number,
  to: number,
) {
  audios[0].currentTime = from;
  capture.onspeechstart?.();
  audios[0].currentTime = to;
  capture.onspeechend?.();
  audios[0].dispatchEvent(new Event("timeupdate"));
}
function finishSong() {
  act(() => {
    const audio = audios[0];
    audio.currentTime = audio.duration;
    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new Event("ended"));
  });
}
async function scoredStage() {
  const recognizers = installRecognition();
  const view = stage();
  clickButton("Hát có chấm điểm");
  clickButton("Bắt đầu hát");
  const probe = recognizers[0];
  expect(probe.start).toHaveBeenCalledOnce();
  expect(audios[0].play).not.toHaveBeenCalled();
  expect(screen.queryByTestId("karaoke-countdown")).toBeNull();
  await act(async () => probe.onstart?.());
  expect(screen.getByTestId("karaoke-countdown")).toHaveTextContent("3");
  await finishPreparation();
  expect(audios[0].play).toHaveBeenCalledOnce();
  const capture = recognizers[1];
  expect(capture.start).toHaveBeenCalledOnce();
  act(() => capture.onstart?.());
  return { view, recognizers, capture };
}

describe("child karaoke microphone lifecycle", () => {
  it("waits for permission before playback and lets the child sing freely after denial", async () => {
    const recognizers = installRecognition();
    stage();
    clickButton("Hát có chấm điểm");
    expect(recognizers).toHaveLength(0);
    clickButton("Bắt đầu hát");
    expect(recognizers[0].start).toHaveBeenCalledOnce();
    await finishPreparation();
    expect(audios[0].play).not.toHaveBeenCalled();
    await act(async () => recognizers[0].onerror?.({ error: "not-allowed" }));
    clickButton("Hát tự do");
    clickButton("Bắt đầu hát");
    await finishPreparation();
    expect(audios[0].play).toHaveBeenCalledOnce();
    expect(recognizers).toHaveLength(1);
    finishSong();
    expect(screen.queryByText(/^\d+\/100$/)).toBeNull();
  });

  it("keeps earlier finals on resume and ignores queued callbacks from before the pause", async () => {
    const { recognizers, capture } = await scoredStage();
    const oldResult = capture.onresult!;
    act(() => {
      phrase(capture, 1, 1.5);
      oldResult(finalResults("bé"));
    });
    clickButton("Tạm dừng");
    expect(capture.abort).toHaveBeenCalledOnce();
    act(() => oldResult(finalResults("bé", "hát")));
    clickButton("Hát tiếp");
    await act(async () => {});
    const resumed = recognizers.at(-1)!;
    expect(resumed).not.toBe(capture);
    act(() => {
      resumed.onstart?.();
      phrase(resumed, 2.6, 3.9);
      resumed.onresult?.(finalResults("vui"));
    });
    finishSong();
    act(() => resumed.onend?.());
    expect(screen.getByText("Đã đánh giá 2/3 tiếng.")).toBeVisible();
    expect(screen.getByText("Điểm phần đã nghe")).toBeVisible();
    expect(screen.getByText("100/100", { exact: true })).toBeVisible();
    expect(screen.queryByText("Điểm đúng lời", { exact: true })).toBeNull();
  });

  it("flushes the last final after native end and closes the score exactly once", async () => {
    const { capture, recognizers } = await scoredStage();
    const finishResult = capture.onresult!;
    const finishCycle = capture.onend!;
    act(() => {
      phrase(capture, 1, 1.5);
      finishResult(finalResults("bé"));
      phrase(capture, 1.8, 2.5);
    });
    // Native media can pause before the ended event. The MP3 clock can also
    // stop a few milliseconds short of the metadata duration stored by admin.
    act(() => {
      audios[0].duration = 19.998;
      audios[0].currentTime = 19.998;
      audios[0].ended = true;
      audios[0].pause();
    });
    finishSong();
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(screen.queryByText(/^\d+\/100$/)).toBeNull();
    act(() => {
      finishResult(finalResults("bé", "hát"));
      finishCycle();
    });
    expect(screen.getByText("Đã đánh giá 2/3 tiếng.")).toBeVisible();
    act(() => {
      finishResult(finalResults("bé", "hát", "vui"));
      finishCycle();
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getAllByText("Đã đánh giá 2/3 tiếng.")).toHaveLength(1);
    expect(recognizers).toHaveLength(2);
  });

  it("closes the score using accepted finals when the browser never sends end", async () => {
    const { capture } = await scoredStage();
    const lastResult = capture.onresult!;
    act(() => {
      phrase(capture, 1, 1.5);
      lastResult(finalResults("bé"));
    });
    finishSong();
    expect(screen.queryByText(/^\d+\/100$/)).toBeNull();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText("Đã đánh giá 1/3 tiếng.")).toBeVisible();
    act(() => lastResult(finalResults("bé", "hát vui")));
    expect(screen.getByText("Đã đánh giá 1/3 tiếng.")).toBeVisible();
  });

  it("ignores a permission grant after the child cancels the start", async () => {
    const recognizers = installRecognition();
    stage();
    clickButton("Hát có chấm điểm");
    clickButton("Bắt đầu hát");
    const oldStart = recognizers[0].onstart!;
    clickButton("Hủy chuẩn bị");
    await act(async () => oldStart());
    await finishPreparation();
    expect(audios[0].play).not.toHaveBeenCalled();
    expect(recognizers).toHaveLength(1);
    expect(recognizers[0].abort).toHaveBeenCalledOnce();
  });

  it("isolates a replay even when results from the previous song arrive late", async () => {
    const { capture, recognizers } = await scoredStage();
    const oldResult = capture.onresult!;
    act(() => {
      phrase(capture, 1, 4);
      oldResult(finalResults("bé hát vui"));
    });
    finishSong();
    act(() => capture.onend?.());
    expect(screen.getByText("Điểm đúng lời", { exact: true })).toBeVisible();
    expect(screen.getByText("100/100", { exact: true })).toBeVisible();
    clickButton("Hát lại bài này");
    await act(async () => recognizers.at(-1)!.onstart?.());
    await finishPreparation();
    const replay = recognizers.at(-1)!;
    expect(replay).not.toBe(capture);
    act(() => {
      replay.onstart?.();
      oldResult(finalResults("bé hát vui"));
    });
    finishSong();
    act(() => replay.onend?.());
    expect(screen.getByText(/Mình chưa nghe rõ/)).toBeVisible();
    expect(screen.queryByText(/^\d+\/100$/)).toBeNull();
  });

  it("retains the words heard before a network error without grading the silent remainder", async () => {
    const { capture } = await scoredStage();
    act(() => {
      phrase(capture, 1, 1.5);
      capture.onresult?.(finalResults("bé"));
      capture.onerror?.({ error: "network" });
    });
    finishSong();
    expect(screen.getByText("Đã đánh giá 1/3 tiếng.")).toBeVisible();
    expect(screen.getByText("Điểm phần đã nghe")).toBeVisible();
    expect(screen.getByText("100/100", { exact: true })).toBeVisible();
  });

  it("marks the exact live words, isolates speaker backing and preserves the song score after practice", async () => {
    const { capture, recognizers } = await scoredStage();
    expect(audios[0]).toHaveProperty("muted", true);
    const headphones = screen.getByRole("checkbox", { name: /tai nghe/ });
    fireEvent.click(headphones);
    expect(audios[0]).toHaveProperty("muted", false);
    fireEvent.click(headphones);
    expect(audios[0]).toHaveProperty("muted", true);
    act(() => {
      phrase(capture, 1, 3.9);
      capture.onresult?.(finalResults("bé vui"));
    });
    const confirmed = screen
      .getByTestId("karaoke-active-line")
      .querySelectorAll("[data-heard]");
    expect([...confirmed].map((el) => el.textContent)).toEqual([
      "Bé (đã nghe khớp)",
      "vui (đã nghe khớp)",
    ]);
    finishSong();
    act(() => capture.onend?.());
    expect(screen.getByText("Điểm đúng lời", { exact: true })).toBeVisible();
    expect(screen.getByText("67/100", { exact: true })).toBeVisible();
    clickButton("Luyện lại câu 1");
    await act(async () => recognizers.at(-1)!.onstart?.());
    await finishPreparation();
    const practice = recognizers.at(-1)!;
    act(() => {
      practice.onstart?.();
      phrase(practice, 1, 3.99);
      practice.onresult?.(finalResults("bé hát vui"));
      audios[0].currentTime = 4.1;
      audios[0].dispatchEvent(new Event("timeupdate"));
    });
    act(() => practice.onend?.());
    expect(
      screen.getByText("Bé hát khớp 3/3 tiếng trong phần đã nghe."),
    ).toBeVisible();
    expect(screen.queryByText(/^\d+\/100$/)).toBeNull();
    clickButton("Về kết quả bài hát");
    expect(screen.getByText("67/100", { exact: true })).toBeVisible();
  });

  it("releases the listening microphone when the child leaves the song", async () => {
    const { view, capture, recognizers } = await scoredStage();
    const lateEnd = capture.onend!;
    view.unmount();
    expect(capture.abort).toHaveBeenCalledOnce();
    act(() => {
      lateEnd();
      vi.advanceTimersByTime(5000);
    });
    expect(recognizers).toHaveLength(2);
  });

  it("keeps interim feedback neutral, then shows confirmed right/wrong and the final score", async () => {
    const recognizers = installRecognition();
    stage();
    // Start in free mode first, then switch to scored mode while playing
    clickButton("Bắt đầu hát");
    await finishPreparation();
    expect(
      screen.getByRole("button", { name: "Hát có chấm điểm" }),
    ).not.toBeDisabled();
    clickButton("Hát có chấm điểm");
    clickButton("Bắt đầu hát");
    await act(async () => recognizers[0].onstart?.());
    await finishPreparation();
    const capture = recognizers[1];
    act(() => {
      capture.onstart?.();
      audios[0].currentTime = 1.4;
      audios[0].dispatchEvent(new Event("timeupdate"));
      // Interim result while singing: "bé nói" ("bé" right, "nói" wrong for "hát")
      capture.onresult?.({
        resultIndex: 0,
        results: [
          {
            isFinal: false,
            0: { transcript: "bé nói", confidence: 0.95 },
          },
        ],
      });
    });
    const activeLine = screen.getByTestId("karaoke-active-line");
    expect(
      activeLine.querySelector('[data-word-state="processing"]'),
    ).toHaveTextContent("Bé");
    expect(
      activeLine.querySelector('[data-word-state="different"]'),
    ).toBeNull();
    expect(activeLine.querySelector('[data-word-state="omitted"]')).toBeNull();
    expect(screen.getByTestId("karaoke-live-feedback")).toHaveTextContent(
      "Đúng: 0",
    );
    expect(screen.getByTestId("karaoke-live-feedback")).toHaveTextContent(
      "Chưa đúng: 0",
    );

    // Final result: "bé nói vui" ("bé" matched, "hát" different, "vui" matched)
    act(() => {
      phrase(capture, 1, 3.8);
      capture.onresult?.(finalResults("bé nói vui"));
    });
    expect(
      activeLine.querySelector('[data-word-state="different"]'),
    ).toHaveTextContent("hát (chưa đúng lời)");
    expect(screen.getByTestId("karaoke-live-feedback")).toHaveTextContent(
      "Đúng: 2",
    );
    expect(screen.getByTestId("karaoke-live-feedback")).toHaveTextContent(
      "Chưa đúng: 1",
    );
    expect(screen.getByTestId("karaoke-live-feedback")).toHaveTextContent(
      "Tỉ lệ đúng: 67%",
    );

    // Finish and score the song via the dedicated button
    clickButton("Kết thúc & chấm điểm");
    act(() => capture.onend?.());
    expect(screen.getByText("Điểm đúng lời", { exact: true })).toBeVisible();
    expect(screen.getByText("67/100", { exact: true })).toBeVisible();
    const breakdown = screen.getByTestId("karaoke-score-breakdown");
    expect(breakdown).toHaveTextContent("Hát đúng2");
    expect(breakdown).toHaveTextContent("Chưa đúng1");
    expect(breakdown).toHaveTextContent("Bỏ qua0");
  });

  it("keeps missing recognition pending and finishes unassessed instead of assigning zero", async () => {
    const { capture } = await scoredStage();
    for (const ms of [
      500, 1000, 1300, 1660, 2000, 2400, 2660, 3100, 3600, 3950,
    ]) {
      act(() => {
        audios[0].currentTime = ms / 1000;
        audios[0].dispatchEvent(new Event("timeupdate"));
      });
    }
    const activeLine = screen.getByTestId("karaoke-active-line");
    expect(
      activeLine.querySelectorAll('[data-word-state="omitted"]'),
    ).toHaveLength(0);
    expect(screen.getByTestId("karaoke-live-feedback")).toHaveTextContent(
      "Bỏ qua: 0",
    );
    expect(screen.getByTestId("karaoke-live-feedback")).toHaveTextContent(
      "Đang xử lý:",
    );
    expect(screen.getByTestId("karaoke-live-feedback")).not.toHaveTextContent(
      "Tỉ lệ đúng:",
    );
    clickButton("Kết thúc & chấm điểm");
    act(() => capture.onend?.());
    expect(screen.queryByText("0/100", { exact: true })).toBeNull();
    expect(
      screen.getByText("Mình chưa nghe rõ. Bé thử lại nhé!"),
    ).toBeVisible();
    expect(
      screen.getByText("Chưa đánh giá: 3 tiếng. Phần này không tính là sai."),
    ).toBeVisible();
  });
});
