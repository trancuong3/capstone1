import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpeechRecorder } from "@/hooks/use-speech-recorder";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn<(type: string) => boolean>(() => false);
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["spoken audio"]) } as BlobEvent);
    this.onstop?.();
  }
}

let previousMediaRecorder: PropertyDescriptor | undefined;
let previousMediaDevices: PropertyDescriptor | undefined;
let microphoneStream: MediaStream;
const stopTrack = vi.fn<() => void>();
const getUserMedia = vi.fn();

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.isTypeSupported.mockReset().mockReturnValue(false);
  previousMediaRecorder = Object.getOwnPropertyDescriptor(
    globalThis,
    "MediaRecorder",
  );
  previousMediaDevices = Object.getOwnPropertyDescriptor(
    navigator,
    "mediaDevices",
  );
  stopTrack.mockReset();
  const track = {
    readyState: "live",
    stop: () => {
      stopTrack();
    },
  } as unknown as MediaStreamTrack;
  microphoneStream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  getUserMedia.mockReset().mockResolvedValue(microphoneStream);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
});

afterEach(() => {
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSpeechRecorder", () => {
  it.each(["audio/webm;codecs=opus", "audio/mp4"])(
    "selects supported MIME %s",
    async (mime) => {
      FakeMediaRecorder.isTypeSupported.mockImplementation(
        (type) => type === mime,
      );
      const { result } = renderHook(() => useSpeechRecorder());
      await act(async () => result.current.start());
      expect(FakeMediaRecorder.instances[0].mimeType).toBe(mime);
      await act(async () =>
        expect((await result.current.stop())?.type).toBe(mime),
      );
    },
  );

  it("bounds a missing onstop callback and releases the stream", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => result.current.start());
    vi.spyOn(FakeMediaRecorder.instances[0], "stop").mockImplementation(() => {
      FakeMediaRecorder.instances[0].state = "inactive";
    });
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.stop().catch((error: unknown) => error);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3001);
    });
    expect(await outcome).toMatchObject({
      message: "Microphone stop timed out.",
    });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("caps long capture without uploading truncated audio as valid evidence", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => result.current.start());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300001);
    });
    await expect(result.current.stop()).rejects.toThrow("duration limit");
    expect(result.current.getQuality?.().status).toBe("INVALID_AUDIO");
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("requests permission before capture and retains the prepared stream for retry audio", async () => {
    const { result, unmount } = renderHook(() => useSpeechRecorder());

    await act(async () => {
      await result.current.prepare();
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    await act(async () => {
      await result.current.start({ retainStream: true });
    });
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(getUserMedia).toHaveBeenCalledOnce();

    let recording!: Blob | null;
    await act(async () => {
      recording = await result.current.stop();
    });
    expect(recording?.size).toBeGreaterThan(0);
    expect(stopTrack).not.toHaveBeenCalled();

    unmount();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("stops an active recording track when the hook unmounts", async () => {
    const { result, unmount } = renderHook(() => useSpeechRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(FakeMediaRecorder.instances[0].state).toBe("recording");

    unmount();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("cannot start capture after stop while microphone permission is pending", async () => {
    let grantPermission: (stream: MediaStream) => void = () => undefined;
    getUserMedia.mockReturnValueOnce(
      new Promise<MediaStream>((resolve) => {
        grantPermission = resolve;
      }),
    );
    const { result } = renderHook(() => useSpeechRecorder());
    let startOutcome: Promise<unknown> = Promise.resolve();
    act(() => {
      startOutcome = result.current.start().catch((error: unknown) => error);
    });
    await act(async () => {
      expect(await result.current.stop()).toBeNull();
      grantPermission(microphoneStream);
      await startOutcome;
    });
    expect(await startOutcome).toMatchObject({ name: "AbortError" });
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(result.current.isRecording).toBe(false);
  });

  it("releases tracks even if cancelling the recorder throws", async () => {
    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => result.current.start());
    vi.spyOn(FakeMediaRecorder.instances[0], "stop").mockImplementationOnce(
      () => {
        throw new Error("Recorder already stopped");
      },
    );
    act(() => result.current.cancel());
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(result.current.getStream()).toBeNull();
    expect(result.current.isRecording).toBe(false);
  });

  it("settles both callers when stop is requested before the final chunk arrives", async () => {
    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => result.current.start());
    const recorder = FakeMediaRecorder.instances[0];
    const stop = vi.spyOn(recorder, "stop").mockImplementation(() => {
      recorder.state = "inactive";
    });
    let firstSettled = false;
    let secondSettled = false;
    const recordings: Array<Blob | null> = [];
    await act(async () => {
      void result.current.stop().then((blob) => {
        firstSettled = true;
        recordings.push(blob);
      });
      void result.current.stop().then((blob) => {
        secondSettled = true;
        recordings.push(blob);
      });
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      recorder.ondataavailable?.({
        data: new Blob(["final audio"]),
      } as BlobEvent);
      recorder.onstop?.();
    });
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(recordings).toHaveLength(2);
    expect(recordings.every((blob) => blob !== null && blob.size > 0)).toBe(
      true,
    );
    expect(recordings[0]).toBe(recordings[1]);
    expect(stop).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("shares concurrent prepare and start requests", async () => {
    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => {
      await Promise.all([result.current.prepare(), result.current.prepare()]);
    });
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(async () => {
      await Promise.all([result.current.start(), result.current.start()]);
    });
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    act(() => result.current.cancel());
  });

  it("uses supported processing constraints and reports actual track settings", async () => {
    const getSupportedConstraints = vi.fn(() => ({
      echoCancellation: true,
      noiseSuppression: true,
    }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, getSupportedConstraints },
    });
    const settings = { sampleRate: 48000, echoCancellation: true };
    microphoneStream.getTracks()[0].getSettings = () => settings;
    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => result.current.prepare());
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    expect(result.current.getSettings?.()).toEqual(settings);
    act(() => result.current.cancel());
  });

  it("retries unsupported constraints once with unconstrained audio", async () => {
    getUserMedia.mockRejectedValueOnce(
      new DOMException("Unsupported", "OverconstrainedError"),
    );
    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => result.current.prepare());
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true });
    act(() => result.current.cancel());
  });

  it("releases late permission after unmount", async () => {
    let grant: (stream: MediaStream) => void = () => undefined;
    getUserMedia.mockReturnValueOnce(
      new Promise<MediaStream>((resolve) => {
        grant = resolve;
      }),
    );
    const { result, unmount } = renderHook(() => useSpeechRecorder());
    const pending = result.current.prepare().catch((error: unknown) => error);
    unmount();
    grant(microphoneStream);
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("preserves a recorder failure for stop instead of returning a valid blob", async () => {
    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => result.current.start());
    act(() => FakeMediaRecorder.instances[0].onerror?.());
    await expect(result.current.stop()).rejects.toThrow(
      "Microphone recording failed",
    );
    expect(result.current.getQuality?.().status).toBe("INVALID_AUDIO");
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("handles track disconnection without retaining the microphone", async () => {
    const track = microphoneStream.getTracks()[0];
    const target = new EventTarget();
    track.addEventListener = target.addEventListener.bind(target);
    track.removeEventListener = target.removeEventListener.bind(target);
    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => result.current.start({ retainStream: true }));
    act(() => {
      target.dispatchEvent(new Event("ended"));
    });
    await expect(result.current.stop()).rejects.toThrow("disconnected");
    expect(result.current.getStream()).toBeNull();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("notifies the latest consumer once on a live capture failure and can record again", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { result, rerender } = renderHook(
      ({ onError }) => useSpeechRecorder(onError),
      { initialProps: { onError: first } },
    );
    await act(async () => result.current.start());
    const failed = FakeMediaRecorder.instances[0];
    const lateError = failed.onerror;
    rerender({ onError: latest });
    act(() => lateError?.());
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(result.current.isRecording).toBe(false);
    act(() => lateError?.());
    expect(latest).toHaveBeenCalledOnce();
    await expect(result.current.stop()).rejects.toThrow("recording failed");
    await act(async () => result.current.start());
    expect(result.current.isRecording).toBe(true);
    expect(result.current.getQuality?.().status).not.toBe("INVALID_AUDIO");
    act(() => result.current.cancel());
    expect(latest).toHaveBeenCalledOnce();
  });

  it("returns null when the recorder emits no chunks", async () => {
    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => result.current.start());
    const recorder = FakeMediaRecorder.instances[0];
    vi.spyOn(recorder, "stop").mockImplementation(() => {
      recorder.state = "inactive";
      recorder.onstop?.();
    });
    await act(async () => expect(await result.current.stop()).toBeNull());
  });

  it("does not hide denied microphone permission", async () => {
    const denied = new DOMException("Permission denied", "NotAllowedError");
    getUserMedia.mockRejectedValueOnce(denied);
    const { result } = renderHook(() => useSpeechRecorder());

    await expect(result.current.prepare()).rejects.toBe(denied);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });
});
