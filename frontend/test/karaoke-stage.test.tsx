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
    fireEvent.click(screen.getByRole("button", { name: "Bắt đầu hát" }));
    expect(screen.getByTestId("karaoke-cue")).toHaveTextContent("Chuẩn bị · 3");
    act(() => vi.advanceTimersByTime(2000));
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.currentTime).toBe(0);
    expect(screen.getByTestId("karaoke-cue")).toHaveTextContent("Chuẩn bị · 1");
    fireEvent.click(screen.getByRole("button", { name: "Hủy chuẩn bị" }));
    await finishPreparation();
    expect(audio.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Bắt đầu hát" }));
    await finishPreparation();
    expect(audio.play).toHaveBeenCalledOnce();
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
    act(() => audio.dispatchEvent(new Event("waiting")));
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
