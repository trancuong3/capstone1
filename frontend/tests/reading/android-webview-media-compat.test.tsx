import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PREFERRED_RECORDER_MIME_TYPES,
  useSpeechRecorder,
} from "@/hooks/use-speech-recorder";
import {
  installAndroidAudioUnlock,
  isAndroidAudioUnlocked,
  resetAndroidAudioUnlockForTest,
} from "@/lib/reading/android-audio-unlock";
import { TtsPlayback } from "@/lib/reading/tts-playback";

describe("Android WebView Audio, MediaRecorder & Speech Fallback Compatibility", () => {
  let previousMediaRecorder: PropertyDescriptor | undefined;
  let previousMediaDevices: PropertyDescriptor | undefined;
  let previousSpeechRecognition: PropertyDescriptor | undefined;
  let previousWebkitSpeechRecognition: PropertyDescriptor | undefined;

  beforeEach(() => {
    resetAndroidAudioUnlockForTest();
    previousMediaRecorder = Object.getOwnPropertyDescriptor(
      globalThis,
      "MediaRecorder",
    );
    previousMediaDevices = Object.getOwnPropertyDescriptor(
      navigator,
      "mediaDevices",
    );
    previousSpeechRecognition = Object.getOwnPropertyDescriptor(
      window,
      "SpeechRecognition",
    );
    previousWebkitSpeechRecognition = Object.getOwnPropertyDescriptor(
      window,
      "webkitSpeechRecognition",
    );
  });

  afterEach(() => {
    resetAndroidAudioUnlockForTest();
    if (previousMediaRecorder) {
      Object.defineProperty(globalThis, "MediaRecorder", previousMediaRecorder);
    } else {
      Reflect.deleteProperty(globalThis, "MediaRecorder");
    }
    if (previousMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", previousMediaDevices);
    } else {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
    if (previousSpeechRecognition) {
      Object.defineProperty(
        window,
        "SpeechRecognition",
        previousSpeechRecognition,
      );
    } else {
      Reflect.deleteProperty(window, "SpeechRecognition");
    }
    if (previousWebkitSpeechRecognition) {
      Object.defineProperty(
        window,
        "webkitSpeechRecognition",
        previousWebkitSpeechRecognition,
      );
    } else {
      Reflect.deleteProperty(window, "webkitSpeechRecognition");
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("unlocks WebAudio & HTMLAudio on first touchstart/pointerdown gesture for Android WebView TTS", () => {
    const resumeMock = vi.fn(async function (this: { state: string }) {
      this.state = "running";
    });
    const closeMock = vi.fn(async () => undefined);
    class FakeAudioContext {
      state = "suspended";
      resume = resumeMock;
      close = closeMock;
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    installAndroidAudioUnlock();
    expect(isAndroidAudioUnlocked()).toBe(false);

    document.dispatchEvent(new Event("touchstart"));
    expect(isAndroidAudioUnlocked()).toBe(true);
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);

    // Idempotent: subsequent touches do not re-create AudioContext or re-fire probe audio
    document.dispatchEvent(new Event("pointerdown"));
    expect(resumeMock).toHaveBeenCalledTimes(1);
  });

  it("plays server-synthesized Vietnamese TTS cleanly when TtsPlayback is constructed in WebView", async () => {
    const fakeBlob = new Blob(["fake-mp3-bytes"], { type: "audio/mpeg" });
    const synthesize = vi.fn(async () => fakeBlob);
    const synthesizeTimed = vi.fn();

    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:viread-tts-1");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    class FakeAudioElement {
      src: string;
      defaultPlaybackRate = 1;
      playbackRate = 1;
      preservesPitch = true;
      volume = 1;
      duration = 1.2;
      currentTime = 0;
      paused = false;
      ended = false;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeupdate: (() => void) | null = null;
      onloadedmetadata: (() => void) | null = null;
      constructor(url = "") {
        this.src = url;
      }
      async play() {
        queueMicrotask(() => {
          this.ended = true;
          this.onended?.();
        });
      }
      pause() {
        this.paused = true;
      }
    }
    vi.stubGlobal("Audio", FakeAudioElement);

    const player = new TtsPlayback(
      { synthesize } as never,
      {
        synthesizeTimed,
      } as never,
    );
    await player.play("Xin chào bé yêu");
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(player.getState()).toBe("completed");
    player.dispose();
  });

  it("handles OEM Android WebView MediaRecorder codec fallback and releases mic on viread:android-background", async () => {
    // Ensure SpeechRecognition is completely absent as in Android System WebView
    Reflect.deleteProperty(window, "SpeechRecognition");
    Reflect.deleteProperty(window, "webkitSpeechRecognition");
    expect(
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition,
    ).toBeUndefined();
    expect(PREFERRED_RECORDER_MIME_TYPES).toContain(
      "audio/mp4;codecs=mp4a.40.2",
    );

    const stopTrack = vi.fn();
    const track = {
      readyState: "live",
      stop: stopTrack,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaStreamTrack;
    const stream = {
      getTracks: () => [track],
    } as unknown as MediaStream;

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => stream),
      },
    });

    // Simulate quirky OEM WebView: reports audio/webm;codecs=opus supported, throws in constructor
    // when options are passed, and succeeds when constructed without options (platform default audio/mp4)
    class QuirkyOemMediaRecorder {
      static isTypeSupported = vi.fn(
        (mime: string) => mime === "audio/webm;codecs=opus",
      );
      state: RecordingState = "inactive";
      mimeType = "audio/mp4";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(
        readonly mediaStream: MediaStream,
        options?: MediaRecorderOptions,
      ) {
        if (options?.mimeType) {
          throw new DOMException(
            "Codec initialization failed on OEM WebView",
            "NotSupportedError",
          );
        }
      }

      start(): void {
        this.state = "recording";
      }

      stop(): void {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["recorded-aac"], { type: "audio/mp4" }),
        } as BlobEvent);
        this.onstop?.();
      }
    }

    vi.stubGlobal("MediaRecorder", QuirkyOemMediaRecorder);

    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.isRecording).toBe(true);

    let recorded: Blob | null = null;
    await act(async () => {
      recorded = await result.current.stop();
    });
    expect(recorded).not.toBeNull();
    expect(recorded!.type).toBe("audio/mp4");

    // Start again and verify Android background event immediately stops active microphone tracks
    stopTrack.mockClear();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.isRecording).toBe(true);

    act(() => {
      document.dispatchEvent(new Event("viread:android-background"));
    });
    expect(result.current.isRecording).toBe(false);
    expect(stopTrack).toHaveBeenCalled();
  });
});
