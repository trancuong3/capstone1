import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { AudioQualityMonitor } from "@/lib/reading/audio-quality";
import { analyzeComprehensionVoiceInput } from "@/lib/reading/comprehension-voice-matcher";
import {
  LocalSegmentSpeechRecognition,
  resetLocalSttEmergencyStateForTests,
} from "@/lib/reading/local-segment-speech-recognition";
import { generateSpokenPhonicsGuide } from "@/lib/reading/phonics-spelling";
import {
  AUTO_HELP_LADDER_CONFIG,
  createAutomationState,
  nextWakeAt,
  reduce,
} from "@/lib/reading/reading-automation";
import {
  isImplausibleSpeechSpeed,
  ReadingEvidencePipeline,
} from "@/lib/reading/reading-evidence-pipeline";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import { classifyYesNoVoiceIntent } from "@/lib/reading/retry-word-recognition";
import {
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
} from "@/lib/reading/session-voice-lock";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import type { ComprehensionChoiceUI, ReadingPageDTO } from "@/types/reading";

function makeWords(sentence: string) {
  return sentence.split(/\s+/u).map((text, idx) => ({
    word_id: `w-${idx}`,
    word_index: idx,
    text,
    bbox: [0.05 + idx * 0.05, 0.2, 0.08, 0.05] as const,
  }));
}

