import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useKaraokeScoring } from "@/hooks/use-karaoke-scoring";
import type { BrowserRecognitionEventLike } from "@/lib/reading/browser-transcript-collector";
import type { KaraokeLyrics } from "@/types/karaoke";
import * as signalMonitor from "@/lib/karaoke/microphone-signal";

class FakeRecognizer {
  static instances: FakeRecognizer[] = [];
  onstart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onspeechend: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: BrowserRecognitionEventLike) => void) | null = null;
  start = vi.fn();
  abort = vi.fn();
  stop = vi.fn();
  constructor() {
    FakeRecognizer.instances.push(this);
  }
}

const lyrics: KaraokeLyrics = {
  format_version: 1,
  lines: [
    {
      id: "0e1139c9-0269-4bed-a815-a4b2d88e1f5c",
      text: "Bé đi học",
      start_ms: 0,
      end_ms: 3000,
    },
  ],
};
const final = (transcript: string): BrowserRecognitionEventLike => ({
  resultIndex: 0,
  results: [{ isFinal: true, 0: { transcript } }],
});
const latest = () => FakeRecognizer.instances.at(-1)!;

class TrackRecognizer extends FakeRecognizer {
  start = vi.fn((track?: MediaStreamTrack) => {
    if (track?.readyState === "ended")
      throw new DOMException("Ended track", "InvalidStateError");
  });
}

