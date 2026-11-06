import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpeechRecorder } from "@/hooks/use-speech-recorder";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => false);
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly stream: MediaStream) {
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
});

describe("useSpeechRecorder", () => {
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

  it("does not hide denied microphone permission", async () => {
    const denied = new DOMException("Permission denied", "NotAllowedError");
    getUserMedia.mockRejectedValueOnce(denied);
    const { result } = renderHook(() => useSpeechRecorder());

    await expect(result.current.prepare()).rejects.toBe(denied);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });
});
