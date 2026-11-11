import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import type { TimedSpeech } from "@/lib/api/voice-studio-service";
import {
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";

const { speech, studio } = vi.hoisted(() => ({
  speech: { synthesize: vi.fn(), transcribe: vi.fn() },
  studio: { synthesizeTimed: vi.fn(), listVoices: vi.fn() },
}));
vi.mock("@/lib/api/speech-service", () => ({
  createSpeechService: () => speech,
}));
vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => studio,
}));

class AudioFixture {
  static instances: AudioFixture[] = [];
  static nextDuration = 2;
  duration = AudioFixture.nextDuration;
  currentTime = 0;
  paused = true;
  ended = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  constructor(public src: string) {
    AudioFixture.instances.push(this);
  }
  finish() {
    this.ended = true;
    this.paused = true;
    this.onended?.();
  }
}
class UtteranceFixture {
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
function timed(words: readonly string[]): TimedSpeech {
  const duration = Math.max(2, words.length * 0.4);
  AudioFixture.nextDuration = duration;
  return {
    audio: new Blob(["mp3-fixture"], { type: "audio/mpeg" }),
    durationSeconds: duration,
    words: words.map((_word, index) => ({
      index,
      start: (index * duration) / words.length,
      end: ((index + 1) * duration) / words.length,
    })),
  };
}
let voices: SpeechSynthesisVoice[];
let utterances: SpeechSynthesisUtterance[];
let events: EventTarget;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
const synthesis = {
  getVoices: vi.fn(() => voices),
  speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
    utterances.push(utterance);
    utterance.onstart?.({} as SpeechSynthesisEvent);
  }),
  cancel: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  addEventListener: vi.fn((name: string, listener: EventListener) =>
    events.addEventListener(name, listener),
  ),
  removeEventListener: vi.fn((name: string, listener: EventListener) =>
    events.removeEventListener(name, listener),
  ),
};
function frame() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
}
async function audioAt(index: number) {
  await waitFor(() =>
    expect(AudioFixture.instances[index]?.paused).toBe(false),
  );
  return AudioFixture.instances[index];
}
beforeEach(() => {
  window.localStorage.clear();
  resetSpeechPreferencesCache();
  AudioFixture.instances = [];
  AudioFixture.nextDuration = 2;
  voices = [{ lang: "vi-VN" } as SpeechSynthesisVoice];
  utterances = [];
  events = new EventTarget();
  frames = new Map();
  frameId = 0;
  speech.synthesize
    .mockReset()
    .mockResolvedValue(new Blob(["mp3"], { type: "audio/mpeg" }));
  studio.synthesizeTimed
    .mockReset()
    .mockImplementation(async (words: readonly string[]) => timed(words));
  Object.values(synthesis).forEach((mock) => mock.mockClear());
  vi.stubGlobal("Audio", AudioFixture);
  vi.stubGlobal("SpeechSynthesisUtterance", UtteranceFixture);
  vi.stubGlobal("speechSynthesis", synthesis);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:tts"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Phase 3 TTS lifecycle", () => {
  it.each([800, 801, 1600])(
    "plays all %s words exactly once with global word indexes",
    async (count) => {
      const words = Array.from({ length: count }, (_, index) => `w${index}`);
      const { result } = renderHook(() => useSpeechPlayer());
      const onWordChange = vi.fn();
      const onEnded = vi.fn();
      const playback = result.current.playWithWordTimings(words, {
        onWordChange,
        onEnded,
      });
      const first = await audioAt(0);
      act(() => frame());
      expect(onWordChange).toHaveBeenLastCalledWith(0);
      expect(studio.synthesizeTimed).toHaveBeenCalledTimes(1);
      act(() => first.finish());
      if (count > 800) {
        const second = await audioAt(1);
        act(() => frame());
        expect(onWordChange).toHaveBeenLastCalledWith(800);
        act(() => second.finish());
      }
      await playback;
      expect(
        studio.synthesizeTimed.mock.calls.flatMap(([chunk]) => chunk),
      ).toEqual(words);
      expect(
        studio.synthesizeTimed.mock.calls.every(
          ([chunk]) => chunk.length <= 800 && chunk.join(" ").length <= 5000,
        ),
      ).toBe(true);
      expect(onEnded).toHaveBeenCalledOnce();
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(count > 800 ? 2 : 1);
    },
  );

  it("keeps punctuation from verified text and refuses mismatched OCR highlighting", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    const onWordChange = vi.fn();
    const playback = result.current.playWithWordTimings(["Bé", "học"], {
      text: "Bé đi học!\n",
      onWordChange,
    });
    const audio = await audioAt(0);
    act(() => frame());
    expect(studio.synthesizeTimed.mock.calls[0][0]).toEqual([
      "Bé",
      "đi",
      "học!",
    ]);
    expect(onWordChange.mock.calls).toEqual([[-1]]);
    act(() => audio.finish());
    await playback;
  });

  it("pauses and resumes from the same media time without another synthesis", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    const onWordChange = vi.fn();
    const playback = result.current.playWithWordTimings(["Bé", "học"], {
      onWordChange,
    });
    const audio = await audioAt(0);
    audio.currentTime = 0.4;
    act(() => result.current.pause());
    expect(result.current.isPaused).toBe(true);
    expect(audio.paused).toBe(true);
    const changes = onWordChange.mock.calls.length;
    act(() => frame());
    expect(onWordChange).toHaveBeenCalledTimes(changes);
    await act(async () => result.current.resume());
    expect(audio.currentTime).toBe(0.4);
    expect(studio.synthesizeTimed).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledTimes(2);
    act(() => audio.finish());
    await playback;
  });

  it("stops the entire queue and ignores a retained callback from the old page", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    const onEnded = vi.fn();
    const first = result.current
      .playWithWordTimings(Array(801).fill("bé"), { onEnded })
      .catch((error: unknown) => error);
    const audio = await audioAt(0);
    const staleEnd = audio.onended;
    act(() => {
      result.current.stop();
      result.current.stop();
    });
    expect(await first).toMatchObject({ name: "AbortError" });
    expect(studio.synthesizeTimed).toHaveBeenCalledOnce();
    const second = result.current.play("mới");
    const next = await audioAt(1);
    act(() => staleEnd?.());
    expect(onEnded).not.toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(true);
    act(() => next.finish());
    await second;
  });

  it("aborts a pending generation immediately and never plays a late response", async () => {
    let complete!: (speech: TimedSpeech) => void;
    studio.synthesizeTimed.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { result } = renderHook(() => useSpeechPlayer());
    const playback = result.current
      .playWithWordTimings(["bé"], {})
      .catch((error: unknown) => error);
    await waitFor(() => expect(studio.synthesizeTimed).toHaveBeenCalledOnce());
    const signal = studio.synthesizeTimed.mock.calls[0][1]
      .signal as AbortSignal;
    act(() => result.current.stop());
    expect(await playback).toMatchObject({ name: "AbortError" });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      complete(timed(["bé"]));
    });
    expect(AudioFixture.instances).toHaveLength(0);
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it("applies speed to short prompts and the device fallback", async () => {
    setSpeechPreferences({ voiceId: "voice_1", speed: 0.75 });
    speech.synthesize.mockRejectedValueOnce(new Error("503"));
    const { result } = renderHook(() => useSpeechPlayer());
    const playback = result.current.play("Bé đọc sách.");
    await waitFor(() => expect(utterances).toHaveLength(1));
    expect(speech.synthesize).toHaveBeenCalledWith(
      "Bé đọc sách.",
      expect.objectContaining({
        speed: 0.75,
        voiceId: "voice_1",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(utterances[0].rate).toBe(0.75);
    act(() =>
      utterances[0].onend?.({ elapsedTime: 2 } as SpeechSynthesisEvent),
    );
    await playback;
  });

  it("falls back only the failed second chunk, without repeating the first", async () => {
    studio.synthesizeTimed
      .mockImplementationOnce(async (words: readonly string[]) => timed(words))
      .mockRejectedValueOnce(new Error("503"));
    const words = Array.from({ length: 801 }, (_, index) => `w${index}`);
    const { result } = renderHook(() => useSpeechPlayer());
    const onWordChange = vi.fn();
    const playback = result.current.playWithWordTimings(words, {
      onWordChange,
    });
    const first = await audioAt(0);
    act(() => first.finish());
    await waitFor(() => expect(utterances).toHaveLength(1));
    expect(utterances[0].text).toBe("w800");
    act(() =>
      utterances[0].onboundary?.({ charIndex: 0 } as SpeechSynthesisEvent),
    );
    expect(onWordChange).toHaveBeenLastCalledWith(800);
    act(() =>
      utterances[0].onend?.({ elapsedTime: 1 } as SpeechSynthesisEvent),
    );
    await playback;
    expect(AudioFixture.instances).toHaveLength(1);
  });

  it("does not replay a chunk automatically after an error partway through audio", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    const playback = result.current
      .playWithWordTimings(["bé"], {})
      .catch((error: unknown) => error);
    const audio = await audioAt(0);
    audio.currentTime = 0.5;
    act(() => audio.onerror?.());
    expect(await playback).toBeInstanceOf(Error);
    expect(synthesis.speak).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("rejects timing beyond decoded audio duration before emitting word highlights", async () => {
    studio.synthesizeTimed.mockResolvedValueOnce({
      ...timed(["bé"]),
      words: [{ index: 0, start: 0, end: 9 }],
    });
    const { result } = renderHook(() => useSpeechPlayer());
    const onWordChange = vi.fn();
    const fallback = vi.fn();
    await result.current.playWithWordTimings(
      ["bé"],
      { onWordChange },
      fallback,
    );
    expect(fallback).toHaveBeenCalledOnce();
    expect(onWordChange).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("loads late browser voices, then removes the voiceschanged listener", async () => {
    voices = [];
    studio.synthesizeTimed.mockRejectedValueOnce(new Error("503"));
    const { result } = renderHook(() => useSpeechPlayer());
    const onWordChange = vi.fn();
    const playback = result.current.playWithWordTimings(["Bé", "đọc"], {
      onWordChange,
    });
    await waitFor(() =>
      expect(synthesis.addEventListener).toHaveBeenCalledWith(
        "voiceschanged",
        expect.any(Function),
      ),
    );
    voices = [{ lang: "vi-VN" } as SpeechSynthesisVoice];
    act(() => events.dispatchEvent(new Event("voiceschanged")));
    await waitFor(() => expect(utterances).toHaveLength(1));
    act(() =>
      utterances[0].onboundary?.({ charIndex: 3 } as SpeechSynthesisEvent),
    );
    expect(onWordChange).toHaveBeenLastCalledWith(1);
    expect(synthesis.removeEventListener).toHaveBeenCalledWith(
      "voiceschanged",
      expect.any(Function),
    );
    act(() =>
      utterances[0].onend?.({ elapsedTime: 1 } as SpeechSynthesisEvent),
    );
    await playback;
  });

  it("reports no Vietnamese device voice instead of silently choosing an English voice", async () => {
    voices = [{ lang: "en-US" } as SpeechSynthesisVoice];
    studio.synthesizeTimed.mockRejectedValueOnce(new Error("503"));
    const { result } = renderHook(() => useSpeechPlayer());
    await expect(
      result.current.playWithWordTimings(["bé"], {}),
    ).rejects.toThrow("tiếng Việt");
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it("cancels browser utterances on unmount and removes all callbacks", async () => {
    speech.synthesize.mockRejectedValueOnce(new Error("503"));
    const { result, unmount } = renderHook(() => useSpeechPlayer());
    const playback = result.current
      .play("Bé đọc.")
      .catch((error: unknown) => error);
    await waitFor(() => expect(utterances).toHaveLength(1));
    unmount();
    expect(await playback).toMatchObject({ name: "AbortError" });
    expect(synthesis.cancel).toHaveBeenCalledOnce();
    expect(utterances[0].onend).toBeNull();
    expect(utterances[0].onboundary).toBeNull();
  });

  it("stops playback on preference changes and separates the timed cache by voice and speed", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    const first = result.current
      .playWithWordTimings(["bé"], {})
      .catch((error: unknown) => error);
    await audioAt(0);
    act(() => setSpeechPreferences({ voiceId: "v1", speed: 0.7 }));
    expect(await first).toMatchObject({ name: "AbortError" });
    const second = result.current.playWithWordTimings(["bé"], {});
    const audio = await audioAt(1);
    expect(studio.synthesizeTimed).toHaveBeenCalledTimes(2);
    expect(studio.synthesizeTimed.mock.calls[1][1]).toMatchObject({
      voiceId: "v1",
      speed: 0.7,
    });
    act(() => audio.finish());
    await second;
    act(() => setSpeechPreferences({ speed: 1.2 }));
    const third = result.current.playWithWordTimings(["bé"], {});
    const next = await audioAt(2);
    expect(studio.synthesizeTimed).toHaveBeenCalledTimes(3);
    act(() => next.finish());
    await third;
  });
});
