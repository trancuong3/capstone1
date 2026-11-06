import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpeechPlayer } from "@/hooks/use-speech-player";

const { speechServiceMock } = vi.hoisted(() => ({
  speechServiceMock: {
    synthesize: vi.fn(),
    transcribe: vi.fn(),
  },
}));

vi.mock("@/lib/api/speech-service", () => ({
  createSpeechService: () => speechServiceMock,
}));

class FakeAudio {
  static instances: FakeAudio[] = [];
  static rejectNextPlay: Error | null = null;
  currentTime = 0;
  duration = 1;
  paused = true;
  ended = false;
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play = vi.fn<() => Promise<void>>().mockImplementation(async () => {
    const rejection = FakeAudio.rejectNextPlay;
    FakeAudio.rejectNextPlay = null;
    if (rejection) throw rejection;
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

  fail(): void {
    this.onerror?.();
  }
}

let previousAudio: PropertyDescriptor | undefined;
let previousCreateObjectURL: PropertyDescriptor | undefined;
let previousRevokeObjectURL: PropertyDescriptor | undefined;
const createObjectURL = vi.fn(() => "blob:reading-audio");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  FakeAudio.instances = [];
  FakeAudio.rejectNextPlay = null;
  speechServiceMock.synthesize
    .mockReset()
    .mockResolvedValue(new Blob(["encoded audio"], { type: "audio/mpeg" }));
  previousAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  previousCreateObjectURL = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  previousRevokeObjectURL = Object.getOwnPropertyDescriptor(
    URL,
    "revokeObjectURL",
  );
  vi.stubGlobal("Audio", FakeAudio);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

afterEach(() => {
  if (previousAudio) Object.defineProperty(globalThis, "Audio", previousAudio);
  else Reflect.deleteProperty(globalThis, "Audio");
  if (previousCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", previousCreateObjectURL);
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (previousRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", previousRevokeObjectURL);
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
  vi.unstubAllGlobals();
});

describe("useSpeechPlayer", () => {
  it("waits for playback to end and releases the temporary audio URL", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    let resolved = false;
    let playback!: Promise<void>;

    act(() => {
      playback = result.current.play("Bé hãy đọc từ khỏe nhé.").then(() => {
        resolved = true;
      });
    });
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    await Promise.resolve();
    expect(result.current.isPlaying).toBe(true);
    expect(resolved).toBe(false);

    await act(async () => {
      FakeAudio.instances[0].finish();
      await playback;
    });

    expect(resolved).toBe(true);
    expect(result.current.isPlaying).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:reading-audio");
  });

  it("rejects decode and play failures instead of reporting successful playback", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    let playback!: Promise<void>;

    act(() => {
      playback = result.current.play("khỏe");
    });
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    act(() => FakeAudio.instances[0].fail());
    await expect(playback).rejects.toThrow("Không thể phát âm thanh");
    expect(revokeObjectURL).toHaveBeenCalledOnce();

    FakeAudio.instances = [];
    const playFailure = new Error("Autoplay was denied");
    FakeAudio.rejectNextPlay = playFailure;
    act(() => {
      playback = result.current.play("mèo");
    });
    await expect(playback).rejects.toThrow("Autoplay was denied");
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("stops a previous word before the next word starts", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    const first = result.current.play("mèo").catch((error: Error) => error);
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));

    let second!: Promise<void>;
    act(() => {
      second = result.current.play("khỏe");
    });
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(2));

    expect(await first).toMatchObject({ name: "AbortError" });
    expect(FakeAudio.instances[0].pause).toHaveBeenCalledOnce();
    expect(FakeAudio.instances[1].paused).toBe(false);
    await act(async () => {
      FakeAudio.instances[1].finish();
      await second;
    });
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
