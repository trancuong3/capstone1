import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKaraokePlayer } from "@/hooks/use-karaoke-player";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import { previewDetail, syllableLyrics } from "@/test/karaoke-fixtures";

const instances: TestAudio[] = [];
class TestAudio extends EventTarget {
  src = "";
  preload = "";
  volume = 1;
  currentTime = 0;
  duration = 20;
  paused = true;
  ended = false;
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause = vi.fn(() => {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  constructor() {
    super();
    instances.push(this);
  }
}
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  instances.length = 0;
  frames = new Map();
  let id = 0;
  vi.stubGlobal("Audio", TestAudio);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());
const url = "https://media.example.test/audio.mp3";
const expiry = "2099-01-01T00:00:00Z";
function loaded(audio = instances[0]) {
  act(() => audio.dispatchEvent(new Event("loadedmetadata")));
}

describe("karaoke single native-audio clock", () => {
  it("loops exactly a requested segment, slows audio and follows the media clock", async () => {
    const { result, unmount } = renderHook(() =>
      useKaraokePlayer(url, 20000, expiry),
    );
    loaded();
    act(() => result.current.setRate(0.75));
    expect((instances[0] as unknown as HTMLAudioElement).playbackRate).toBe(
      0.75,
    );
    await act(() => result.current.play(1000, 4000, true));
    act(() => {
      instances[0].currentTime = 4.1;
      instances[0].dispatchEvent(new Event("timeupdate"));
    });
    expect(instances[0].currentTime).toBe(1);
    expect(result.current.currentMs).toBe(1000);
    expect(instances[0].paused).toBe(false);
    act(() => result.current.pause());
    act(() => result.current.seek(8000));
    await act(() => result.current.play());
    act(() => {
      instances[0].currentTime = 9;
      instances[0].dispatchEvent(new Event("timeupdate"));
    });
    expect(result.current.currentMs).toBe(9000);
    unmount();
    expect(frames.size).toBe(0);
  });
  it("keeps v2 fill still while paused/buffering and recomputes after seeking", async () => {
    const source = { ...previewDetail(), lyrics: syllableLyrics() };
    const { container } = render(<KaraokePlayer source={source} />);
    loaded();
    const seek = screen.getByRole("slider", { name: "Vị trí phát" });
    fireEvent.change(seek, { target: { value: "1250" } });
    expect(container.querySelector("[data-state=active]")).toHaveStyle({
      "--karaoke-fill": "50%",
    });
    act(() => instances[0].dispatchEvent(new Event("waiting")));
    act(() => {
      [...frames.values()].forEach((cb) => cb(999999));
    });
    expect(container.querySelector("[data-state=active]")).toHaveStyle({
      "--karaoke-fill": "50%",
    });
    fireEvent.change(seek, { target: { value: "1600" } });
    expect(container.querySelector("[data-state=active]")).toBeNull();
    fireEvent.change(seek, { target: { value: "3300" } });
    expect(container.querySelector("[data-state=active]")).toHaveStyle({
      "--karaoke-fill": "50%",
    });
  });
  it("never autoplays, uses moderate volume and releases audio on unmount", () => {
    const { unmount } = renderHook(() => useKaraokePlayer(url, 20000, expiry));
    const audio = instances[0];
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.volume).toBe(0.6);
    unmount();
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.src).toBe("");
    expect(frames.size).toBe(0);
  });
  it("follows currentTime during playback, gaps, seeks, pauses and buffering", async () => {
    const { result } = renderHook(() => useKaraokePlayer(url, 20000, expiry));
    loaded();
    const audio = instances[0];
    await act(() => result.current.play());
    act(() => {
      audio.currentTime = 1.2;
      audio.dispatchEvent(new Event("timeupdate"));
    });
    expect(result.current.currentMs).toBe(1200);
    instances[0].currentTime = 1.256;
    expect(result.current.getCurrentMs()).toBe(1256);
    instances[0].currentTime = 1.2;
    act(() => audio.dispatchEvent(new Event("waiting")));
    expect(result.current.waiting).toBe(true);
    // Wall/animation ticks cannot advance a stopped audio clock.
    act(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(999999));
    });
    expect(result.current.currentMs).toBe(1200);
    act(() => result.current.seek(9000));
    expect(audio.currentTime).toBe(9);
    act(() => result.current.pause());
    expect(result.current.playing).toBe(false);
    expect(result.current.waiting).toBe(false);
  });
  it("clamps seek and volume and stops at a requested line end", async () => {
    const { result } = renderHook(() => useKaraokePlayer(url, 20000, expiry));
    loaded();
    act(() => {
      result.current.seek(90000);
      result.current.setVolume(9);
    });
    expect(instances[0].currentTime).toBe(20);
    expect(instances[0].volume).toBe(1);
    await act(() => result.current.play(1000, 3000));
    act(() => {
      instances[0].currentTime = 3;
      instances[0].dispatchEvent(new Event("timeupdate"));
    });
    expect(instances[0].paused).toBe(true);
  });
  it("replays at the beginning after end", async () => {
    const { result } = renderHook(() => useKaraokePlayer(url, 20000, expiry));
    loaded();
    act(() => {
      instances[0].currentTime = 20;
      instances[0].ended = true;
      instances[0].dispatchEvent(new Event("ended"));
    });
    await act(() => result.current.play());
    expect(instances[0].currentTime).toBe(0);
  });
  it("can seek to an exact integer-ms MP3 end that is not divisible by ten", async () => {
    const source = { ...previewDetail(), duration_ms: 103366 };
    render(<KaraokePlayer source={source} />);
    instances[0].duration = 103.3665;
    loaded();
    const position = screen.getByRole("slider", { name: "Vị trí phát" });
    expect(position).toHaveAttribute("step", "1");
    expect(position).toHaveAttribute("max", "103366");
    fireEvent.change(position, { target: { value: "103366" } });
    expect(instances[0].currentTime).toBe(103.366);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hát lại" }));
    });
    expect(instances[0].currentTime).toBe(0);
    expect(instances[0].play).toHaveBeenCalledOnce();
  });
  it("handles play rejection without unhandled promise or lost text", async () => {
    const { result } = renderHook(() => useKaraokePlayer(url, 20000, expiry));
    loaded();
    instances[0].play.mockRejectedValueOnce(
      new Error("NotAllowedError private"),
    );
    await act(() => result.current.play());
    expect(result.current.error).toContain("Trình duyệt");
    expect(result.current.playing).toBe(false);
  });
  it("coalesces pending play requests and pauses a late promise after disposal", async () => {
    const { result, unmount } = renderHook(() =>
      useKaraokePlayer(url, 20000, expiry),
    );
    loaded();
    let resolve!: () => void;
    instances[0].play.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.play();
    });
    await act(() => result.current.play());
    expect(instances[0].play).toHaveBeenCalledOnce();
    const old = instances[0];
    unmount();
    await act(async () => {
      old.paused = false;
      resolve();
      await promise;
    });
    expect(old.paused).toBe(true);
    expect(old.pause).toHaveBeenCalledTimes(2);
  });
  it("does not play expired or mismatched media", async () => {
    const { result } = renderHook(() =>
      useKaraokePlayer(url, 20000, "2000-01-01T00:00:00Z"),
    );
    loaded();
    await act(() => result.current.play());
    expect(instances[0].play).not.toHaveBeenCalled();
    expect(result.current.error).toContain("hết hạn");
  });
  it("blocks materially different native duration rather than stretching lyrics", async () => {
    const { result } = renderHook(() => useKaraokePlayer(url, 20000, expiry));
    instances[0].duration = 40;
    loaded();
    await act(() => result.current.play());
    expect(instances[0].play).not.toHaveBeenCalled();
    expect(result.current.error).toContain("không khớp");
  });
  it("shows safe media errors and ignores events after unmount", () => {
    const { result, unmount } = renderHook(() =>
      useKaraokePlayer(url, 20000, expiry),
    );
    act(() => instances[0].dispatchEvent(new Event("error")));
    expect(result.current.error).toContain("Không tải được nhạc");
    unmount();
    act(() => instances[0].dispatchEvent(new Event("playing")));
    expect(frames.size).toBe(0);
  });
  it("highlights [start,end) and uses live editor lyrics, never HTML", async () => {
    const onPlayed = vi.fn();
    const source = previewDetail();
    const { rerender, unmount } = render(
      <KaraokePlayer source={source} onPlayed={onPlayed} />,
    );
    loaded();
    fireEvent.click(screen.getByRole("button", { name: "Phát" }));
    await act(async () => {});
    expect(onPlayed).toHaveBeenCalledOnce();
    act(() => {
      instances[0].currentTime = 1.5;
      instances[0].dispatchEvent(new Event("timeupdate"));
    });
    expect(screen.getByTestId("karaoke-active-line")).toHaveTextContent(
      "Em vui đến trường",
    );
    rerender(
      <KaraokePlayer
        source={source}
        lyrics={{
          format_version: 1,
          lines: [{ ...source.lyrics.lines[0], text: "<b>Lời đang sửa</b>" }],
        }}
      />,
    );
    expect(screen.getByTestId("karaoke-active-line")).toHaveTextContent(
      "<b>Lời đang sửa</b>",
    );
    expect(
      screen.getByTestId("karaoke-active-line").querySelector("b"),
    ).toBeNull();
    expect(instances).toHaveLength(1);
    act(() => {
      instances[0].currentTime = 3;
      instances[0].dispatchEvent(new Event("timeupdate"));
    });
    expect(screen.getByTestId("karaoke-active-line")).not.toHaveTextContent(
      "Lời đang sửa",
    );
    unmount();
  });
  it("resets/stops the old audio when a renewed URL is loaded", () => {
    const source = previewDetail();
    const { rerender } = render(<KaraokePlayer source={source} />);
    loaded();
    const old = instances[0];
    rerender(
      <KaraokePlayer source={{ ...source, audio_url: `${url}?renewed=1` }} />,
    );
    expect(old.pause).toHaveBeenCalled();
    expect(old.src).toBe("");
    expect(instances).toHaveLength(2);
    expect(instances[1].play).not.toHaveBeenCalled();
  });
});
