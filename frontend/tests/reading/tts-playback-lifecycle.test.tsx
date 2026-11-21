import { act, renderHook, waitFor } from "@testing-library/react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import type { TimedSpeech } from "@/lib/api/voice-studio-service";
import {
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import { setSynthesizedAudioMeta } from "@/lib/reading/synthesized-audio-meta";

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
  defaultPlaybackRate = 1;
  playbackRate = 1;
  preservesPitch = false;
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
  volume = 0;
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
  it("plays the published recordings for sắc and nặng, including on replay", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    act(() => setSpeechPreferences({ speed: 0.8 }));
    const samples = [
      [
        "“THỨC!”".normalize("NFD"),
        "thuc-sac",
        "d913cbf9ee3de337141390ef01496b225efbb1c055168a8f6d70ec8ca33c8ed7",
      ],
      [
        "thực",
        "thuc-nang",
        "d424c561454f12a43cd978daf0596c3bc23b3ff4014e2d8135595652bf0ee84f",
      ],
      [
        "thức",
        "thuc-sac",
        "d913cbf9ee3de337141390ef01496b225efbb1c055168a8f6d70ec8ca33c8ed7",
      ],
    ] as const;
    for (const [index, [word, name, checksum]] of samples.entries()) {
      const playback = result.current.play(word, { wordSample: true });
      const audio = await audioAt(index);
      expect(audio.src).toBe(`/audio/word-samples/${name}.wav`);
      const file = readFileSync(resolve("public", audio.src.slice(1)));
      expect(createHash("sha256").update(file).digest("hex")).toBe(checksum);
      expect(audio.playbackRate).toBe(0.7);
      expect(audio.preservesPitch).toBe(true);
      act(() => audio.finish());
      await playback;
    }
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it("uses the same spelling for a generated word, its cache, and the Vietnamese fallback", async () => {
    voices = [{ lang: "en-US" } as SpeechSynthesisVoice];
    const { result } = renderHook(() => useSpeechPlayer());
    for (const [i, text] of [
      "“Sớm!”".normalize("NFD"),
      "sớm",
      "sờm",
    ].entries()) {
      const playback = result.current.play(text, { wordSample: true });
      const audio = await audioAt(i);
      act(() => audio.finish());
      await playback;
    }
    expect(speech.synthesize.mock.calls.map(([word]) => word)).toEqual([
      "sớm",
      "sờm",
    ]);
    speech.synthesize.mockImplementationOnce(async () => {
      voices.push({ lang: "vi-VN" } as SpeechSynthesisVoice);
      throw new Error("offline");
    });
    const fallback = result.current.play("“Muộn!”".normalize("NFD"), {
      wordSample: true,
    });
    await waitFor(() => expect(utterances).toHaveLength(1));
    expect(utterances[0].text).toBe("muộn. muộn.");
    expect(utterances[0].voice?.lang).toBe("vi-VN");
    act(() =>
      utterances[0].onend?.({ elapsedTime: 1 } as SpeechSynthesisEvent),
    );
    await fallback;
  });

  it("reads a practice word with a Vietnamese device voice before cloud synthesis", async () => {
    const local = { lang: "vi-VN", localService: true } as SpeechSynthesisVoice;
    voices.push(
      { lang: "en-US", localService: true } as SpeechSynthesisVoice,
      local,
    );
    const { result } = renderHook(() => useSpeechPlayer());
    const sample = result.current.play("Dậy.".normalize("NFD"), {
      wordSample: true,
    });
    await waitFor(() => expect(utterances).toHaveLength(1));
    expect(utterances[0].text).toBe("dậy. dậy.");
    expect(utterances[0].volume).toBe(1);
    expect(utterances[0].voice).toBe(local);
    expect(utterances[0].rate).toBe(0.7);
    expect(speech.synthesize).not.toHaveBeenCalled();
    act(() =>
      utterances[0].onend?.({ elapsedTime: 0.5 } as SpeechSynthesisEvent),
    );
    await sample;
  });

  it("speaks coaching in Vietnamese with the original punctuation and tone marks", async () => {
    const local = { lang: "vi-VN", localService: true } as SpeechSynthesisVoice;
    voices = [
      { lang: "en-US", localService: true } as SpeechSynthesisVoice,
      local,
    ];
    const { result } = renderHook(() => useSpeechPlayer());
    const text = "Con hãy đọc cả cụm: cành cây.";
    const sample = result.current.play(text.normalize("NFD"), {
      coaching: true,
    });
    await waitFor(() => expect(utterances).toHaveLength(1));
    expect(utterances[0]).toMatchObject({
      text,
      voice: local,
      lang: "vi-VN",
      rate: 0.85,
    });
    expect(speech.synthesize).not.toHaveBeenCalled();
    act(() =>
      utterances[0].onend?.({ elapsedTime: 1 } as SpeechSynthesisEvent),
    );
    await sample;
  });

  it("reports an unavailable recording and allows replay without synthesizing a different sample", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    const playback = result.current.play("thức", { wordSample: true });
    const error = expect(playback).rejects.toThrow();
    const audio = await audioAt(0);
    act(() => audio.onerror?.());
    await error;
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(synthesis.speak).not.toHaveBeenCalled();
    const retry = result.current.play("thức", { wordSample: true });
    const second = await audioAt(1);
    expect(second.src).toBe("/audio/word-samples/thuc-sac.wav");
    act(() => second.finish());
    await retry;
  });

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

  it("resets server cooldown when preferences change, applies playbackRate=1 once, caches short TTS by voice+speed+text, and surfaces fallback notice", async () => {
    speech.synthesize.mockRejectedValueOnce(new Error("503"));
    voices = [{ lang: "vi-VN" } as SpeechSynthesisVoice];
    const { result } = renderHook(() => useSpeechPlayer());

    // 1. Trigger server failure -> sets serverRetryAfter & browser fallback notice
    const p1 = result.current.play("Chào bé.");
    await waitFor(() => expect(utterances).toHaveLength(1));
    expect(result.current.fallbackNotice).toMatch(/trình duyệt/i);
    act(() =>
      utterances[0].onend?.({ elapsedTime: 0.8 } as SpeechSynthesisEvent),
    );
    await p1;

    // 2. Switching speed clears cooldown immediately so the next play hits server with new speed
    const fallbackBlob = new Blob(["mp3-1"], { type: "audio/mpeg" });
    setSynthesizedAudioMeta(fallbackBlob, {
      resolvedVoiceId: "cgSgspJ2msm6clMCkdW9",
      usedFallbackVoice: true,
    });
    speech.synthesize.mockResolvedValueOnce(fallbackBlob);
    act(() =>
      setSpeechPreferences({ voiceId: "unavailable-voice", speed: 0.8 }),
    );
    expect(result.current.fallbackNotice).toBeNull();

    const p2 = result.current.play("Chào bé.");
    const a1 = await audioAt(0);
    expect(a1.defaultPlaybackRate).toBe(1);
    expect(a1.playbackRate).toBe(1);
    expect(speech.synthesize).toHaveBeenCalledTimes(2);
    expect(result.current.fallbackNotice).toMatch(/giọng mặc định/i);
    act(() => a1.finish());
    await p2;

    // 3. Replaying same (voiceId, speed, text) hits shortCache with 0 extra network requests
    const p3 = result.current.play("Chào bé.");
    const a2 = await audioAt(1);
    expect(speech.synthesize).toHaveBeenCalledTimes(2);
    act(() => a2.finish());
    await p3;

    // 4. Changing speed invalidates cache key and requests fresh audio immediately
    const freshBlob = new Blob(["mp3-2"], { type: "audio/mpeg" });
    setSynthesizedAudioMeta(freshBlob, {
      resolvedVoiceId: "CwhRBWXzGAHq8TQ4Fs17",
      usedFallbackVoice: false,
    });
    speech.synthesize.mockResolvedValueOnce(freshBlob);
    act(() =>
      setSpeechPreferences({ voiceId: "CwhRBWXzGAHq8TQ4Fs17", speed: 1.1 }),
    );
    const p4 = result.current.play("Chào bé.");
    const a3 = await audioAt(2);
    expect(speech.synthesize).toHaveBeenCalledTimes(3);
    expect(speech.synthesize.mock.calls[2][1]).toMatchObject({
      voiceId: "CwhRBWXzGAHq8TQ4Fs17",
      speed: 1.1,
    });
    expect(result.current.fallbackNotice).toBeNull();
    act(() => a3.finish());
    await p4;
  });

  it("applies per-utterance speedScale for slower help without mutating saved preferences and preserves Vietnamese tones, questions, numbers, and punctuation", async () => {
    setSpeechPreferences({ voiceId: "v-child", speed: 1.0 });
    const { result } = renderHook(() => useSpeechPlayer());

    // 1. Slower single-word model uses scaled speed on browser voice and keeps saved speed at 1.0
    const slowWord = result.current.play("khủng", {
      wordSample: true,
      speedScale: 0.8,
    });
    await waitFor(() => expect(utterances).toHaveLength(1));
    expect(utterances[0].text).toBe("khủng. khủng.");
    expect(utterances[0].rate).toBeLessThan(0.7); // scaled below WORD_SAMPLE_MAX_RATE (0.7)
    act(() =>
      utterances[0].onend?.({ elapsedTime: 0.9 } as SpeechSynthesisEvent),
    );
    await slowWord;

    // 2. Next phrase with proper nouns, questions, numbers, and dense punctuation uses full saved speed (1.0)
    const complex =
      "An, Minh đi đâu thế?! Có 3 quả táo, 10 bông hoa — đẹp quá…";
    const phrase = result.current.play(complex, { speedScale: 1 });
    const audio = await audioAt(0);
    expect(speech.synthesize).toHaveBeenCalledWith(
      complex,
      expect.objectContaining({ voiceId: "v-child", speed: 1.0 }),
    );
    // 3. Starting a new sample immediately aborts the active playback (no overlap / late audio)
    const replacement = result.current.play("mạ", { wordSample: true });
    await expect(phrase).rejects.toMatchObject({ name: "AbortError" });
    expect(audio.pause).toHaveBeenCalled();
    await waitFor(() => expect(utterances).toHaveLength(2));
    expect(utterances[1].text).toBe("mạ. mạ.");
    act(() =>
      utterances[1].onend?.({ elapsedTime: 0.5 } as SpeechSynthesisEvent),
    );
    await replacement;
  });
});
