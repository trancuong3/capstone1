import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpeechPlayer } from "@/hooks/use-speech-player";
import {
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import { resetVoiceEngineStatus } from "@/lib/reading/voice-engine-status";

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

class FakeSpeechSynthesisUtterance {
  lang = "";
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: ((event: SpeechSynthesisEvent) => void) | null = null;
  onboundary: ((event: SpeechSynthesisEvent) => void) | null = null;
  onend: ((event: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

  constructor(readonly text: string) {}
}

let previousAudio: PropertyDescriptor | undefined;
let previousCreateObjectURL: PropertyDescriptor | undefined;
let previousRevokeObjectURL: PropertyDescriptor | undefined;
let previousSpeechSynthesis: PropertyDescriptor | undefined;
let previousSpeechSynthesisUtterance: PropertyDescriptor | undefined;
const createObjectURL = vi.fn(() => "blob:reading-audio");
const revokeObjectURL = vi.fn();
const speechSynthesisMock = {
  getVoices: vi.fn(() => [{ lang: "vi-VN" } as SpeechSynthesisVoice]),
  speak: vi.fn(),
  cancel: vi.fn(),
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetVoiceLockAndPolicyForTests();
  resetVoiceEngineStatus();
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
  previousSpeechSynthesis = Object.getOwnPropertyDescriptor(
    window,
    "speechSynthesis",
  );
  previousSpeechSynthesisUtterance = Object.getOwnPropertyDescriptor(
    globalThis,
    "SpeechSynthesisUtterance",
  );
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeSpeechSynthesisUtterance);
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: speechSynthesisMock,
  });
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
  speechSynthesisMock.getVoices.mockClear();
  speechSynthesisMock.speak.mockReset();
  speechSynthesisMock.cancel.mockReset();
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
  if (previousSpeechSynthesis) {
    Object.defineProperty(window, "speechSynthesis", previousSpeechSynthesis);
  } else {
    Reflect.deleteProperty(window, "speechSynthesis");
  }
  if (previousSpeechSynthesisUtterance) {
    Object.defineProperty(
      globalThis,
      "SpeechSynthesisUtterance",
      previousSpeechSynthesisUtterance,
    );
  } else {
    Reflect.deleteProperty(globalThis, "SpeechSynthesisUtterance");
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

  it("rejects decode and play failures without switching to OS speechSynthesis", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    let playback!: Promise<void>;

    act(() => {
      playback = result.current.play("khỏe");
    });
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    act(() => FakeAudio.instances[0].fail());
    await expect(playback).rejects.toThrow(
      /Giọng đọc trên máy hiện chưa sẵn sàng/,
    );
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();

    FakeAudio.instances = [];
    const playFailure = new Error("Autoplay was denied");
    FakeAudio.rejectNextPlay = playFailure;
    act(() => {
      playback = result.current.play("mèo");
    });
    await expect(playback).rejects.toThrow("Autoplay was denied");
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();
  });

  it("never falls back to OS speechSynthesis in local_only mode when server TTS is unavailable and surfaces fallbackNotice", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: false,
    });
    speechServiceMock.synthesize.mockRejectedValueOnce(
      new Error("503 LOCAL_TTS_UNAVAILABLE"),
    );
    const { result } = renderHook(() => useSpeechPlayer());
    let caught: Error | null = null;

    await act(async () => {
      try {
        await result.current.play("Bé đọc chữ khỏe nhé.");
      } catch (err) {
        caught = err as Error;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();
    expect(result.current.fallbackNotice).toMatch(
      /Giọng đọc đã khóa đang tạm bận/,
    );
    expect(result.current.isPlaying).toBe(false);
  });

  it("retries server TTS on the next play call in local_only mode instead of locking onto OS voice", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: false,
    });
    speechServiceMock.synthesize
      .mockRejectedValueOnce(new Error("502 TTS unavailable"))
      .mockResolvedValueOnce(
        new Blob(["encoded audio"], { type: "audio/wav" }),
      );
    const { result } = renderHook(() => useSpeechPlayer());

    await act(async () => {
      await expect(result.current.play("mèo")).rejects.toThrow();
    });
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();

    let second!: Promise<void>;
    act(() => {
      second = result.current.play("khỏe");
    });
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    await act(async () => {
      FakeAudio.instances[0].finish();
      await second;
    });

    expect(speechServiceMock.synthesize).toHaveBeenCalledTimes(2);
    expect(result.current.fallbackNotice).toBeNull();
  });

  it("aborts in-flight synthesis or playback cleanly when stopped", async () => {
    let resolveSynth!: (blob: Blob) => void;
    speechServiceMock.synthesize.mockReturnValueOnce(
      new Promise<Blob>((resolve) => {
        resolveSynth = resolve;
      }),
    );
    const { result } = renderHook(() => useSpeechPlayer());
    let playback!: Promise<unknown>;
    act(() => {
      playback = result.current.play("khỏe").catch((error: Error) => error);
    });
    act(() => result.current.stop());
    resolveSynth(new Blob(["encoded audio"], { type: "audio/wav" }));

    expect(await playback).toMatchObject({ name: "AbortError" });
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(false);
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