function microphoneStream() {
  const track = {
    readyState: "live",
    onended: null as (() => void) | null,
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  return { track, stream: stream as unknown as MediaStream };
}

function microphoneInput(getUserMedia: () => Promise<MediaStream>) {
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("SpeechRecognition", TrackRecognizer);
}
let mediaMs = 0;
const clock = () => mediaMs;
const mount = (song = lyrics) =>
  renderHook(() => useKaraokeScoring(song, clock));

function sing(
  capture: FakeRecognizer,
  start: number,
  end: number,
  phrase: string,
) {
  mediaMs = start;
  capture.onspeechstart?.();
  mediaMs = end;
  capture.onspeechend?.();
  capture.onresult?.(final(phrase));
}

async function startSinging({ result }: ReturnType<typeof mount>) {
  await act(async () => {
    const permission = result.current.arm();
    latest().onstart?.();
    expect(await permission).toBe(true);
    result.current.resume();
    latest().onstart?.();
  });
  return latest();
}

describe("the child's singing microphone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mediaMs = 0;
    FakeRecognizer.instances = [];
    vi.stubGlobal("SpeechRecognition", FakeRecognizer);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["drained", "network", "timeout"] as const)(
    "settles measured quiet only after successful drain (%s)",
    async (ending) => {
      const probe = microphoneStream();
      const input = microphoneStream();
      microphoneInput(
        vi
          .fn()
          .mockResolvedValueOnce(probe.stream)
          .mockResolvedValueOnce(input.stream),
      );
      let observe: signalMonitor.SignalObserver = () => {};
      const stop = vi.fn();
      vi.spyOn(signalMonitor, "monitorSingingTrack").mockImplementation(
        (_stream, _clock, callback) => {
          observe = callback;
          return stop;
        },
      );
      const view = mount();
      await act(async () => {
        expect(await view.result.current.arm()).toBe(true);
      });
      await act(async () => view.result.current.resume());
      const capture = latest();
      act(() => capture.onstart?.());
      act(() => {
        for (let ms = 0; ms < 3400; ms += 50) {
          mediaMs = ms + 50;
          observe(ms, ms + 50, "quiet");
          view.result.current.observePlayback(ms, ms + 50);
        }
      });
      expect(view.result.current.liveScore?.evaluatedWords).toBe(0);
      act(() => {
        if (ending === "network") capture.onerror?.({ error: "network" });
        view.result.current.finish();
        if (ending === "drained") capture.onend?.();
        if (ending === "timeout") vi.advanceTimersByTime(2001);
      });
      expect(view.result.current.score?.evaluatedWords ?? 0).toBe(
        ending === "drained" ? 3 : 0,
      );
      expect(stop).toHaveBeenCalledOnce();
      expect(input.track.stop).toHaveBeenCalledOnce();
    },
  );

  it("reconciles fragmented finals so a repeated syllable is not lost", async () => {
    const view = mount({
      ...lyrics,
      lines: [{ ...lyrics.lines[0], text: "bé bé vui" }],
    });
    const capture = await startSinging(view);
    act(() => sing(capture, 0, 1000, "bé"));
    expect(view.result.current.liveScore?.matchedWords).toBe(0);
    act(() => {
      mediaMs = 1000;
      capture.onspeechstart?.();
      mediaMs = 3000;
      capture.onspeechend?.();
      capture.onresult?.({
        resultIndex: 1,
        results: [
          { isFinal: true, 0: { transcript: "bé" } },
          { isFinal: true, 0: { transcript: "bé vui" } },
        ],
      });
    });
    expect(view.result.current.liveScore?.matchedWords).toBe(3);
  });

  it("clears interim highlights when the final is rejected and when paused", async () => {
    const view = mount();
    const capture = await startSinging(view);
    act(() => {
      mediaMs = 1000;
      capture.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: false, 0: { transcript: "bé đi" } }],
      });
    });
    expect(view.result.current.previewWords.size).toBeGreaterThan(0);
    act(() => {
      mediaMs = 2000;
      capture.onresult?.({
        resultIndex: 0,
        results: [
          { isFinal: true, 0: { transcript: "bé đi", confidence: 0.1 } },
        ],
      });
    });
    expect(view.result.current.previewWords.size).toBe(0);
    expect(view.result.current.liveScore?.evaluatedWords).toBe(0);
    act(() => {
      capture.onresult?.({
        resultIndex: 1,
        results: [
          { isFinal: true, 0: { transcript: "bé đi", confidence: 0.1 } },
          { isFinal: false, 0: { transcript: "học" } },
        ],
      });
      view.result.current.pause();
    });
    expect(view.result.current.previewWords.size).toBe(0);
  });

  it("does not turn a rejected middle fragment into a missing lyric", async () => {
    const view = mount();
    const capture = await startSinging(view);
    act(() => sing(capture, 0, 1000, "bé"));
    act(() => {
      mediaMs = 1000;
      capture.onspeechstart?.();
      mediaMs = 1200;
      capture.onspeechend?.();
      capture.onresult?.({
        resultIndex: 1,
        results: [
          { isFinal: true, 0: { transcript: "bé" } },
          { isFinal: true, 0: { transcript: "đi", confidence: 0.1 } },
        ],
      });
      capture.onspeechstart?.();
      mediaMs = 3000;
      capture.onspeechend?.();
      capture.onresult?.({
        resultIndex: 2,
        results: [
          { isFinal: true, 0: { transcript: "bé" } },
          { isFinal: true, 0: { transcript: "đi", confidence: 0.1 } },
          { isFinal: true, 0: { transcript: "học" } },
        ],
      });
    });
    expect(
      view.result.current.liveScore?.lineScores[0].words.map((w) => w.state),
    ).toEqual(["matched", "unknown", "matched"]);
  });

  it("settles permission once, and discards callbacks from the probe after playback starts", async () => {
    const { result } = mount();
    let permission!: Promise<boolean>;
    act(() => {
      permission = result.current.arm();
    });
    const probe = latest();
    const oldResult = probe.onresult;
    expect(probe.start).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("arming");

    act(() => {
      probe.onstart?.();
    });
    expect(await permission).toBe(true);
    expect(probe.abort).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("armed");

    act(() => {
      result.current.resume();
      latest().onstart?.();
      oldResult?.(final("Bé đi học"));
      result.current.finish();
      latest().onend?.();
    });
    expect(result.current.status).toBe("insufficient");
    expect(result.current.score).toBeNull();
  });

  it("keeps earlier finals on pause and drains only the current cycle at the end", async () => {
    const hook = mount();
    const { result } = hook;
    const first = await startSinging(hook);
    const stale = first.onresult;
    act(() => {
      sing(first, 0, 750, "Bé");
      result.current.pause();
      stale?.(final("đi"));
    });
    expect(first.abort).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("paused");

    act(() => {
      result.current.resume();
      latest().onstart?.();
      mediaMs = 2000;
      latest().onspeechstart?.();
      mediaMs = 3000;
      latest().onspeechend?.();
      result.current.finish();
      result.current.finish();
    });
    const tail = latest();
    expect(tail.stop).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("finishing");
    act(() => {
      tail.onresult?.(final("học"));
      tail.onresult?.(final("học"));
      tail.onend?.();
    });
    expect(result.current.score?.matchedWords).toBe(2);
    expect(result.current.status).toBe("scored");
  });

  it("times out a missing end event even when native start arrives after finish", async () => {
    const hook = mount();
    const { result } = hook;
    await startSinging(hook);
    act(() => {
      result.current.pause();
      result.current.resume();
      result.current.finish();
      latest().onstart?.();
      latest().onresult?.(final("..."));
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.score).toBeNull();
    expect(result.current.status).toBe("insufficient");
    expect(latest().abort).toHaveBeenCalledOnce();
  });

  it("preserves evidence through a mid-song device failure and does not restart on end", async () => {
    const hook = mount();
    const { result } = hook;
    const recognition = await startSinging(hook);
    const staleEnd = recognition.onend;
    act(() => {
      sing(recognition, 0, 1000, "Bé");
      recognition.onerror?.({ error: "audio-capture" });
      staleEnd?.();
    });
    expect(result.current.status).toBe("unavailable");
    expect(result.current.error).toMatch(/micro/i);
    expect(FakeRecognizer.instances).toHaveLength(2);
    act(() => {
      result.current.finish();
    });
    expect(result.current.score?.matchedWords).toBe(1);
    expect(result.current.error).toMatch(/micro/i);
  });

  it("bounds start attempts and abandons an unanswered permission prompt", async () => {
    const { result } = mount();
    let permission!: Promise<boolean>;
    act(() => {
      permission = result.current.arm();
      vi.advanceTimersByTime(15_000);
    });
    expect(await permission).toBe(false);
    expect(result.current.status).toBe("unavailable");
    expect(latest().abort).toHaveBeenCalledOnce();
  });

  it("credits delayed words to the heard occurrence and ignores stale callbacks after a seek", async () => {
    const verse = lyrics.lines[0];
    const song = {
      ...lyrics,
      lines: [verse, { ...verse, id: "repeat", start_ms: 6000, end_ms: 9000 }],
    };
    const hook = mount(song);
    const first = await startSinging(hook);
    const oldFinal = first.onresult!;
    act(() => {
      mediaMs = 10;
      first.onspeechstart?.();
      mediaMs = 2900;
      first.onspeechend?.();
      // This final arrives during the identical next chorus.
      mediaMs = 6600;
      oldFinal(final("bé đi học"));
    });
    expect(
      hook.result.current.liveScore?.lineScores.map((l) => l.matchedWords),
    ).toEqual([3, 0]);
    act(() => {
      mediaMs = 7000;
      hook.result.current.seekBoundary();
      latest().onstart?.();
      oldFinal(final("bé đi học"));
    });
    expect(
      hook.result.current.liveScore?.lineScores.map((l) => l.matchedWords),
    ).toEqual([3, 0]);
    act(() => sing(latest(), 7050, 8800, "đi học"));
    expect(
      hook.result.current.liveScore?.lineScores.map((l) => l.matchedWords),
    ).toEqual([3, 2]);
  });

  it("uses short native-clock windows without speech events, rejecting implausibly delayed and uncertain finals", async () => {
    const song = {
      ...lyrics,
      lines: [
        lyrics.lines[0],
        { ...lyrics.lines[0], id: "repeat", start_ms: 10000, end_ms: 13000 },
      ],
    };
    const hook = mount(song);
    const capture = await startSinging(hook);
    act(() => {
      mediaMs = 11000;
      capture.onresult?.(final("bé đi học"));
    });
    expect(hook.result.current.liveScore?.evaluatedWords).toBe(0);
    act(() => {
      mediaMs = 11700;
      capture.onresult?.({
        resultIndex: 1,
        results: [
          final("bé đi học").results[0],
          { isFinal: true, 0: { transcript: "đi", confidence: 0.1 } },
        ],
      });
      mediaMs = 12600;
      const slots = ["bé đi học", "đi", "học"].map(
        (text) => final(text).results[0],
      );
      capture.onresult?.({ resultIndex: 1, results: slots });
    });
    expect(
      hook.result.current.liveScore?.lineScores.map((l) => l.matchedWords),
    ).toEqual([0, 1]);
  });

  it("assigns batched finals to separate closed and ongoing speech windows", async () => {
    const first = lyrics.lines[0];
    const song = {
      ...lyrics,
      lines: [first, { ...first, id: "chorus", start_ms: 6000, end_ms: 9000 }],
    };
    const hook = mount(song);
    const capture = await startSinging(hook);
    act(() => {
      capture.onspeechstart?.();
      mediaMs = 3000;
      capture.onspeechend?.();
      mediaMs = 6000;
      capture.onspeechstart?.();
      mediaMs = 9000;
      capture.onresult?.({
        resultIndex: 0,
        results: [final("bé đi học").results[0], final("bé đi học").results[0]],
      });
    });
    expect(
      hook.result.current.liveScore?.lineScores.map(
        (line) => line.matchedWords,
      ),
    ).toEqual([3, 3]);
  });

  it("keeps practice scoped to its line and restores the completed song", async () => {
    const hook = mount();
    const { result } = hook;
    const capture = await startSinging(hook);
    act(() => {
      sing(capture, 0, 3000, "bé đi học");
      result.current.finish();
      capture.onend?.();
    });
    const original = result.current.score;
    expect(original?.overallAccuracy).toBe(100);
    let practice!: FakeRecognizer;
    await act(async () => {
      const permission = result.current.arm(lyrics.lines[0].id);
      latest().onstart?.();
      expect(await permission).toBe(true);
      result.current.resume();
      practice = latest();
      mediaMs = 0;
      practice.onstart?.();
      sing(practice, 0, 3000, "mèo đang chơi");
      result.current.finish();
      practice.onend?.();
    });
    expect(result.current.score).toMatchObject({
      kind: "partial",
      matchedWords: 0,
      evaluatedWords: 3,
    });
    expect(result.current.songScore).toBe(original);
    act(() => result.current.endPractice());
    expect(result.current.score).toBe(original);
    expect(result.current.status).toBe("scored");
  });

  it("starts a fresh line result for each loop and ignores the previous pass", async () => {
    const { result } = mount();
    await act(async () => {
      const permission = result.current.arm(lyrics.lines[0].id);
      latest().onstart?.();
      expect(await permission).toBe(true);
      result.current.resume();
      latest().onstart?.();
      sing(latest(), 0, 3000, "bé đi học");
    });
    expect(result.current.liveScore?.matchedWords).toBe(3);
    const previous = latest().onresult!;
    act(() => {
      mediaMs = 0;
      result.current.seekBoundary(true);
      previous(final("bé đi học"));
      latest().onstart?.();
    });
    expect(result.current.liveScore?.evaluatedWords).toBe(0);
    act(() => {
      sing(latest(), 0, 1250, "bé");
      result.current.finish();
      latest().onend?.();
    });
    expect(result.current.score).toMatchObject({
      kind: "partial",
      matchedWords: 1,
    });
    expect(result.current.songScore).toBeNull();
  });

  it("does not restart an exhausted browser recognition loop", async () => {
    const hook = mount();
    const { result } = hook;
    await startSinging(hook);
    act(() => {
      for (let i = 0; i < 3; i++) {
        latest().onend?.();
        latest().onstart?.();
      }
    });
    expect(result.current.status).toBe("unavailable");
    expect(FakeRecognizer.instances).toHaveLength(4);
  });

  it("ignores native results and permission from a revoked attempt", async () => {
    const { result, unmount } = mount();
    let oldPermission!: Promise<boolean>;
    act(() => {
      oldPermission = result.current.arm();
    });
    const oldStart = latest().onstart;
    act(() => {
      result.current.reset();
      oldStart?.();
    });
    expect(await oldPermission).toBe(false);
    expect(result.current.status).toBe("idle");
    let nextPermission!: Promise<boolean>;
    act(() => {
      nextPermission = result.current.arm();
    });
    unmount();
    expect(await nextPermission).toBe(false);
    expect(latest().abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("chooses the acquired audio track and drains final lyrics against the exact slice before reusing it", async () => {
    const probe = microphoneStream();
    const capture = microphoneStream();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(probe.stream)
      .mockResolvedValueOnce(capture.stream);
    microphoneInput(getUserMedia);
    const verse = lyrics.lines[0];
    const { result } = mount({
      ...lyrics,
      lines: [
        verse,
        { ...verse, id: "repeated", start_ms: 3050, end_ms: 6050 },
      ],
    });
    await act(async () => {
      expect(await result.current.arm()).toBe(true);
    });
    expect(probe.track.stop).toHaveBeenCalledOnce();
    expect(latest().start).toHaveBeenCalledWith(probe.track);
    await act(async () => result.current.resume());
    const first = latest();
    expect(first.start).toHaveBeenCalledWith(capture.track);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    act(() => {
      first.onstart?.();
      mediaMs = 3000;
      vi.advanceTimersByTime(101);
    });
    expect(first.stop).toHaveBeenCalledOnce();
    expect(capture.track.stop).not.toHaveBeenCalled();
    act(() => {
      mediaMs = 3500;
      first.onresult?.(final(verse.text));
      first.onend?.();
      latest().onstart?.();
    });
    expect(
      result.current.liveScore?.lineScores.map((line) => line.matchedWords),
    ).toEqual([3, 0]);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(latest().start).toHaveBeenCalledWith(capture.track);
    act(() => {
      result.current.finish();
    });
    expect(capture.track.stop).toHaveBeenCalledOnce();
    act(() => {
      latest().onend?.();
    });
    expect(result.current.score?.matchedWords).toBe(3);
  });

  it("does not start recognition after microphone permission is denied", async () => {
    microphoneInput(
      vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")),
    );
    const { result } = mount();
    await act(async () => {
      expect(await result.current.arm()).toBe(false);
    });
    expect(result.current.status).toBe("unavailable");
    expect(result.current.error).toMatch(/quyền/);
    expect(latest().start).not.toHaveBeenCalled();
  });

  it("starts fallback timing at the native capture start, even when device acquisition is delayed", async () => {
    const verse = lyrics.lines[0];
    const song = {
      ...lyrics,
      lines: [
        verse,
        {
          ...verse,
          id: "other",
          text: "Mẹ về nhà",
          start_ms: 4000,
          end_ms: 7000,
        },
      ],
    };
    const { result } = mount(song);
    await act(async () => {
      const arming = result.current.arm();
      latest().onstart?.();
      expect(await arming).toBe(true);
      result.current.resume();
      mediaMs = 2500;
      latest().onresult?.(final(verse.text));
      mediaMs = 4200;
      latest().onstart?.();
      mediaMs = 6000;
      latest().onresult?.(final("Mẹ về nhà"));
    });
    expect(
      result.current.liveScore?.lineScores.map((line) => line.matchedWords),
    ).toEqual([0, 3]);
  });

  it("uses the native default recognizer when the optional track argument is ignored", async () => {
    const probe = microphoneStream();
    const getUserMedia = vi.fn().mockResolvedValue(probe.stream);
    microphoneInput(getUserMedia);
    vi.stubGlobal("SpeechRecognition", FakeRecognizer);
    const { result } = mount();
    let arming!: Promise<boolean>;
    await act(async () => {
      arming = result.current.arm();
    });
    expect(probe.track.stop).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("arming");
    act(() => {
      latest().onstart?.();
    });
    expect(await arming).toBe(true);
    act(() => result.current.resume());
    expect(latest().start).toHaveBeenCalledWith();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("never credits a word just before a seek, even inside recognition lag tolerance", async () => {
    const verse = lyrics.lines[0];
    const hook = mount({
      ...lyrics,
      lines: [
        verse,
        {
          ...verse,
          id: "later",
          text: "Mẹ về nhà",
          start_ms: 3000,
          end_ms: 6000,
        },
      ],
    });
    await startSinging(hook);
    act(() => {
      mediaMs = 3100;
      hook.result.current.seekBoundary();
      latest().onstart?.();
      mediaMs = 3350;
      latest().onresult?.(final("học"));
    });
    expect(hook.result.current.liveScore?.lineScores[0].evaluatedWords).toBe(0);
  });

  it.each(["pause", "finish", "reset", "unmount"] as const)(
    "releases a microphone delivered after %s and ignores its stale permission",
    async (boundary) => {
      const probe = microphoneStream();
      const late = microphoneStream();
      let deliver!: (stream: MediaStream) => void;
      const getUserMedia = vi
        .fn()
        .mockResolvedValueOnce(probe.stream)
        .mockReturnValueOnce(
          new Promise<MediaStream>((resolve) => {
            deliver = resolve;
          }),
        );
      microphoneInput(getUserMedia);
      const { result, unmount } = mount();
      await act(async () => {
        expect(await result.current.arm()).toBe(true);
      });
      act(() => result.current.resume());
      const capture = latest();
      if (boundary === "unmount") unmount();
      else
        act(() => {
          result.current[boundary]();
        });
      await act(async () => {
        deliver(late.stream);
      });
      expect(capture.start).not.toHaveBeenCalled();
      expect(late.track.stop).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reacquires after pause and reports loss of the active track", async () => {
    const [probe, first, second] = [
      microphoneStream(),
      microphoneStream(),
      microphoneStream(),
    ];
    microphoneInput(
      vi
        .fn()
        .mockResolvedValueOnce(probe.stream)
        .mockResolvedValueOnce(first.stream)
        .mockResolvedValueOnce(second.stream),
    );
    const { result } = mount();
    await act(async () => {
      expect(await result.current.arm()).toBe(true);
    });
    await act(async () => result.current.resume());
    act(() => {
      latest().onstart?.();
      result.current.pause();
    });
    expect(first.track.stop).toHaveBeenCalledOnce();
    await act(async () => result.current.resume());
    expect(latest().start).toHaveBeenCalledWith(second.track);
    act(() => {
      latest().onstart?.();
      second.track.onended?.();
    });
    expect(result.current.status).toBe("unavailable");
    expect(second.track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains the final slice once at song end and times out cleanly", async () => {
    const [probe, capture] = [microphoneStream(), microphoneStream()];
    microphoneInput(
      vi
        .fn()
        .mockResolvedValueOnce(probe.stream)
        .mockResolvedValueOnce(capture.stream),
    );
    const { result } = mount();
    await act(async () => {
      expect(await result.current.arm()).toBe(true);
    });
    await act(async () => result.current.resume());
    const finalCapture = latest();
    act(() => {
      finalCapture.onstart?.();
      mediaMs = 3000;
      vi.advanceTimersByTime(100);
      result.current.finish();
    });
    expect(finalCapture.stop).toHaveBeenCalledOnce();
    expect(capture.track.stop).toHaveBeenCalledOnce();
    act(() => {
      finalCapture.onresult?.(final(lyrics.lines[0].text));
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.status).toBe("scored");
    expect(result.current.score?.matchedWords).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
