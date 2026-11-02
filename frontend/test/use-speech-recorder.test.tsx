import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpeechRecorder } from "@/hooks/use-speech-recorder";

const tracks = [{ stop: vi.fn() }];
const stream = {
  active: true,
  getTracks: () => tracks,
} as unknown as MediaStream;

class FakeAnalyser {
  fftSize = 256;
  smoothingTimeConstant = 0.5;
  frequencyBinCount = 128;
  speaking = true;

  getByteFrequencyData(target: Uint8Array) {
    target.fill(this.speaking ? 20 : 0);
  }

  getByteTimeDomainData(target: Uint8Array) {
    target.fill(this.speaking ? 180 : 128);
  }
}

class FakeAudioContext {
  state = "running";
  analyser = new FakeAnalyser();
  createMediaStreamSource = () =>
    ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    }) as unknown as MediaStreamAudioSourceNode;
  createAnalyser = () => this.analyser as unknown as AnalyserNode;
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn((mimeType: string) =>
    mimeType === "audio/webm;codecs=opus",
  );

  readonly mimeType: string;
  readonly stream: MediaStream;
  readonly segmentBytes: Uint8Array;
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([this.segmentBytes], { type: this.mimeType }),
    } as BlobEvent);
    this.onstop?.(new Event("stop"));
  });

  constructor(streamArg: MediaStream, options?: MediaRecorderOptions) {
    this.stream = streamArg;
    this.mimeType = options?.mimeType ?? "audio/webm;codecs=opus";
    this.segmentBytes = new Uint8Array(1_024).fill(
      FakeMediaRecorder.instances.length + 1,
    );
    FakeMediaRecorder.instances.push(this);
  }
}

let frameId = 0;
let frames = new Map<number, FrameRequestCallback>();
let audioContext: FakeAudioContext | null = null;
const getUserMedia = vi.fn(async () => stream);

function flushFrame() {
  const first = frames.entries().next().value as
    | [number, FrameRequestCallback]
    | undefined;
  if (!first) throw new Error("No animation frame was scheduled.");
  const [id, callback] = first;
  frames.delete(id);
  act(() => callback(0));
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.isTypeSupported.mockClear();
  tracks[0].stop.mockClear();
  getUserMedia.mockReset().mockResolvedValue(stream);
  frameId = 0;
  frames = new Map();
  audioContext = null;

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("AudioContext", class extends FakeAudioContext {
    constructor() {
      super();
      audioContext = this;
    }
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSpeechRecorder", () => {
  it("finalizes each VAD utterance independently and preserves submission order", async () => {
    const onUtterance = vi.fn();
    const { result } = renderHook(() => useSpeechRecorder());

    await act(async () => {
      await result.current.start(onUtterance);
    });

    expect(result.current.isRecording).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0]?.start).toHaveBeenCalledWith();

    // Capture speech, then 30 animation frames of silence to rotate the recorder.
    flushFrame();
    expect(audioContext).not.toBeNull();
    audioContext!.analyser.speaking = false;
    for (let index = 0; index < 30; index += 1) flushFrame();

    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(onUtterance).toHaveBeenCalledTimes(1);

    // Capture speech in the second recorder and stop the microphone.
    audioContext!.analyser.speaking = true;
    flushFrame();

    let finalRecording: Blob | null = null;
    await act(async () => {
      finalRecording = await result.current.stop();
    });

    expect(onUtterance).toHaveBeenCalledTimes(2);
    const [firstBlob, , firstId] = onUtterance.mock.calls[0] as [
      Blob,
      number,
      string,
    ];
    const [secondBlob, , secondId] = onUtterance.mock.calls[1] as [
      Blob,
      number,
      string,
    ];

    expect(firstBlob).toBeInstanceOf(Blob);
    expect(secondBlob).toBeInstanceOf(Blob);
    expect(firstBlob.type).toBe("audio/webm;codecs=opus");
    expect(secondBlob.type).toBe("audio/webm;codecs=opus");
    expect(firstBlob.size).toBe(1_024);
    expect(secondBlob.size).toBe(1_024);
    expect(firstId).not.toBe(secondId);

    // stop() returns only the last complete recorder segment. It must not
    // concatenate independent WebM containers into one invalid recording.
    expect(finalRecording).toBeInstanceOf(Blob);
    expect(finalRecording?.size).toBe(1_024);
    expect(result.current.isRecording).toBe(false);
    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels capture without submitting a partial segment", async () => {
    const onUtterance = vi.fn();
    const { result, unmount } = renderHook(() => useSpeechRecorder());

    await act(async () => {
      await result.current.start(onUtterance);
    });

    act(() => result.current.cancel());

    expect(onUtterance).not.toHaveBeenCalled();
    expect(result.current.isRecording).toBe(false);
    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1);
    unmount();
  });
});
