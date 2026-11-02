import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useSpeechRecorder } from "@/hooks/use-speech-recorder";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useSpeechRecorder pending microphone cleanup", () => {
  it("stops a stream when getUserMedia resolves after the component unmounts", async () => {
    const permission = deferred<MediaStream>();
    const stopTrack = vi.fn();
    const stream = {
      active: true,
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => permission.promise);
    const originalMediaDevices = Object.getOwnPropertyDescriptor(
      navigator,
      "mediaDevices",
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const recorderConstructor = vi.fn();
    class MockMediaRecorder {
      static isTypeSupported = vi.fn(() => false);
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(_stream: MediaStream) {
        recorderConstructor();
      }

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        this.onstop?.(new Event("stop"));
      }
    }
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);

    const view = renderHook(() => useSpeechRecorder());
    let startPromise!: Promise<void>;
    act(() => {
      startPromise = view.result.current.start();
    });

    expect(getUserMedia).toHaveBeenCalledOnce();
    view.unmount();

    await act(async () => {
      permission.resolve(stream);
      await expect(startPromise).rejects.toThrow(
        "Microphone capture was cancelled.",
      );
    });

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(recorderConstructor).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });
});
