import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import type { SynthesizedPhonicsSpeech } from "@/lib/api/speech-service";
import type { TimedSpeech } from "@/lib/api/voice-studio-service";
import { buildPhonicsLesson } from "@/lib/reading/phonics-lesson";
import {
  countUnintendedVoiceSwitches,
  getSessionVoiceAudit,
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import {
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import { setSynthesizedAudioMeta } from "@/lib/reading/synthesized-audio-meta";
import {
  getVoiceEngineStatus,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";

const { speech, studio } = vi.hoisted(() => ({
  speech: {
    synthesize: vi.fn(),
    synthesizePhonics: vi.fn(),
    transcribe: vi.fn(),
  },
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
  volume = 1;
  src = "";
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
  constructor(src: string) {
    this.src = src;
    AudioFixture.instances.push(this);
  }
  finish() {
    this.ended = true;
    this.paused = true;
    this.onended?.();
  }
}

function timed(words: readonly string[]): TimedSpeech {
  const duration = Math.max(2, words.length * 0.4);
  AudioFixture.nextDuration = duration;
  return {
    audio: new Blob(["wav-fixture"], { type: "audio/wav" }),
    durationSeconds: duration,
    words: words.map((_word, index) => ({
      index,
      start: (index * duration) / words.length,
      end: ((index + 1) * duration) / words.length,
    })),
  };
}

let frames: Map<number, FrameRequestCallback>;
let frameId: number;
const synthesis = {
  getVoices: vi.fn(() => [{ lang: "vi-VN", localService: true }]),
  speak: vi.fn(),
  cancel: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
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
  window.sessionStorage.clear();
  resetSpeechPreferencesCache();
  resetVoiceLockAndPolicyForTests();
  resetVoiceEngineStatus();
  AudioFixture.instances = [];
  AudioFixture.nextDuration = 2;
  frames = new Map();
  frameId = 0;
  speech.synthesize
    .mockReset()
    .mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));
  speech.synthesizePhonics.mockReset();
  studio.synthesizeTimed
    .mockReset()
    .mockImplementation(async (words: readonly string[]) => timed(words));
  Object.values(synthesis).forEach((mock) => mock.mockClear());
  vi.stubGlobal("Audio", AudioFixture);
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

describe("TTS lifecycle & One-Session-One-Voice guarantees", () => {
  it("synthesizes word samples ('thức', 'thực', 'mốt') and coaching in the locked voice with zero OS/static speaker switching", async () => {
    lockSessionVoice("session_locked_south", {
      voiceId: "local_south_thuc_doan",
      speed: 0.85,
      region: "south",
    });
    const { result } = renderHook(() => useSpeechPlayer());

    const utterancesToPlay: readonly [
      string,
      { wordSample?: boolean; coaching?: boolean },
    ][] = [
      ["Chào con, hôm nay mình cùng đọc bài mới nhé.", { coaching: true }],
      ["“THỨC!”".normalize("NFD"), { wordSample: true }],
      ["thực", { wordSample: true }],
      ["mốt", { wordSample: true }],
      ["Con giỏi lắm, mình sang trang tiếp theo nhé.", { coaching: true }],
    ];

    for (const [idx, [text, opts]] of utterancesToPlay.entries()) {
      const p = result.current.play(text, opts);
      const audio = await audioAt(idx);
      expect(audio.playbackRate).toBe(1);
      expect(audio.defaultPlaybackRate).toBe(1);
      expect(audio.preservesPitch).toBe(true);
      act(() => audio.finish());
      await p;
    }

    expect(synthesis.speak).not.toHaveBeenCalled();
    expect(speech.synthesize).toHaveBeenCalledTimes(5);
    for (const call of speech.synthesize.mock.calls) {
      expect(call[1]).toMatchObject({
        voiceId: "local_south_thuc_doan",
        speed: 0.85,
      });
    }
    expect(getSessionVoiceAudit("session_locked_south")).toHaveLength(5);
    expect(countUnintendedVoiceSwitches("session_locked_south")).toBe(0);
  });

  it("never falls back to window.speechSynthesis in local_only mode when the locked local voice fails, surfacing a clear text notice instead", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: false,
    });
    lockSessionVoice("session_no_switch", {
      voiceId: "local_central_ngoc_tran",
      speed: 1.0,
      region: "central",
    });
    speech.synthesize.mockRejectedValueOnce(new Error("worker down"));
    const { result } = renderHook(() => useSpeechPlayer());

    await expect(
      result.current.play("Con thử đọc lại tiếng mốt nhé.", { coaching: true }),
    ).rejects.toThrow();

    expect(synthesis.speak).not.toHaveBeenCalled();
    expect(result.current.fallbackNotice).toMatch(/không tự đổi giọng/i);
  });

  it("auto-falls back to Online browser TTS when Google fallback is opted-in with zero 503 spam on local outage", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      voice: SpeechSynthesisVoice | null = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onboundary: ((ev: { charIndex: number }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    synthesis.speak.mockImplementation((u: FakeUtterance) => {
      queueMicrotask(() => {
        u.onstart?.();
        u.onend?.();
      });
    });

    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });

    const { result } = renderHook(() => useSpeechPlayer());
    await result.current.play("Chào con, hôm nay mình đọc bài nhé.");

    // Zero doomed backend 503 calls!
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(synthesis.speak).toHaveBeenCalledTimes(1);
    expect(getVoiceEngineStatus().tts.tier).toBe("browser_default");
    expect(getVoiceEngineStatus().tts.shortLabel).toBe(
      "Online (Google/Trình duyệt)",
    );
  });

  it("auto-falls back to browser TTS immediately on 503 when Google fallback is opted-in without wasting a second Google backend call", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      voice: SpeechSynthesisVoice | null = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onboundary: ((ev: { charIndex: number }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    synthesis.speak.mockImplementation((u: FakeUtterance) => {
      queueMicrotask(() => {
        u.onstart?.();
        u.onend?.();
      });
    });

    // Suppose local appeared ready earlier, then failed with 503, while Google key is NOT configured
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: true, stt_ready: true, tts_ready: true },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    speech.synthesize.mockRejectedValueOnce(new Error("503 local down"));

    const { result } = renderHook(() => useSpeechPlayer());
    await result.current.play("Con đọc lại từ mốt nhé.");

    // Only 1 backend call (the initial local attempt); did NOT waste a 2nd 503 calling google_vi_vn_*
    expect(speech.synthesize).toHaveBeenCalledTimes(1);
    expect(synthesis.speak).toHaveBeenCalledTimes(1);
    expect(getVoiceEngineStatus().tts.tier).toBe("browser_default");
  });

  it("never permanently locks into Online TTS — resumes Local Offline VieNeu-TTS automatically once local recovers", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      voice: SpeechSynthesisVoice | null = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onboundary: ((ev: { charIndex: number }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    synthesis.speak.mockImplementation((u: FakeUtterance) => {
      queueMicrotask(() => {
        u.onstart?.();
        u.onend?.();
      });
    });

    // 1. Confirmed local outage -> uses browser Online TTS
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    const { result } = renderHook(() => useSpeechPlayer());
    await result.current.play("Câu một lúc mất local.");
    expect(speech.synthesize).toHaveBeenCalledTimes(0);
    expect(synthesis.speak).toHaveBeenCalledTimes(1);
    expect(getVoiceEngineStatus().tts.tier).toBe("browser_default");

    // 2. Local worker comes back healthy -> next utterance automatically uses Local Offline VieNeu-TTS!
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: true, stt_ready: true, tts_ready: true },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    const p2 = result.current.play("Câu hai khi local đã sẵn sàng.");
    const audio = await audioAt(0);
    act(() => audio.finish());
    await p2;

    expect(speech.synthesize).toHaveBeenCalledTimes(1);
    expect(synthesis.speak).toHaveBeenCalledTimes(1);
  });

  it("plays step-by-step phonics for 'mốt' with sample-accurate step callbacks and supports pause/resume", async () => {
    lockSessionVoice("session_phonics", {
      voiceId: "local_north_truc_ly",
      speed: 0.85,
      region: "north",
    });
    const plan = buildPhonicsLesson("mốt");
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;

    AudioFixture.nextDuration = 2.8;
    const phonicsResp: SynthesizedPhonicsSpeech = {
      audio: new Blob(["phonics-wav"], { type: "audio/wav" }),
      durationSeconds: 2.8,
      stepTimings: [
        { id: "rhyme_build", index: 0, start: 0.08, end: 0.7 },
        { id: "onset_blend", index: 1, start: 1.12, end: 1.6 },
        { id: "tone_blend", index: 2, start: 2.02, end: 2.45 },
        { id: "whole_syllable", index: 3, start: 2.52, end: 2.8 },
      ],
      provider: "local",
      resolvedVoiceId: "local_north_truc_ly",
      region: "north",
      modelVersion: "vieneu-v3-turbo-onnx-fp32-3.8.5",
    };
    speech.synthesizePhonics.mockResolvedValueOnce(phonicsResp);

    const onStepChange = vi.fn();
    const { result } = renderHook(() => useSpeechPlayer());
    const playback = result.current.playPhonicsLesson(plan, { onStepChange });

    const audio = await audioAt(0);
    expect(onStepChange).toHaveBeenLastCalledWith(0, plan.steps[0]);

    audio.currentTime = 1.2;
    act(() => audio.ontimeupdate?.());
    expect(onStepChange).toHaveBeenLastCalledWith(1, plan.steps[1]);

    act(() => result.current.pause());
    expect(result.current.isPaused).toBe(true);
    await act(async () => result.current.resume());

    audio.currentTime = 2.6;
    act(() => audio.ontimeupdate?.());
    expect(onStepChange).toHaveBeenLastCalledWith(3, plan.steps[3]);

    act(() => audio.finish());
    await playback;
    expect(speech.synthesizePhonics).toHaveBeenCalledOnce();
    expect(synthesis.speak).not.toHaveBeenCalled();
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
      expect(onEnded).toHaveBeenCalledOnce();
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

  it("prefers the locked-voice short fallback when timed synthesis fails", async () => {
    vi.stubGlobal("SpeechSynthesisUtterance", class {});
    synthesis.speak.mockImplementationOnce(() => {
      throw new Error("Unexpected browser voice switch");
    });
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: true, stt_ready: true, tts_ready: true },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    studio.synthesizeTimed.mockRejectedValueOnce(
      new Error("Timed unavailable"),
    );
    const { result } = renderHook(() => useSpeechPlayer());
    const fallback = vi.fn(async () => {});
    await result.current.playWithWordTimings(["bé"], {}, fallback);
    expect(fallback).toHaveBeenCalledOnce();
    expect(synthesis.speak).not.toHaveBeenCalled();
    synthesis.speak.mockReset();
  });

  it("does not speak with a non-Vietnamese browser voice during an outage", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
    vi.stubGlobal("SpeechSynthesisUtterance", class {});
    synthesis.getVoices.mockReturnValueOnce([
      { lang: "en-US", localService: true },
    ]);
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    // Worker is down — synthesize must reject so play() throws instead of hanging
    speech.synthesize.mockRejectedValueOnce(
      new Error("local worker unavailable"),
    );
    const { result } = renderHook(() => useSpeechPlayer());
    await expect(result.current.play("Bé đọc sách.")).rejects.toThrow();
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(synthesis.getVoices).toHaveBeenCalled();
    expect(synthesis.speak).not.toHaveBeenCalled();
    expect(result.current.fallbackNotice).toMatch(/không tự đổi giọng/i);
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

  it("isolates short & timed caches by (provider, voiceId, modelVersion, speed, NFC text) including Vietnamese tones", async () => {
    const { result } = renderHook(() => useSpeechPlayer());
    act(() =>
      setSpeechPreferences({ voiceId: "local_north_truc_ly", speed: 1.0 }),
    );

    // 1. "mốt" vs "một" vs "mót" must NEVER share cache entries!
    for (const [idx, word] of ["mốt", "một", "mót"].entries()) {
      const p = result.current.play(word, { wordSample: true });
      const a = await audioAt(idx);
      act(() => a.finish());
      await p;
    }
    expect(speech.synthesize).toHaveBeenCalledTimes(3);

    // 2. Replaying "mốt" with same voice + modelVersion + speed hits cache
    const pHit = result.current.play("mốt", { wordSample: true });
    const aHit = await audioAt(3);
    act(() => aHit.finish());
    await pHit;
    expect(speech.synthesize).toHaveBeenCalledTimes(3);

    // 3. Upgrading modelVersion invalidates cache and synthesizes fresh audio
    act(() =>
      setVoicePolicyPreferences({
        modelVersion: "vieneu-v3-turbo-onnx-fp32-3.9.0",
      }),
    );
    const pVer = result.current.play("mốt", { wordSample: true });
    const aVer = await audioAt(4);
    act(() => aVer.finish());
    await pVer;
    expect(speech.synthesize).toHaveBeenCalledTimes(4);

    // 4. Changing speed applies speed ONCE at synthesis (playbackRate remains 1)
    const fallbackBlob = new Blob(["wav-2"], { type: "audio/wav" });
    setSynthesizedAudioMeta(fallbackBlob, {
      resolvedVoiceId: "local_central_ngoc_tran",
      usedFallbackVoice: false,
    });
    speech.synthesize.mockResolvedValueOnce(fallbackBlob);
    act(() =>
      setSpeechPreferences({
        voiceId: "local_central_ngoc_tran",
        speed: 1.15,
      }),
    );
    const pSpd = result.current.play("mốt", { wordSample: true });
    const aSpd = await audioAt(5);
    expect(aSpd.playbackRate).toBe(1);
    expect(speech.synthesize.mock.calls.at(-1)?.[1]).toMatchObject({
      voiceId: "local_central_ngoc_tran",
      speed: 1.15,
    });
    act(() => aSpd.finish());
    await pSpd;
  });

  it("applies per-utterance speedScale on the same locked voice without mutating saved preferences", async () => {
    setSpeechPreferences({ voiceId: "local_north_ngoc_linh", speed: 1.0 });
    const { result } = renderHook(() => useSpeechPlayer());

    const slowWord = result.current.play("mốt", {
      wordSample: true,
      speedScale: 0.85,
    });
    const a0 = await audioAt(0);
    expect(a0.playbackRate).toBe(1);
    expect(speech.synthesize).toHaveBeenLastCalledWith(
      "mốt",
      expect.objectContaining({
        voiceId: "local_north_ngoc_linh",
        speed: 0.85,
        wordSample: true,
      }),
    );
    act(() => a0.finish());
    await slowWord;

    const normalPhrase = result.current.play("Hai mươi mốt bông hoa.");
    const a1 = await audioAt(1);
    expect(speech.synthesize).toHaveBeenLastCalledWith(
      "Hai mươi mốt bông hoa.",
      expect.objectContaining({
        voiceId: "local_north_ngoc_linh",
        speed: 1.0,
      }),
    );
    act(() => a1.finish());
    await normalPhrase;
  });

  it("plays audio/mpeg directly and falls back to WAV if compressed TTS decode fails", async () => {
    const mp3Blob = new Blob(["fake-mp3"], { type: "audio/mpeg" });
    const wavBlob = new Blob(["fake-wav"], { type: "audio/wav" });
    speech.synthesize
      .mockResolvedValueOnce(mp3Blob)
      .mockResolvedValueOnce(wavBlob);

    const { result } = renderHook(() => useSpeechPlayer());
    const playPromise = result.current.play("Xin chào bé yêu.");

    // First attempt receives audio/mpeg and hits WebView decode error before start
    const mp3Audio = await audioAt(0);
    act(() => {
      mp3Audio.onerror?.();
    });

    // Player automatically re-requests explicit audioFormat: "wav" and completes cleanly
    const wavAudio = await audioAt(1);
    expect(speech.synthesize).toHaveBeenNthCalledWith(
      2,
      "Xin chào bé yêu.",
      expect.objectContaining({ audioFormat: "wav" }),
    );
    act(() => wavAudio.finish());
    await playPromise;
  });

  it("rejects unavailable TTS with zero speechSynthesis calls when browser has no Vietnamese voice", async () => {
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: true, stt_ready: true, tts_ready: true },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    synthesis.getVoices.mockReturnValueOnce([
      { lang: "en-US", localService: true } as SpeechSynthesisVoice,
    ]);
    speech.synthesize.mockRejectedValue(new Error("LOCAL_TTS_UNAVAILABLE"));
    const { result } = renderHook(() => useSpeechPlayer());

    await expect(result.current.play("Xin chào bé yêu.")).rejects.toThrow();
    expect(synthesis.speak).not.toHaveBeenCalled();
  });
});
