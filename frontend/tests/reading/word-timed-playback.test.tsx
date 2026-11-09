import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpeechPlayer } from "@/hooks/use-speech-player";
import {
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";

const { speechServiceMock, voiceStudioMock } = vi.hoisted(() => ({
  speechServiceMock: { synthesize: vi.fn(), transcribe: vi.fn() },
  voiceStudioMock: { synthesizeTimed: vi.fn(), listVoices: vi.fn() },
}));

vi.mock("@/lib/api/speech-service", () => ({
  createSpeechService: () => speechServiceMock,
}));
vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => voiceStudioMock,
}));

class FakeAudio {
  static instances: FakeAudio[] = [];
  currentTime = 0;
  paused = true;
  ended = false;
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn<() => Promise<void>>().mockImplementation(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  finish(): void {
    this.ended = true;
    this.paused = true;
    this.onended?.();
  }
}

const WORDS = ["Bé", "Na", "có", "mèo."];
const TIMED = {
  audio: new Blob(["mp3"], { type: "audio/mpeg" }),
  durationSeconds: 2,
  words: [
    { index: 0, start: 0.0, end: 0.4 },
    { index: 1, start: 0.5, end: 0.9 },
    { index: 2, start: 1.0, end: 1.4 },
    { index: 3, start: 1.5, end: 2.0 },
  ],
};

let frames: FrameRequestCallback[] = [];
function runFrame(): void {
  const pending = frames;
  frames = [];
  pending.forEach((callback) => callback(0));
}

beforeEach(() => {
  FakeAudio.instances = [];
  frames = [];
  window.localStorage.clear();
  resetSpeechPreferencesCache();
  voiceStudioMock.synthesizeTimed.mockReset().mockResolvedValue(TIMED);
  speechServiceMock.synthesize.mockReset();
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:timed"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => vi.unstubAllGlobals());

async function startPlayback(
  fallback = vi.fn().mockResolvedValue(undefined),
  onWordChange = vi.fn(),
) {
  const { result } = renderHook(() => useSpeechPlayer());
  const onPlay = vi.fn();
  const onEnded = vi.fn();
  let promise!: Promise<void>;
  await act(async () => {
    promise = result.current.playWithWordTimings(
      WORDS,
      { onPlay, onWordChange, onEnded },
      fallback,
    );
    await waitFor(() => expect(onPlay).toHaveBeenCalled());
  });
  return { result, promise, fallback, onWordChange, onEnded };
}

describe("word-timed sample playback", () => {
  it("moves the highlight from the audio clock, one word at a time", async () => {
    const { promise, onWordChange, onEnded, fallback } = await startPlayback();
    const audio = FakeAudio.instances[0];

    act(() => runFrame());
    expect(onWordChange).toHaveBeenLastCalledWith(0);

    audio.currentTime = 0.62; // inside "Na"
    act(() => runFrame());
    expect(onWordChange).toHaveBeenLastCalledWith(1);

    // A frame without a new word does not repeat the callback.
    const calls = onWordChange.mock.calls.length;
    audio.currentTime = 0.7;
    act(() => runFrame());
    expect(onWordChange).toHaveBeenCalledTimes(calls);

    // The lead makes the mark change just before the exact start (1.0 s).
    audio.currentTime = 0.97;
    act(() => runFrame());
    expect(onWordChange).toHaveBeenLastCalledWith(2);

    audio.currentTime = 1.7;
    act(() => runFrame());
    expect(onWordChange).toHaveBeenLastCalledWith(3);

    act(() => audio.finish());
    await promise;
    expect(onEnded).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(onWordChange.mock.calls.map(([index]) => index)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("asks for the chosen voice and speed", async () => {
    setSpeechPreferences({ voiceId: "voice_9", speed: 0.8 });
    const { promise } = await startPlayback();
    expect(voiceStudioMock.synthesizeTimed).toHaveBeenCalledWith(WORDS, {
      voiceId: "voice_9",
      speed: 0.8,
    });
    act(() => FakeAudio.instances[0].finish());
    await promise;
  });

  it("reuses the synthesized page when it is played again", async () => {
    const first = await startPlayback();
    act(() => FakeAudio.instances[0].finish());
    await first.promise;

    const onPlay = vi.fn();
    let second!: Promise<void>;
    await act(async () => {
      second = first.result.current.playWithWordTimings(
        WORDS,
        { onPlay },
        vi.fn().mockResolvedValue(undefined),
      );
      await waitFor(() => expect(onPlay).toHaveBeenCalled());
    });
    expect(voiceStudioMock.synthesizeTimed).toHaveBeenCalledTimes(1);
    expect(FakeAudio.instances).toHaveLength(2);

    act(() => FakeAudio.instances[1].finish());
    await second;
  });

  it("falls back to the estimated highlight when timings are unavailable", async () => {
    voiceStudioMock.synthesizeTimed.mockRejectedValue(new Error("no timings"));
    const fallback = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useSpeechPlayer());

    await act(async () => {
      await result.current.playWithWordTimings(WORDS, {}, fallback);
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(FakeAudio.instances).toHaveLength(0);

    // The failed service is not hammered again right away.
    await act(async () => {
      await result.current.playWithWordTimings(WORDS, {}, fallback);
    });
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(voiceStudioMock.synthesizeTimed).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when playback is stopped while synthesizing", async () => {
    let resolveSpeech!: (value: typeof TIMED) => void;
    voiceStudioMock.synthesizeTimed.mockReturnValue(
      new Promise((resolve) => {
        resolveSpeech = resolve;
      }),
    );
    const fallback = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useSpeechPlayer());

    let outcome: unknown;
    await act(async () => {
      const promise = result.current
        .playWithWordTimings(WORDS, {}, fallback)
        .catch((error: unknown) => {
          outcome = error;
        });
      result.current.stop();
      resolveSpeech(TIMED);
      await promise;
    });

    expect((outcome as Error).name).toBe("AbortError");
    expect(fallback).not.toHaveBeenCalled();
    expect(FakeAudio.instances).toHaveLength(0);
  });
});
