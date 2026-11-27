import fs from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/browser-auth", () => ({
  getBrowserAccessToken: vi.fn(async () => "test-access-token"),
  invalidateBrowserTokenCache: vi.fn(),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

import { BookPageContent } from "@/components/reading/book-page-content";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import { VoiceEngineBadge } from "@/components/reading/voice-engine-badge";
import { readingPageDtoSchema } from "@/lib/api/reading-service";
import { ServiceError } from "@/lib/api/service-error";
import type { SpeechService } from "@/lib/api/speech-service";
import {
  createVoiceStudioService,
  type VoiceStudioService,
} from "@/lib/api/voice-studio-service";
import { resetBrowserWasmSttForTests } from "@/lib/reading/browser-wasm-stt";
import { EchoGuard } from "@/lib/reading/echo-guard";
import {
  LocalSegmentSpeechRecognition,
  resetLocalSttEmergencyStateForTests,
  StatefulResampler16k,
} from "@/lib/reading/local-segment-speech-recognition";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import {
  countUnintendedVoiceSwitches,
  getActiveSessionVoiceLock,
  getSessionVoiceAudit,
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
  setActiveVoiceSession,
  setVoicePolicyPreferences,
  subscribeVoiceLock,
  subscribeVoicePolicy,
} from "@/lib/reading/session-voice-lock";
import {
  buildTtsBrowserCacheKey,
  clearBrowserTtsCacheForTests,
  getCachedPhonicsTts,
  getCachedTimedTts,
  putCachedPhonicsTts,
  putCachedTimedTts,
} from "@/lib/reading/tts-audio-cache";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import {
  fetchVoiceEngineHealth,
  getVoiceEngineStatus,
  recordSttEngineUsage,
  recordTtsEngineUsage,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import {
  wordPresentationClasses,
  type WordPresentationState,
} from "@/lib/reading/word-presentation";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";

function makePageWords(sentence: string): ReadingPageWordDTO[] {
  return sentence.split(/\s+/u).map((text, index) => ({
    word_id: `w-${index}`,
    word_index: index,
    text,
    bbox: [
      0.04 + (index % 8) * 0.11,
      0.1 + Math.floor(index / 8) * 0.08,
      0.09,
      0.05,
    ] as const,
    line_index: Math.floor(index / 8),
  }));
}

function makeFakeIdb(
  options: { withMetaStore?: boolean; forbidEntriesGetAll?: boolean } = {},
) {
  const { withMetaStore = true, forbidEntriesGetAll = false } = options;
  const stores = new Map<string, Map<string, unknown>>([
    ["entries", new Map()],
  ]);
  if (withMetaStore) {
    stores.set("meta", new Map());
  }
  const txModes: Array<{ stores: string[]; mode: string }> = [];

  const makeReq = <T,>(value: T) => {
    const req: {
      result: T;
      error: null;
      onsuccess: ((ev: Event) => void) | null;
      onerror: ((ev: Event) => void) | null;
    } = {
      result: value,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => req.onsuccess?.(new Event("success")));
    return req;
  };

  const makeStore = (name: string) => {
    const map = stores.get(name) ?? new Map<string, unknown>();
    return {
      get: (key: string) => makeReq(map.get(key)),
      put: (value: { key: string }) => {
        map.set(value.key, value);
        return makeReq(value.key);
      },
      delete: (key: string) => {
        map.delete(key);
        return makeReq(undefined);
      },
      clear: () => {
        map.clear();
        return makeReq(undefined);
      },
      getAll: () => {
        if (forbidEntriesGetAll && name === "entries") {
          throw new Error("entries.getAll() must not be called for LRU scan");
        }
        return makeReq(Array.from(map.values()));
      },
      openCursor: () => {
        const items = Array.from(map.entries());
        let idx = 0;
        const req: {
          result: unknown;
          onsuccess: ((ev: Event) => void) | null;
          onerror: ((ev: Event) => void) | null;
        } = { result: null, onsuccess: null, onerror: null };
        const emit = () => {
          if (idx >= items.length) {
            req.result = null;
          } else {
            const [key, value] = items[idx];
            req.result = {
              key,
              value,
              continue: () => {
                idx += 1;
                queueMicrotask(emit);
              },
            };
          }
          req.onsuccess?.(new Event("success"));
        };
        queueMicrotask(emit);
        return req;
      },
    };
  };

  const fakeDb = {
    objectStoreNames: {
      contains: (name: string) => stores.has(name),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: () => undefined,
    transaction: (storeNames: string | string[], mode = "readonly") => {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      txModes.push({ stores: names, mode });
      const tx: {
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        objectStore: (n: string) => ReturnType<typeof makeStore>;
      } = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: (n: string) => makeStore(n),
      };
      queueMicrotask(() => {
        queueMicrotask(() => {
          tx.oncomplete?.();
        });
      });
      return tx;
    },
  };

  const fakeIdb = {
    open: () => {
      const req: {
        result: typeof fakeDb;
        error: null;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: fakeDb,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };

  return { fakeIdb, stores, txModes };
}

describe("Vercel + Render Reading Flow Overhaul Regressions", () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetBrowserWasmSttForTests();
    resetLocalSttEmergencyStateForTests();
    await clearBrowserTtsCacheForTests();
  });

  afterEach(async () => {
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetBrowserWasmSttForTests();
    resetLocalSttEmergencyStateForTests();
    await clearBrowserTtsCacheForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("Workstream 1: Zero-Layout-Shift Highlighting & Preview Lookahead", () => {
    it("freezes font-weight and border-width across all 12 WordPresentationStates and renders all 5 status glyphs as absolute overlays", () => {
      const allStates: WordPresentationState[] = [
        "unread",
        "current",
        "preview-correct",
        "correct",
        "incorrect",
        "omission",
        "repeated",
        "hesitation",
        "self-corrected",
        "unresolved",
        "assisted",
        "uncertain",
      ];

      for (const state of allStates) {
        const cls = wordPresentationClasses[state];
        expect(cls).not.toContain("font-semibold");
        expect(cls).not.toContain("font-medium");
        expect(cls).not.toContain("font-normal");
        expect(cls).not.toMatch(/\bborder-b-(0|2|8)\b/);
        expect(cls).toMatch(/\bborder-b-/);
      }

      const words = makePageWords("Một hai ba bốn năm sáu");
      const page: ReadingPageDTO = {
        page_id: "page-1",
        page_revision_id: "rev-1",
        page_number: 1,
        confidence: 0.99,
        width: 1000,
        height: 1400,
        text: "Một hai ba bốn năm sáu",
        words,
      };

      const engine = new RealtimeAlignmentEngine(words);
      const baseSnap = engine.getSnapshot();
      const previewSnap = {
        ...baseSnap,
        currentWordId: "w-0",
        previewMatchedWordIds: new Set<string>(["w-1"]),
      };

      const { container } = render(
        <BookPageContent
          page={page}
          currentWordId="w-0"
          previewSnapshot={previewSnap}
          selfCorrectedWordIds={new Set(["w-2"])}
          unresolvedWordIds={new Set(["w-3"])}
          uncertainWordIds={new Set(["w-4"])}
          assistedWordIds={new Set(["w-5"])}
        />,
      );

      const wordNodes =
        container.querySelectorAll<HTMLSpanElement>("[data-word-id]");
      expect(wordNodes).toHaveLength(6);
      wordNodes.forEach((node) => {
        expect(node.className).toContain("relative");
        expect(node.className).toContain("border-b-4");
        expect(node.className).not.toContain("font-semibold");
        expect(node.className).not.toContain("border-b-2");
        expect(node.className).not.toContain("duration-200");
      });

      // Every non-text status glyph inside tokens MUST be pointer-events-none absolute
      const glyphSpans = container.querySelectorAll<HTMLSpanElement>(
        "[data-word-id] > span[aria-hidden='true']",
      );
      expect(glyphSpans.length).toBeGreaterThanOrEqual(5);
      glyphSpans.forEach((glyph) => {
        expect(glyph.className).toContain("absolute");
        expect(glyph.className).toContain("pointer-events-none");
      });
    });

    it("applies shouldDeferLookaheadMatch inside previewAlignment() to stop interim jumps on Vietnamese function words", () => {
      const words = makePageWords(
        "Mặt trời vừa mọc trên ngọn núi xanh rì và chim nhỏ hót vang khắp khu rừng",
      );
      const engine = new RealtimeAlignmentEngine(words);

      // Child is at index 0 ("Mặt"); interim says only function word "và" (index 9)
      const snap = engine.previewAlignment("và");
      expect(snap.previewMatchedWordIds.has("w-9")).toBe(false);
      expect(snap.currentWordId).toBe("w-0");
    });
  });

  describe("Workstream 2: Fast & Accurate Vietnamese STT", () => {
    it("preserves continuous filter state and fractional phase across 1024@48kHz and 512@44.1kHz chunks without boundary spikes or dropped samples", () => {
      for (const [sampleRate, chunkSize] of [
        [48_000, 1024],
        [44_100, 512],
      ] as const) {
        const totalSamples = sampleRate; // 1.0 second of 440 Hz tone
        const fullSignal = new Float32Array(totalSamples);
        for (let i = 0; i < totalSamples; i += 1) {
          fullSignal[i] = 0.45 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
        }

        const oneShot = new StatefulResampler16k(sampleRate).process(
          fullSignal,
        );
        const streamedResampler = new StatefulResampler16k(sampleRate);
        const chunks: Float32Array[] = [];
        let streamedLen = 0;
        for (let offset = 0; offset < totalSamples; offset += chunkSize) {
          const slice = fullSignal.subarray(
            offset,
            Math.min(totalSamples, offset + chunkSize),
          );
          const out = streamedResampler.process(slice);
          chunks.push(out);
          streamedLen += out.length;
        }

        const streamed = new Float32Array(streamedLen);
        let cursor = 0;
        for (const c of chunks) {
          streamed.set(c, cursor);
          cursor += c.length;
        }

        // Total sample count must match continuous resampling (zero chunk-tail drops)
        expect(Math.abs(streamed.length - oneShot.length)).toBeLessThanOrEqual(
          2,
        );

        // Waveform across chunk boundaries must match single-shot seamlessly (no click impulse)
        const compareLen = Math.min(streamed.length, oneShot.length);
        let maxDiff = 0;
        for (let i = 0; i < compareLen; i += 1) {
          const diff = Math.abs(streamed[i] - oneShot[i]);
          if (diff > maxDiff) maxDiff = diff;
        }
        expect(maxDiff).toBeLessThan(1e-4);
      }
    });

    it("excludes 450ms pre-roll silence from MIN_SPEECH_MS gating and prefers Web Speech on hosted LOCAL_VOICE_UNCONFIGURED with Google fallback", () => {
      const transcribe = vi.fn();
      const recognizer = new LocalSegmentSpeechRecognition(
        { transcribe } as unknown as SpeechService,
        () => ({ sessionId: "sess-preroll", pageId: "p-1" }),
      );
      const internal = recognizer as unknown as {
        active: boolean;
        inSpeech: boolean;
        voicedSamples: number;
        preRoll: Float32Array;
        consumeSamples16k: (samples: Float32Array) => void;
        flushCurrentSegment: (carryOverlap?: boolean) => void;
      };

      const flushSpy = vi
        .spyOn(internal, "flushCurrentSegment")
        .mockImplementation(() => undefined);

      internal.active = true;
      // Feed 500ms of near-silence in 40ms frames to fill the 450ms PRE_ROLL_SAMPLES ring buffer
      const silentFrame = new Float32Array(640).fill(0.0002);
      for (let i = 0; i < 13; i += 1) {
        internal.consumeSamples16k(silentFrame);
      }
      expect(internal.inSpeech).toBe(false);
      expect(internal.preRoll.length).toBeGreaterThanOrEqual(7200);

      // Feed 80ms of speech (2 frames = 1280 samples < 120ms MIN_SPEECH_MS), then 520ms silence
      const voicedFrame = new Float32Array(640);
      for (let i = 0; i < voicedFrame.length; i += 1) {
        voicedFrame[i] = 0.08 * Math.sin((2 * Math.PI * 300 * i) / 16_000);
      }
      internal.consumeSamples16k(voicedFrame);
      internal.consumeSamples16k(voicedFrame);
      expect(internal.voicedSamples).toBeLessThan(1920);
      for (let i = 0; i < 15; i += 1) {
        internal.consumeSamples16k(silentFrame);
      }
      // Because 450ms pre-roll is NOT counted in voicedSamples, 80ms blip must NOT flush!
      expect(flushSpy).not.toHaveBeenCalled();

      // WebIDL SpeechRecognitionResult with prototype getters + NFD Vietnamese ("be\u0301")
      // when hosted LOCAL_VOICE_UNCONFIGURED + opted-in online fallback activates streaming Web Speech
      let startedWebSpeech = 0;
      const capturedInstances: FakeWebIdlSpeechRecognition[] = [];
      class FakeWebIdlSpeechRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        maxAlternatives = 1;
        onresult: ((ev: unknown) => void) | null = null;
        onerror: ((ev: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        constructor() {
          capturedInstances.push(this);
        }
        start() {
          startedWebSpeech += 1;
        }
        stop() {
          this.onend?.();
        }
        abort() {
          this.onend?.();
        }
      }
      vi.stubGlobal("SpeechRecognition", FakeWebIdlSpeechRecognition);
      setVoicePolicyPreferences({
        providerMode: "local_with_google_fallback",
        allowGoogleSttFallback: true,
      });
      setCachedVoiceEngineHealth({
        default_mode: "local_only",
        default_voice_id: "local_north_truc_ly",
        local: {
          configured: false,
          mode: "disabled_or_unconfigured",
          error_code: "LOCAL_VOICE_UNCONFIGURED",
          available: false,
          stt_ready: false,
          tts_ready: false,
        },
        google: {
          stt_configured: false,
          tts_configured: true,
          stt_cooldown: false,
          tts_cooldown: false,
        },
      });

      const hostedRec = new LocalSegmentSpeechRecognition(
        { transcribe } as unknown as SpeechService,
        () => ({ sessionId: "sess-hosted", pageId: "p-1" }),
      );
      const received: Array<{
        transcript: string;
        isFinal: boolean;
        confidence?: number;
      }> = [];
      hostedRec.onresult = (ev) => {
        const item = ev.results[ev.resultIndex];
        received.push({
          transcript: item[0].transcript,
          isFinal: item.isFinal,
          confidence: item[0].confidence,
        });
      };

      hostedRec.start();
      expect(startedWebSpeech).toBe(1);
      expect(getVoiceEngineStatus().stt.tier).toBe("browser_default");

      // Emit a real prototype-getter WebIDL object with NFD Vietnamese text
      const altProto = {};
      Object.defineProperty(altProto, "transcript", {
        get() {
          return "be\u0301 đo\u0323c";
        },
        enumerable: true,
      });
      Object.defineProperty(altProto, "confidence", {
        get() {
          return 0.94;
        },
        enumerable: true,
      });
      const fakeAlt = Object.create(altProto);
      const resProto = {};
      Object.defineProperty(resProto, "isFinal", {
        get() {
          return true;
        },
        enumerable: true,
      });
      Object.defineProperty(resProto, "length", {
        get() {
          return 1;
        },
        enumerable: true,
      });
      const fakeRes = Object.create(resProto);
      fakeRes[0] = fakeAlt;

      capturedInstances[0]?.onresult?.({
        resultIndex: 0,
        results: { length: 1, 0: fakeRes },
      });

      expect(received).toHaveLength(1);
      expect(received[0].transcript).toBe("bé đọc".normalize("NFC"));
      expect(received[0].isFinal).toBe(true);
      expect(received[0].confidence).toBeCloseTo(0.94, 2);
      hostedRec.abort();
    });

    it("uses audioEndedAt in EchoGuard to accept pre-TTS child speech and reject late-delivered echo", () => {
      const guard = new EchoGuard();
      guard.playbackStarted("tts-1", "Đọc lại từ này nhé", 1_000);

      // Child finished speaking at 900ms (BEFORE TTS started at 1000ms), delivered late at 1400ms while TTS is playing
      const preTtsVerdict = guard.evaluate({
        text: "con mèo",
        onsetAt: 400,
        audioEndedAt: 900,
        receivedAt: 1_400,
      });
      expect(preTtsVerdict.accept).toBe(true);

      guard.playbackEnded("tts-1", 2_000);
      // Late-delivered echo with no onsetAt whose audioEndedAt fell inside playback (1_850ms)
      const echoVerdict = guard.evaluate({
        text: "đọc lại từ này",
        audioEndedAt: 1_850,
        receivedAt: 2_800,
      });
      expect(echoVerdict.accept).toBe(false);
      expect(echoVerdict.reason).toBe("onset-during-playback");
    });
  });

  describe("Workstream 3: Fast & Reliable TTS Caching & Preview Lock Bypass", () => {
    it("persists CATALOG timed & phonics TTS in IndexedDB with readonly reads, refuses PRIVATE, and avoids entries.getAll() on LRU fallback", async () => {
      const { fakeIdb, stores, txModes } = makeFakeIdb({
        withMetaStore: false,
        forbidEntriesGetAll: true,
      });
      vi.stubGlobal("indexedDB", fakeIdb);

      const timedKey = buildTtsBrowserCacheKey({
        kind: "timed",
        textOrTokens: "Xin chào bé",
        voiceId: "vi-VN-Wavenet-A",
        modelVersion: "google-cloud-tts-v1",
        speed: 0.9,
        scope: "CATALOG",
      });
      const audioBlob = new Blob([new Uint8Array([1, 2, 3, 4])], {
        type: "audio/mpeg",
      });

      // PRIVATE timed clip MUST NOT be persisted
      await putCachedTimedTts({
        key: timedKey,
        scope: "PRIVATE",
        isPrivateBook: true,
        audio: audioBlob,
        durationSeconds: 1.2,
        words: [{ index: 0, start: 0, end: 0.5 }],
        provider: "google",
      });
      expect(stores.get("entries")?.size).toBe(0);

      // CATALOG timed clip IS persisted & retrieved via readonly transaction
      await putCachedTimedTts({
        key: timedKey,
        scope: "CATALOG",
        isPrivateBook: false,
        audio: audioBlob,
        durationSeconds: 1.2,
        words: [
          { index: 0, start: 0, end: 0.5 },
          { index: 1, start: 0.52, end: 1.1 },
        ],
        resolvedVoiceId: "vi-VN-Wavenet-A",
        provider: "google",
        cachedSpeed: 0.9,
      });
      expect(stores.get("entries")?.size).toBe(1);

      txModes.length = 0;
      const hitTimed = await getCachedTimedTts(timedKey);
      expect(hitTimed).not.toBeNull();
      expect(hitTimed?.words).toHaveLength(2);
      expect(hitTimed?.resolvedVoiceId).toBe("vi-VN-Wavenet-A");
      expect(txModes.some((t) => t.mode === "readonly")).toBe(true);

      // Phonics cache round-trip
      const phonicsKey = buildTtsBrowserCacheKey({
        kind: "phonics",
        textOrTokens: "mèo",
        voiceId: "local_north_truc_ly",
        modelVersion: "viread-local-tts-v1",
        speed: 0.85,
        scope: "CATALOG",
      });
      await putCachedPhonicsTts({
        key: phonicsKey,
        scope: "CATALOG",
        isPrivateBook: false,
        audio: audioBlob,
        durationSeconds: 1.8,
        stepTimings: [
          { id: "onset", index: 0, start: 0, end: 0.6 },
          { id: "blend", index: 1, start: 0.65, end: 1.7 },
        ],
        provider: "local",
      });
      const hitPhonics = await getCachedPhonicsTts(phonicsKey);
      expect(hitPhonics).not.toBeNull();
      expect(hitPhonics?.stepTimings).toHaveLength(2);
    });

    it("omits session_id from VoiceStudioService.synthesizeTimed when bypassSessionLock=true (voice preview never hits 409)", async () => {
      setActiveVoiceSession("sess-active-lock");
      lockSessionVoice("sess-active-lock", {
        voiceId: "local_north_truc_ly",
        region: "north",
      });

      const postedBodies: Array<Record<string, unknown>> = [];
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.body && typeof init.body === "string") {
          postedBodies.push(JSON.parse(init.body));
        }
        return new Response(
          JSON.stringify({
            audio_base64: btoa("fake-mp3"),
            content_type: "audio/mpeg",
            duration_seconds: 0.8,
            words: [
              { index: 0, start: 0, end: 0.4 },
              { index: 1, start: 0.42, end: 0.8 },
            ],
            resolved_voice_id: "local_south_thuc_doan",
            provider: "local",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const studio = createVoiceStudioService();
      await studio.synthesizeTimed(["Xin", "chào"], {
        voiceId: "local_south_thuc_doan",
        bypassSessionLock: true,
      });

      expect(postedBodies).toHaveLength(1);
      expect(postedBodies[0].session_id).toBeUndefined();
    });
  });

  describe("Workstream 4: Honest Status Badge, Single-Flight Health & Predictable Voice Lock", () => {
    it("renders honest neutral slate idle badge (never fake green Offline) and deduplicates concurrent /voice/status fetches", async () => {
      const { container } = render(<VoiceEngineBadge />);
      const badge = screen.getByTestId("voice-engine-status-badge");
      const sttChip = screen.getByTestId("voice-engine-stt-chip");
      const ttsChip = screen.getByTestId("voice-engine-tts-chip");

      expect(badge).toHaveAttribute("data-stt-tier", "idle");
      expect(badge).toHaveAttribute("data-tts-tier", "idle");
      expect(sttChip.textContent).not.toContain("Offline");
      expect(ttsChip.textContent).not.toContain("Offline");
      expect(sttChip.className).toContain("slate");
      expect(ttsChip.className).toContain("slate");
      expect(container.querySelectorAll(".bg-emerald-500")).toHaveLength(0);

      // Single-flight health deduplication
      let fetchCalls = 0;
      const fetchMock = vi.fn(async () => {
        fetchCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return new Response(
          JSON.stringify({
            default_mode: "local_only",
            default_voice_id: "local_north_truc_ly",
            local: {
              configured: false,
              mode: "disabled_or_unconfigured",
              error_code: "LOCAL_VOICE_UNCONFIGURED",
              available: false,
              stt_ready: false,
              tts_ready: false,
            },
            google: {
              tts_configured: true,
              stt_configured: false,
              tts_cooldown: false,
              stt_cooldown: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const [h1, h2, h3] = await Promise.all([
        fetchVoiceEngineHealth(),
        fetchVoiceEngineHealth(),
        fetchVoiceEngineHealth(),
      ]);
      expect(fetchCalls).toBe(1);
      expect(h1?.local.error_code).toBe("LOCAL_VOICE_UNCONFIGURED");
      expect(h2).toEqual(h1);
      expect(h3).toEqual(h1);

      // Recording catalog_cache / precomputed_cache TTS updates badge without fake offline flip
      recordTtsEngineUsage({
        provider: "catalog_cache",
        fallbackUsed: false,
      });
      recordSttEngineUsage({ provider: "wasm", fallbackUsed: false });
      expect(getVoiceEngineStatus().tts.tier).toBe("catalog_cache");
      expect(getVoiceEngineStatus().stt.tier).toBe("browser_wasm");
      recordTtsEngineUsage({
        provider: "precomputed_cache",
        fallbackUsed: false,
      });
      expect(getVoiceEngineStatus().tts.provider).toBe("precomputed_cache");
    });

    it("separates lockListeners from policyListeners and prevents region tab clicks from silently mutating an active session lock", async () => {
      setActiveVoiceSession("sess-lock-1");
      const policySpy = vi.fn();
      const lockSpy = vi.fn();
      const unsubPolicy = subscribeVoicePolicy(policySpy);
      const unsubLock = subscribeVoiceLock(lockSpy);

      lockSessionVoice("sess-lock-1", {
        voiceId: "local_north_truc_ly",
        region: "north",
      });

      // Locking session voice MUST notify lockListeners without firing policyListeners
      // (so useSpeechPlayer never calls stop() mid-utterance!)
      expect(lockSpy).toHaveBeenCalledTimes(1);
      expect(policySpy).toHaveBeenCalledTimes(0);

      setVoicePolicyPreferences({ region: "south" });
      expect(policySpy).toHaveBeenCalledTimes(1);

      unsubPolicy();
      unsubLock();

      // Re-lock to North voice and open ReadingVoiceSettings; clicking South tab must NOT change lock!
      lockSessionVoice("sess-lock-1", {
        voiceId: "local_north_truc_ly",
        region: "north",
        forceUpdate: true,
      });
      setCachedVoiceEngineHealth({
        default_mode: "local_only",
        default_voice_id: "local_north_truc_ly",
        local: {
          configured: true,
          mode: "local",
          error_code: null,
          available: true,
          stt_ready: true,
          tts_ready: true,
        },
        google: {
          tts_configured: true,
          stt_configured: true,
          tts_cooldown: false,
          stt_cooldown: false,
        },
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
          const url = String(input);
          if (url.includes("/voice/voices")) {
            return new Response(
              JSON.stringify({
                voices: [
                  {
                    voice_id: "local_north_truc_ly",
                    name: "Cô Trúc Ly - Miền Bắc",
                    gender: "FEMALE",
                    region: "north",
                    provider: "local",
                  },
                  {
                    voice_id: "local_south_thuc_doan",
                    name: "Cô Thục Đoan - Miền Nam",
                    gender: "FEMALE",
                    region: "south",
                    provider: "local",
                  },
                ],
                default_voice_id: "local_north_truc_ly",
                default_speed: 0.9,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      render(
        <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Giọng đọc" }));
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      const southTab = await screen.findByRole("button", { name: "Miền Nam" });
      fireEvent.click(southTab);

      // Active session lock MUST stay pinned to Cô Trúc Ly (North) until user explicitly clicks a South voice
      expect(getActiveSessionVoiceLock()?.voiceId).toBe("local_north_truc_ly");
    });

    it("preserves Tier-1 precomputed TTS fields through readingPageDtoSchema Zod parsing", () => {
      const parsed = readingPageDtoSchema.parse({
        page_id: "30000000-0000-4000-8000-000000000001",
        page_revision_id: "40000000-0000-4000-8000-000000000001",
        page_number: 1,
        confidence: 0.98,
        width: 1000,
        height: 1400,
        image_url: null,
        tts_audio_url: "https://cdn.example.com/catalog/page-1.mp3",
        tts_word_timings: [
          { index: 0, start: 0, end: 0.35 },
          { index: 1, start: 0.36, end: 0.72 },
        ],
        tts_voice_id: "local_north_truc_ly",
        tts_cached_speed: 0.9,
        text: "Con mèo",
        words: [
          {
            word_id: "50000000-0000-4000-8000-000000000001",
            word_index: 0,
            text: "Con",
            bbox: [0.1, 0.1, 0.1, 0.05],
          },
          {
            word_id: "50000000-0000-4000-8000-000000000002",
            word_index: 1,
            text: "mèo",
            bbox: [0.22, 0.1, 0.1, 0.05],
          },
        ],
      });

      expect(parsed.tts_audio_url).toBe(
        "https://cdn.example.com/catalog/page-1.mp3",
      );
      expect(parsed.tts_word_timings).toEqual([
        { index: 0, start: 0, end: 0.35 },
        { index: 1, start: 0.36, end: 0.72 },
      ]);
      expect(parsed.tts_voice_id).toBe("local_north_truc_ly");
      expect(parsed.tts_cached_speed).toBe(0.9);
    });

    it("prevents bypassSessionLock voice previews from polluting active session audit, skips duplicate fallback on LOCAL_VOICE_UNCONFIGURED, and prefetches next timed chunk", async () => {
      const audioInstances: FakeAudio[] = [];
      class FakeAudio {
        src = "";
        preload = "";
        playbackRate = 1;
        currentTime = 0;
        duration = 0.5;
        paused = true;
        ended = false;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onloadedmetadata: (() => void) | null = null;
        ontimeupdate: (() => void) | null = null;
        constructor(src = "") {
          this.src = src;
          audioInstances.push(this);
        }
        play = vi.fn(async () => {
          this.paused = false;
          queueMicrotask(() => {
            this.onloadedmetadata?.();
          });
        });
        pause = vi.fn(() => {
          this.paused = true;
        });
        removeAttribute = vi.fn();
        load = vi.fn();
        finish() {
          this.ended = true;
          this.paused = true;
          this.currentTime = this.duration;
          this.onended?.();
        }
      }
      vi.stubGlobal("Audio", FakeAudio);
      vi.stubGlobal("URL", {
        ...URL,
        createObjectURL: vi.fn(() => "blob:test-audio"),
        revokeObjectURL: vi.fn(),
      });

      setActiveVoiceSession("sess-audit-clean");
      lockSessionVoice("sess-audit-clean", {
        voiceId: "local_north_truc_ly",
        region: "north",
      });

      const synthesizeTimed = vi.fn(async (words: readonly string[]) => ({
        audio: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }),
        durationSeconds: 0.5,
        words: words.map((_, index) => ({
          index,
          start: Number(((index * 0.5) / words.length).toFixed(3)),
          end: Number((((index + 1) * 0.5) / words.length).toFixed(3)),
        })),
        provider: "local",
        resolvedVoiceId: "local_south_thuc_doan",
        region: "south",
        modelVersion: "viread-local-tts-v1",
        usedFallbackVoice: false,
      }));
      const speechMock = {
        synthesize: vi.fn(),
        transcribe: vi.fn(),
      } as unknown as SpeechService;
      const studioMock = {
        listVoices: vi.fn(),
        synthesizeTimed,
      } as unknown as VoiceStudioService;

      const player = new TtsPlayback(speechMock, studioMock);

      // 1. Voice preview with bypassSessionLock: true MUST NOT pollute active session audit
      const previewPromise = player.playWithWordTimings(["Xin", "chào"], {
        bypassSessionLock: true,
      });
      await waitFor(() => expect(audioInstances.length).toBe(1));
      audioInstances[0].finish();
      await previewPromise;
      expect(getSessionVoiceAudit("sess-audit-clean")).toHaveLength(0);
      expect(countUnintendedVoiceSwitches("sess-audit-clean")).toBe(0);

      // 2. LOCAL_VOICE_UNCONFIGURED ServiceError (provider_code snake_case) MUST NOT invoke duplicate short fallback
      synthesizeTimed.mockRejectedValueOnce(
        new ServiceError({
          code: "TTS_UNAVAILABLE",
          provider_code: "LOCAL_VOICE_UNCONFIGURED",
          message: "unconfigured",
          status: 503,
          request_id: "req-unconf",
          retryable: true,
        }),
      );
      const shortFallback = vi.fn(async () => undefined);
      await expect(
        player.playWithWordTimings(
          ["Con", "mèo"],
          { pageId: "page-1", bookId: "book-1" },
          shortFallback,
        ),
      ).rejects.toThrow();
      expect(shortFallback).not.toHaveBeenCalled();

      // 3. Multi-chunk timed playback (805 words -> 2 chunks) prefetches chunk 2 WHILE chunk 1 is playing
      synthesizeTimed.mockClear();
      audioInstances.length = 0;
      const longWords = Array.from({ length: 805 }, (_, i) => `c${i}`);
      const multiPromise = player.playWithWordTimings(longWords, {
        pageId: "page-2",
        bookId: "book-1",
      });
      await waitFor(() => expect(audioInstances.length).toBe(1));
      // Advance playback progress inside chunk 1 -> triggers parallel prefetch of chunk 2!
      audioInstances[0].currentTime = 0.25;
      audioInstances[0].ontimeupdate?.();
      await waitFor(() =>
        expect(synthesizeTimed.mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      // Finish chunk 1 -> chunk 2 plays immediately from prefetched promise
      audioInstances[0].finish();
      await waitFor(() => expect(audioInstances.length).toBe(2));
      audioInstances[1].finish();
      await multiPromise;
      player.stop();
    });

    it("downloads all 4 uncached sherpa-onnx WASM model files in parallel without injecting expected book text", async () => {
      const workerSrc = fs.readFileSync(
        path.resolve(__dirname, "../../public/workers/sherpa-stt-worker.js"),
        "utf8",
      );
      expect(workerSrc).not.toContain("hotwords");
      expect(workerSrc).not.toContain("keyterms");

      const specSizes: Record<string, { bytes: number; sha: string }> = {
        "encoder.int8.onnx": {
          bytes: 27699063,
          sha: "8ef5286dd427eb108055c2ddc1982aa31e544706072d5ea228729292dacade68",
        },
        "decoder.onnx": {
          bytes: 5165084,
          sha: "cf2aa385b82c9d5d40cd29c3188af52d0249b3b78f0d4b7eb84ad502d50c7e7f",
        },
        "joiner.int8.onnx": {
          bytes: 1033417,
          sha: "7311d2e17b810ecea515d79c71cc4668af8759256a06fa01d27047772320c821",
        },
        "tokens.txt": {
          bytes: 23238,
          sha: "ca8171f8bbd516c050b627582f2125c8f5f1f6ed967ab41b0fa9aae2cf61b492",
        },
      };
      const shaHexToBytes = (hex: string) => {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i += 1) {
          bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes.buffer;
      };

      let inFlight = 0;
      let maxInFlight = 0;
      const resolvers: Array<() => void> = [];
      const workerGlobal: Record<string, unknown> = {
        performance: { now: () => 10 },
        postMessage: vi.fn(),
        OfflineRecognizer: class {
          handle = 1;
          free() {}
        },
        crypto: {
          subtle: {
            digest: async (_alg: string, buf: ArrayBuffer) => {
              const matched = Object.values(specSizes).find(
                (entry) => entry.bytes === buf.byteLength,
              );
              return shaHexToBytes(matched?.sha ?? specSizes["tokens.txt"].sha);
            },
          },
        },
        fetch: async (url: string) => {
          const name = String(url).split("/").pop() || "";
          const size = specSizes[name]?.bytes ?? 0;
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
            if (resolvers.length === 4) {
              resolvers.forEach((fn) => fn());
            }
          });
          inFlight -= 1;
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new ArrayBuffer(size),
          };
        },
        importScripts: () => {
          const mod = workerGlobal.Module as {
            onRuntimeInitialized?: () => void;
            FS_unlink?: () => void;
            FS_createDataFile?: () => void;
          };
          mod.FS_unlink = () => {};
          mod.FS_createDataFile = () => {};
          mod.onRuntimeInitialized?.();
        },
      };
      workerGlobal.self = workerGlobal;

      const runWorker = new Function(
        "self",
        "fetch",
        "importScripts",
        "OfflineRecognizer",
        workerSrc,
      );
      runWorker(
        workerGlobal,
        workerGlobal.fetch,
        workerGlobal.importScripts,
        workerGlobal.OfflineRecognizer,
      );

      const onmessage = workerGlobal.onmessage as (ev: {
        data: unknown;
      }) => Promise<void>;
      await onmessage({ data: { type: "init", id: "parallel-init" } });

      // All 4 model downloads MUST be in flight concurrently!
      expect(maxInFlight).toBe(4);
    });
  });
});