describe("Deep Audit P0/P1 Regressions (Mũi A–F)", () => {
  afterEach(() => {
    resetVoiceLockAndPolicyForTests();
    resetLocalSttEmergencyStateForTests();
    vi.restoreAllMocks();
  });

  describe("Mũi A — previewAlignment reanchor & benchmark/production parity", () => {
    it("reanchors cursor in previewAlignment when child skips >= 4 words (synth_mr_07 pattern)", () => {
      const words = makeWords(
        "Bé Lan đi học sớm cùng bạn An và chú mèo nhỏ màu trắng",
      );
      const engine = new RealtimeAlignmentEngine(words);
      engine.addFinalTranscript("Bé Lan");
      expect(engine.getSnapshot().currentWordIndex).toBe(2);

      // Skip 4 words ("đi học sớm cùng") and read "bạn An và chú mèo"
      const preview = engine.previewAlignment("bạn An và chú mèo");
      expect(preview.currentWordIndex).toBe(11);
      expect(preview.previewMatchedWordIds.has("w-6")).toBe(true);
      expect(preview.previewMatchedWordIds.has("w-7")).toBe(true);
      expect(preview.statusByWordId.get("w-2")?.status).toBe("DELETE");
      expect(preview.statusByWordId.get("w-3")?.status).toBe("DELETE");
      expect(preview.statusByWordId.get("w-4")?.status).toBe("DELETE");
      expect(preview.statusByWordId.get("w-5")?.status).toBe("DELETE");
    });

    it("fills skipped [cursor+1 .. matchedIndex-1] consistently even when cursor has SUBSTITUTE", () => {
      const words = makeWords("Một hai ba bốn năm sáu");
      const engine = new RealtimeAlignmentEngine(words);
      // Mark "Một" as SUBSTITUTE first, then skip "hai ba" to "bốn"
      const preview = engine.previewAlignment("xấu bốn năm");
      expect(preview.statusByWordId.get("w-0")?.status).toBe("SUBSTITUTE");
      expect(preview.statusByWordId.get("w-1")?.status).toBe("DELETE");
      expect(preview.statusByWordId.get("w-2")?.status).toBe("DELETE");
      expect(preview.statusByWordId.get("w-3")?.status).toBe("MATCH");
    });

    it("enforces implausible-speed and previewInterim parity in ReadingEvidencePipeline", () => {
      expect(isImplausibleSpeechSpeed(5, 200)).toBe(true);
      expect(isImplausibleSpeechSpeed(5, 1200)).toBe(false);
      const words = makeWords("Bé Lan đi học sớm");
      const pipeline = new ReadingEvidencePipeline(words);
      const out = pipeline.ingestFinal({
        text: "Bé Lan đi học",
        receivedAt: 1000,
        speechDurationMs: 120,
      });
      expect(out).toEqual({ kind: "rejected", reason: "implausible-speed" });
    });
  });

  describe("Mũi B — retryPrompt Yes/No intent, male persona phonics, and adaptive paceMs", () => {
    it("never classifies negated phrases or assistant prompt echo as 'yes'", () => {
      expect(classifyYesNoVoiceIntent("không đồng ý")).toBe("no");
      expect(classifyYesNoVoiceIntent("không cần đọc lại")).toBe("no");
      expect(classifyYesNoVoiceIntent("con chưa muốn đọc lại")).toBe("no");
      expect(
        classifyYesNoVoiceIntent(
          "Con có muốn cùng cô đọc lại vài từ khó không?",
        ),
      ).toBe("unknown");
      expect(
        classifyYesNoVoiceIntent(
          "Con có muốn cùng thầy đọc lại vài từ khó không?",
        ),
      ).toBe("unknown");
      expect(classifyYesNoVoiceIntent("dạ có ạ")).toBe("yes");
      expect(classifyYesNoVoiceIntent("con muốn đọc lại")).toBe("yes");
    });

    it("adapts phonics guide to male teacher persona ('thầy') with zero 'cô' leak", () => {
      lockSessionVoice("sess-male", {
        voiceId: "local_north_thien_minh",
        region: "north",
      });
      const guide = generateSpokenPhonicsGuide("mèo");
      expect(guide.toLowerCase()).toContain("thầy");
      expect(guide.toLowerCase()).not.toMatch(/\bcô\b/u);
    });

    it("produces measurable hesitation difference for Grade-3 fast vs Grade-1 slow readers", () => {
      const pageWords = [
        { id: "w0" },
        { id: "w1" },
        { id: "w2" },
        { id: "w3", punctAfter: true },
        { id: "w4" },
      ];
      const cfg = { ...AUTO_HELP_LADDER_CONFIG, initialPaceMs: 3600 };

      // Fast Grade-3 reader (~550ms/word)
      let fast = createAutomationState(
        { assist: true, autoAdvance: true },
        cfg,
      );
      fast = reduce(fast, {
        type: "START_PAGE",
        page: {
          sessionId: "s",
          pageId: "p1",
          revisionId: "r1",
          isLastPage: false,
        },
        words: pageWords,
        at: 0,
      }).state;
      fast = reduce(fast, {
        type: "LISTEN_RESULT",
        runId: fast.runId,
        ok: true,
        at: 10,
      }).state;
      let t = 10;
      for (const id of ["w0", "w1", "w2"]) {
        t += 550;
        fast = reduce(fast, {
          type: "WORD_EVIDENCE",
          pageId: "p1",
          revisionId: "r1",
          wordId: id,
          outcome: "correct",
          runId: fast.runId,
          at: t,
        }).state;
      }
      fast = reduce(fast, {
        type: "TICK",
        at: t + cfg.evidenceLingerMs,
      }).state;
      const fastWake = nextWakeAt(fast, t)! - t;

      // Slow Grade-1 reader (~3500ms/word + punctuation)
      let slow = createAutomationState(
        { assist: true, autoAdvance: true },
        cfg,
      );
      slow = reduce(slow, {
        type: "START_PAGE",
        page: {
          sessionId: "s",
          pageId: "p1",
          revisionId: "r1",
          isLastPage: false,
        },
        words: pageWords,
        at: 0,
      }).state;
      slow = reduce(slow, {
        type: "LISTEN_RESULT",
        runId: slow.runId,
        ok: true,
        at: 10,
      }).state;
      let ts = 10;
      for (const id of ["w0", "w1", "w2", "w3"]) {
        ts += 3500;
        slow = reduce(slow, {
          type: "WORD_EVIDENCE",
          pageId: "p1",
          revisionId: "r1",
          wordId: id,
          outcome: "correct",
          runId: slow.runId,
          at: ts,
        }).state;
      }
      slow = reduce(slow, {
        type: "TICK",
        at: ts + cfg.evidenceLingerMs,
      }).state;
      const slowWake = nextWakeAt(slow, ts)! - ts;

      expect(fastWake).toBeLessThanOrEqual(4500);
      expect(slowWake).toBeGreaterThan(10_000);
      expect(slowWake).toBeGreaterThan(fastWake * 2);
    });
  });

  describe("Mũi C — AudioQualityMonitor & WS STT auth/clipping/words", () => {
    it("prevents frame-1 noiseFloor poisoning and permanent clip latching in child-passage mode", () => {
      const earlyMon = new AudioQualityMonitor({ mode: "child-passage" });
      const speech = new Float32Array(320).fill(0.08);
      for (let i = 0; i < 20; i += 1) {
        earlyMon.addFrame(speech, i * 20);
      }
      expect(earlyMon.getSnapshot().status).toBe("SPEECH_DETECTED");
      expect(earlyMon.getSnapshot().noiseFloor).toBeLessThanOrEqual(0.01);

      const clipMon = new AudioQualityMonitor({ mode: "child-passage" });
      const quiet = new Float32Array(320).fill(0.002);
      for (let i = 0; i < 12; i += 1) {
        clipMon.addFrame(quiet, i * 20);
      }
      const transientSpike = new Float32Array(320).fill(0.05);
      for (let i = 0; i < 25; i += 1) transientSpike[i] = 0.996;
      clipMon.addFrame(transientSpike, 240);
      for (let i = 13; i < 45; i += 1) {
        clipMon.addFrame(speech, i * 20);
      }
      expect(clipMon.getSnapshot().clipped).toBe(false);
      expect(clipMon.getSnapshot().status).toBe("SPEECH_DETECTED");
    });

    it("authenticates WS via first JSON frame (never bearer.<jwt> subprotocol), preserves msg.words, and tolerates 1-sample clip", async () => {
      const sentFrames: string[] = [];
      const createdProtocols: Array<string | string[] | undefined> = [];
      let latestSocket: FakeWs | null = null;

      class FakeWs {
        static readonly OPEN = 1;
        static readonly CONNECTING = 0;
        readyState = FakeWs.OPEN;
        binaryType = "arraybuffer";
        onopen: (() => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: ((ev: CloseEvent) => void) | null = null;
        constructor(
          public readonly url: string,
          protocols?: string | string[],
        ) {
          createdProtocols.push(protocols);
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          latestSocket = this;
          queueMicrotask(() => this.onopen?.());
        }
        send(data: string | ArrayBuffer) {
          if (typeof data === "string") sentFrames.push(data);
        }
        close() {
          this.readyState = 3;
        }
      }

      vi.stubGlobal("WebSocket", FakeWs);
      let refreshCalls = 0;
      const speechService = {
        synthesize: vi.fn(),
        transcribe: vi.fn(),
      };
      const rec = new LocalSegmentSpeechRecognition(
        speechService,
        () => ({ sessionId: "s1", pageId: "p1" }),
        async (forceRefresh) => {
          if (forceRefresh) refreshCalls += 1;
          return {
            wsUrl: "wss://192.168.1.2:8443/_viread_api/voice/stt-stream",
            token: forceRefresh ? "fresh-jwt-2" : "initial-jwt-1",
          };
        },
      );

      // Directly invoke openSttWebSocket via start-like internal state
      (rec as unknown as { active: boolean }).active = true;
      await (
        rec as unknown as { openSttWebSocket: () => Promise<void> }
      ).openSttWebSocket();
      await Promise.resolve();

      expect(createdProtocols[0]).toEqual(["viread-stt-v1"]);
      expect(JSON.stringify(createdProtocols[0])).not.toContain("bearer.");
      const startFrame = JSON.parse(sentFrames[0]);
      expect(startFrame.type).toBe("start");
      expect(startFrame.token).toBe("initial-jwt-1");
      expect(startFrame.vad_mode).toBe("client");

      // Simulate 4401 expired token close -> refreshes token & reconnects once
      latestSocket!.onclose?.({ code: 4401 } as CloseEvent);
      await new Promise((r) => setTimeout(r, 10));
      expect(refreshCalls).toBe(1);
      expect(JSON.parse(sentFrames[1]).token).toBe("fresh-jwt-2");

      // Mark ready & emit final with words
      const receivedEvents: Array<{
        words?: readonly unknown[];
        text?: string;
      }> = [];
      rec.onresult = (ev) => {
        const item = ev.results[ev.resultIndex];
        receivedEvents.push({
          text: item?.[0]?.transcript,
          words: item?.words,
        });
      };
      latestSocket!.onmessage?.({
        data: JSON.stringify({ type: "ready" }),
      } as MessageEvent);
      latestSocket!.onmessage?.({
        data: JSON.stringify({
          type: "final",
          text: "bé lan",
          turn_id: "spont_1",
          words: [
            { text: "bé", start: 0.1, end: 0.3, type: "word" },
            { text: "lan", start: 0.35, end: 0.6, type: "word" },
          ],
        }),
      } as MessageEvent);

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].words).toHaveLength(2);

      // Verify 1 clipped sample in a 1-second chunk produces OK, NOT CLIPPING
      const cleanSpeech = new Float32Array(16000).fill(0.08);
      cleanSpeech[500] = 0.997;
      (
        rec as unknown as { consumeSamples16k: (c: Float32Array) => void }
      ).consumeSamples16k(cleanSpeech);
      const q = (
        rec as unknown as {
          computeAudioQuality: (ms: number) => { status: string };
        }
      ).computeAudioQuality(1000);
      expect(q.status).toBe("OK");
    });

    it("does not flush truncated mid-sentence audio over WS when speech started before wsReady", async () => {
      const sentFrames: string[] = [];
      let latestSocket: {
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((ev: MessageEvent) => void) | null;
      } | null = null;
      class FakeWs {
        static readonly OPEN = 1;
        static readonly CONNECTING = 0;
        readyState = FakeWs.OPEN;
        binaryType = "arraybuffer";
        onopen: (() => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor() {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          latestSocket = this;
          queueMicrotask(() => this.onopen?.());
        }
        send(data: string | ArrayBuffer) {
          if (typeof data === "string") sentFrames.push(data);
        }
        close() {
          this.readyState = 3;
        }
      }
      vi.stubGlobal("WebSocket", FakeWs);
      const speechService = {
        synthesize: vi.fn(),
        transcribe: vi.fn().mockResolvedValue({
          text: "bé lan đi học",
          language_code: "vi",
          words: [],
        }),
      };
      const rec = new LocalSegmentSpeechRecognition(
        speechService,
        () => ({ sessionId: "s-race", pageId: "p-race" }),
        async () => ({
          wsUrl: "wss://192.168.1.2:8443/_viread_api/voice/stt-stream",
          token: "jwt-race",
        }),
      );
      (rec as unknown as { active: boolean }).active = true;
      await (
        rec as unknown as { openSttWebSocket: () => Promise<void> }
      ).openSttWebSocket();
      await Promise.resolve();

      // Speech onset occurs BEFORE wsReady becomes true
      const loudChunk = new Float32Array(1600).fill(0.08);
      (
        rec as unknown as { consumeSamples16k: (c: Float32Array) => void }
      ).consumeSamples16k(loudChunk);

      // Now WS becomes ready mid-sentence
      latestSocket!.onmessage?.({
        data: JSON.stringify({ type: "ready" }),
      } as MessageEvent);

      // More speech + flush -> must use HTTP with full audio, NOT WS flush of truncated tail
      (
        rec as unknown as { consumeSamples16k: (c: Float32Array) => void }
      ).consumeSamples16k(loudChunk);
      (
        rec as unknown as { flushCurrentSegment: () => void }
      ).flushCurrentSegment();
      await new Promise((r) => setTimeout(r, 20));

      const flushFrames = sentFrames.filter(
        (raw) => JSON.parse(raw).type === "flush",
      );
      expect(flushFrames).toHaveLength(0);
      expect(speechService.transcribe).toHaveBeenCalledTimes(1);
    });
  });

  describe("Mũi D — TtsPlayback.prefetch warms locked voice & speed in shortCache", () => {
    it("synthesizes with the locked session voice/speed and serves cache hit without duplicate network call", async () => {
      lockSessionVoice("sess-quiz-prefetch", {
        voiceId: "local_north_thien_minh",
        region: "north",
        speed: 0.9,
      });
      const fakeBlob = new Blob([new Uint8Array(64)], { type: "audio/wav" });
      const synthesize = vi.fn().mockResolvedValue(fakeBlob);
      const player = new TtsPlayback({ synthesize, transcribe: vi.fn() }, {
        listVoices: vi.fn(),
        synthesizeTimedSpeech: vi.fn(),
      } as unknown as ConstructorParameters<typeof TtsPlayback>[1]);

      await player.prefetch("Đáp án B: Quyển sách", { coaching: true });
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(synthesize).toHaveBeenCalledWith(
        "Đáp án B: Quyển sách",
        expect.objectContaining({
          voiceId: "local_north_thien_minh",
          speed: 0.9,
          wordSample: false,
        }),
      );

      // Second prefetch of same phrase must hit shortCache (0 extra calls)
      await player.prefetch("Đáp án B: Quyển sách", { coaching: true });
      expect(synthesize).toHaveBeenCalledTimes(1);
    });

    it("deduplicates in-flight prefetch with play(), matches multi-chunk keys (>90 chars), and keeps wordSample speed parity", async () => {
      lockSessionVoice("sess-quiz-prefetch-dedup", {
        voiceId: "local_north_truc_ly",
        region: "north",
        speed: 1.0,
      });

      class InstantAudio {
        duration = 0.5;
        currentTime = 0;
        defaultPlaybackRate = 1;
        playbackRate = 1;
        preservesPitch = true;
        volume = 1;
        src = "";
        paused = true;
        ended = false;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        ontimeupdate: (() => void) | null = null;
        onloadedmetadata: (() => void) | null = null;
        constructor(src: string) {
          this.src = src;
        }
        play = vi.fn(async () => {
          this.paused = false;
          queueMicrotask(() => {
            this.ended = true;
            this.paused = true;
            this.onended?.();
          });
        });
        pause = vi.fn(() => {
          this.paused = true;
        });
      }
      vi.stubGlobal("Audio", InstantAudio);
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:prefetch-test");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

      const fakeBlob = new Blob([new Uint8Array(64)], { type: "audio/wav" });
      let resolveInFlight: (b: Blob) => void = () => undefined;
      const synthesize = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Blob>((resolve) => {
              resolveInFlight = resolve;
            }),
        )
        .mockResolvedValue(fakeBlob);

      const player = new TtsPlayback({ synthesize, transcribe: vi.fn() }, {
        listVoices: vi.fn(),
        synthesizeTimed: vi.fn(),
      } as unknown as ConstructorParameters<typeof TtsPlayback>[1]);

      // 1. In-flight race: prefetch is pending when play() starts -> MUST reuse promise (1 call total)
      const prefetchP = player.prefetch("Đáp án B: Mang cặp", {
        coaching: true,
      });
      const playP = player.play("Đáp án B: Mang cặp", { coaching: true });
      resolveInFlight(fakeBlob);
      await Promise.all([prefetchP, playP]);
      expect(synthesize).toHaveBeenCalledTimes(1);

      // 2. Multi-chunk sentence-pipeline (>90 chars with punctuation): prefetch warms exact chunk keys play() consumes
      synthesize.mockClear();
      const longChoice =
        "Đáp án C: Bạn Mi mang chiếc ô màu xanh đến lớp học. Trời đổ mưa to nhưng Mi không bị ướt chút nào.";
      await player.prefetch(longChoice, { coaching: true });
      const prefetchedChunks = synthesize.mock.calls.length;
      expect(prefetchedChunks).toBeGreaterThanOrEqual(2);
      await player.play(longChoice, { coaching: true });
      expect(synthesize).toHaveBeenCalledTimes(prefetchedChunks);

      // 3. wordSample speed parity when locked speed = 1.0 (> 0.95)
      synthesize.mockClear();
      await player.prefetch("mèo", { wordSample: true });
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(synthesize).toHaveBeenCalledWith(
        "mèo",
        expect.objectContaining({ speed: 1.0, wordSample: true }),
      );
      await player.play("mèo", { wordSample: true });
      expect(synthesize).toHaveBeenCalledTimes(1);
    });
  });

  describe("Mũi D — ComprehensionVoiceMatcher collision & 1-syllable content matching", () => {
    const objectChoices: readonly ComprehensionChoiceUI[] = [
      { id: "A", label: "Chiếc ô", value: "Chiếc ô" },
      { id: "B", label: "Con mèo", value: "Con mèo" },
      { id: "C", label: "Quả táo", value: "Quả táo" },
      { id: "D", label: "Quyển sách", value: "Quyển sách" },
    ];
    const nounChoices: readonly ComprehensionChoiceUI[] = [
      { id: "A", label: "Xe đạp", value: "Xe đạp" },
      { id: "B", label: "Lá cờ", value: "Lá cờ" },
      { id: "C", label: "Con dê", value: "Con dê" },
      { id: "D", label: "Bờ biển", value: "Bờ biển" },
    ];

    it("matches 1-syllable distinctive answer 'ô' -> Chiếc ô without answer-key knowledge", () => {
      expect(analyzeComprehensionVoiceInput("ô", objectChoices)).toMatchObject({
        type: "CHOICE",
        choice: { id: "A", label: "Chiếc ô" },
        matchedBy: "content",
      });
    });

    it("never misclassifies bare Vietnamese nouns xe/cờ/dê/bờ as letters B/C/D", () => {
      expect(analyzeComprehensionVoiceInput("xe", objectChoices).type).toBe(
        "NONE",
      );
      expect(analyzeComprehensionVoiceInput("cờ", objectChoices).type).toBe(
        "NONE",
      );
      expect(analyzeComprehensionVoiceInput("dê", objectChoices).type).toBe(
        "NONE",
      );
      expect(analyzeComprehensionVoiceInput("bờ", objectChoices).type).toBe(
        "NONE",
      );

      // When those words ARE in visible choices, they match their content choice (NOT wrong letter!)
      expect(analyzeComprehensionVoiceInput("xe", nounChoices)).toMatchObject({
        type: "CHOICE",
        choice: { id: "A", label: "Xe đạp" },
        matchedBy: "content",
      });
      expect(analyzeComprehensionVoiceInput("cờ", nounChoices)).toMatchObject({
        type: "CHOICE",
        choice: { id: "B", label: "Lá cờ" },
        matchedBy: "content",
      });
      expect(analyzeComprehensionVoiceInput("dê", nounChoices)).toMatchObject({
        type: "CHOICE",
        choice: { id: "C", label: "Con dê" },
        matchedBy: "content",
      });
    });
  });

  describe("Mũi F — useReadingAutoScroll outsideProgrammaticWindow detach", () => {
    let now = 5000;
    beforeEach(() => {
      now = 5000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
    });

    it("detaches and shows 'Về từ đang đọc' on real external scroll outside programmatic window", () => {
      const words = Array.from({ length: 30 }, (_, i) => ({
        word_id: `w-${i}`,
        word_index: i,
        text: `từ${i}`,
        bbox: [0.05, 0.05 + i * 0.02, 0.1, 0.03] as const,
      }));
      const page: ReadingPageDTO = {
        page_id: "p-land",
        page_revision_id: "rev-land",
        page_number: 1,
        confidence: 0.99,
        width: 1000,
        height: 1400,
        text: words.map((w) => w.text).join(" "),
        words,
      };
      const { container } = render(
        <BookPageViewer page={page} currentWordId="w-0" />,
      );
      const scrollEl = container.querySelector<HTMLElement>(
        '[data-reading-scroll-container="true"]',
      )!;
      let scrollTopVal = 0;
      Object.defineProperty(scrollEl, "clientHeight", {
        configurable: true,
        get: () => 260,
      });
      Object.defineProperty(scrollEl, "scrollHeight", {
        configurable: true,
        get: () => 1800,
      });
      Object.defineProperty(scrollEl, "scrollTop", {
        configurable: true,
        get: () => scrollTopVal,
        set: (v: number) => {
          scrollTopVal = v;
        },
      });
      scrollEl.getBoundingClientRect = () =>
        ({
          top: 0,
          bottom: 260,
          left: 0,
          right: 600,
          width: 600,
          height: 260,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      const w0 = container.querySelector<HTMLElement>('[data-word-id="w-0"]')!;
      w0.getBoundingClientRect = () =>
        ({
          top: 20 - scrollTopVal,
          bottom: 50 - scrollTopVal,
          left: 10,
          right: 80,
          width: 70,
          height: 30,
          x: 10,
          y: 20 - scrollTopVal,
          toJSON: () => ({}),
        }) as DOMRect;

      // Advance past programmatic guard window and scroll away externally (no wheel event)
      now += 1500;
      act(() => {
        scrollTopVal = 500;
        fireEvent.scroll(scrollEl);
      });
      expect(scrollEl).toHaveAttribute("data-auto-follow", "paused");
      expect(screen.getByTestId("resume-auto-follow-btn")).toBeInTheDocument();
    });
  });
});
