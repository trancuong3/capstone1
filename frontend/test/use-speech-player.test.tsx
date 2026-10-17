// Verify tutor audio can be canceled without sending speech to a live provider.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpeechPlayer } from "@/hooks/use-speech-player";
import type { SpeechService } from "@/lib/api/speech-service";

const { synthesize } = vi.hoisted(() => ({
  synthesize: vi.fn<SpeechService["synthesize"]>(),
}));
vi.mock("@/lib/api/speech-service", () => ({
  createSpeechService: () => ({ synthesize }),
}));
const play = vi.fn<() => Promise<void>>();
const pause = vi.fn();
const createObjectURL = vi.fn(() => "blob:test-audio");
const revokeObjectURL = vi.fn();
const audio = vi.fn(function () {
  return { play, pause, src: "", onended: null, onerror: null };
});

beforeEach(() => {
  synthesize.mockReset();
  play.mockReset().mockResolvedValue();
  pause.mockReset();
  audio.mockClear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal("Audio", audio);
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
});
afterEach(() => vi.unstubAllGlobals());

describe("Speech player cancellation", () => {
  it("does not start late audio after the tutor closes", async () => {
    let settle: (blob: Blob) => void = () => undefined;
    synthesize.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { result } = renderHook(() => useSpeechPlayer());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.play("Lời giải thích");
    });
    const signal = synthesize.mock.calls[0][1]?.signal;
    act(() => result.current.stop());
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      settle(new Blob(["audio"]));
      await pending;
    });
    expect(audio).not.toHaveBeenCalled();
  });

  it("aborts a pending audio request on unmount", async () => {
    let settle: (blob: Blob) => void = () => undefined;
    synthesize.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { result, unmount } = renderHook(() => useSpeechPlayer());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.play("Lời giải thích");
    });
    const signal = synthesize.mock.calls[0][1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      settle(new Blob(["audio"]));
      await pending;
    });
    expect(audio).not.toHaveBeenCalled();
  });

  it("stops active playback and releases its temporary URL", async () => {
    synthesize.mockResolvedValueOnce(new Blob(["audio"]));
    const { result } = renderHook(() => useSpeechPlayer());
    await act(async () => result.current.play("Lời giải thích"));
    expect(result.current.isPlaying).toBe(true);
    act(() => result.current.stop());
    expect(pause).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-audio");
    expect(result.current.isPlaying).toBe(false);
  });
});
