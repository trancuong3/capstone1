import { describe, expect, it, vi } from "vitest";
import type { SpeechService } from "@/lib/api/speech-service";
import { BrowserTranscriptCollector } from "@/lib/reading/browser-transcript-collector";
import { LocalSegmentSpeechRecognition } from "@/lib/reading/local-segment-speech-recognition";
import {
  AUTO_HELP_LADDER_CONFIG,
  ReadingAutomationRuntime,
  type AutomationClock,
  type AutomationPorts,
} from "@/lib/reading/reading-automation";
import { setVoicePolicyPreferences } from "@/lib/reading/session-voice-lock";

describe("BrowserTranscriptCollector metadata & backward compatibility", () => {
  it("forwards optional 4th meta arg on final & interim results while staying 3-arg compatible", () => {
    const collector = new BrowserTranscriptCollector();
    const metas: unknown[] = [];

    const event = {
      resultIndex: 0,
      results: [
        {
          isFinal: true,
          length: 1,
          0: { transcript: "Bé mèo", confidence: 0.94 },
          epoch: 7,
          sessionId: "sess-1",
          pageId: "page-1",
          turnId: "turn-1",
          segmentId: "seg-1",
          onsetAt: 120,
          audioEndedAt: 480,
          speechDurationMs: 360,
          audioQuality: {
            status: "OK" as const,
            rms: 0.04,
            peak: 0.25,
            speechDurationMs: 360,
          },
        },
        {
          isFinal: false,
          length: 1,
          0: { transcript: "nhỏ", confidence: 0.85 },
          epoch: 7,
          sessionId: "sess-1",
          pageId: "page-1",
          turnId: "turn-1",
          segmentId: "seg-2",
          onsetAt: 520,
        },
      ],
    };

    const finals = collector.addResults(event, (part, usable, conf, meta) => {
      metas.push({ part, usable, conf, meta });
      return true;
    });

    expect(finals).toEqual(["Bé mèo"]);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      part: "Bé mèo",
      usable: true,
      conf: 0.94,
      meta: {
        epoch: 7,
        sessionId: "sess-1",
        pageId: "page-1",
        turnId: "turn-1",
        segmentId: "seg-1",
        onsetAt: 120,
        audioEndedAt: 480,
        speechDurationMs: 360,
        audioQuality: { status: "OK" },
      },
    });

    // Legacy 3-arg callback still works without touching 4th arg
    const legacy = new BrowserTranscriptCollector();
    const legacyTexts = legacy.addResults(event, (part, usable, conf) =>
      Boolean(part && usable && (conf ?? 0) > 0.5),
    );
    expect(legacyTexts).toEqual(["Bé mèo"]);
  });
});

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 16_000;
  audioWorklet = undefined;
  state = "running";
  destination = {};
  processor: {
    onaudioprocess: ((ev: unknown) => void) | null;
    connect: () => void;
    disconnect: () => void;
  } | null = null;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  createScriptProcessor() {
    const proc = {
      onaudioprocess: null as ((ev: unknown) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    this.processor = proc;
    return proc;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  binaryType = "blob";
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  closed = false;

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data === "string") {
      this.sent.push(data);
    } else if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    } else {
      this.sent.push(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
    }
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  triggerOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  triggerMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  triggerClose(code = 4503, reason = "worker down") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

describe("LocalSegmentSpeechRecognition WS /voice/stt-stream & HTTP fallback", () => {
  it("streams 64ms 16kHz Int16 PCM over WS /voice/stt-stream with metadata and falls back to HTTP without 260ms interim abort", async () => {
    FakeWebSocket.instances.length = 0;
    const prevWs = globalThis.WebSocket;
    const prevMediaStream = (globalThis as unknown as { MediaStream?: unknown })
      .MediaStream;
    const prevAudioCtx = (window as unknown as { AudioContext?: unknown })
      .AudioContext;
    const prevWebkitAudioCtx = (
      window as unknown as { webkitAudioContext?: unknown }
    ).webkitAudioContext;

    FakeAudioContext.instances.length = 0;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    (globalThis as unknown as { MediaStream: unknown }).MediaStream = class {
      constructor(private readonly tracks: unknown[] = []) {}
      getTracks() {
        return this.tracks;
      }
    };
    (window as unknown as { AudioContext: unknown }).AudioContext =
      FakeAudioContext;
    (window as unknown as { webkitAudioContext: unknown }).webkitAudioContext =
      undefined;

    try {
      const httpInterimHolder: {
        resolve?: (val: { text: string; words: [] }) => void;
      } = {};
      const transcribeMock = vi.fn().mockImplementation((_blob, opts) => {
        if (opts?.signal) {
          // Verify slow HTTP interim (>300ms) is NOT aborted at 260ms
          return new Promise((resolve) => {
            httpInterimHolder.resolve = resolve;
          });
        }
        return Promise.resolve({ text: "nhỏ đang", words: [] });
      });
      const speechService = {
        transcribe: transcribeMock,
      } as unknown as SpeechService;

      const rec = new LocalSegmentSpeechRecognition(
        speechService,
        () => ({ sessionId: "sess-ws", pageId: "page-ws" }),
        async () => ({
          wsUrl: "wss://localhost:8443/_viread_api/voice/stt-stream",
          token: "jwt-token-123",
        }),
      );

      const emitted: unknown[] = [];
      rec.onresult = (ev) => {
        for (let i = 0; i < ev.results.length; i += 1) {
          emitted.push(ev.results[i]);
        }
      };

      const fakeTrack = {
        readyState: "live",
        stop: vi.fn(),
      } as unknown as MediaStreamTrack;
      rec.start(fakeTrack);
      await Promise.resolve();
      await Promise.resolve();

      expect(FakeWebSocket.instances).toHaveLength(1);
      const ws = FakeWebSocket.instances[0];
      expect(ws.url).toBe("wss://localhost:8443/_viread_api/voice/stt-stream");
      expect(ws.protocols).toEqual(["viread-stt-v1", "bearer.jwt-token-123"]);

      ws.triggerOpen();
      ws.triggerMessage({ type: "ready" });
      const startMsg = JSON.parse(String(ws.sent[0]));
      expect(startMsg).toMatchObject({
        type: "start",
        session_id: "sess-ws",
        page_id: "page-ws",
        sample_rate: 16_000,
        language: "vi",
        token: "jwt-token-123",
      });

      // Push 1024 voiced samples (~64ms @ 16kHz) -> expect 2048-byte Int16 PCM frame
      const voiced = new Float32Array(1024);
      for (let i = 0; i < voiced.length; i += 1) {
        voiced[i] = Math.sin((i / 1024) * Math.PI * 16) * 0.12;
      }
      const ctx = FakeAudioContext.instances.at(-1)!;
      ctx.processor!.onaudioprocess?.({
        inputBuffer: { getChannelData: () => voiced },
      });
      // Push enough frames to exceed initial WS PCM streaming threshold
      ctx.processor!.onaudioprocess?.({
        inputBuffer: { getChannelData: () => voiced },
      });

      const binaryFrames = ws.sent.filter((item) => item instanceof Uint8Array);
      expect(binaryFrames.length).toBeGreaterThanOrEqual(1);
      expect((binaryFrames[0] as Uint8Array).byteLength).toBe(2048);

      // Server emits interim over WS -> verify metadata is populated
      ws.triggerMessage({
        type: "interim",
        text: "Bé mèo",
        turn_id: startMsg.turn_id,
        segment_id: "ws-seg-1",
        session_id: "sess-ws",
        page_id: "page-ws",
        audio_quality: {
          status: "OK",
          rms: 0.08,
          peak: 0.14,
          speech_duration_ms: 128,
        },
      });

      expect(emitted.length).toBeGreaterThanOrEqual(1);
      expect(emitted[0]).toMatchObject({
        isFinal: false,
        0: { transcript: "Bé mèo" },
        epoch: rec.getEpoch(),
        sessionId: "sess-ws",
        pageId: "page-ws",
        segmentId: "ws-seg-1",
        audioQuality: { status: "OK" },
      });

      // Now simulate WS dropping (4503) -> falls back to HTTP without dropping pending audio
      ws.triggerClose(4503, "worker offline");
      rec.stop();
      await Promise.resolve();
      await Promise.resolve();
      expect(transcribeMock).toHaveBeenCalled();

      // Also verify HTTP interim is NOT aborted at 260ms
      vi.useFakeTimers();
      try {
        const recHttp = new LocalSegmentSpeechRecognition(
          { transcribe: transcribeMock } as unknown as SpeechService,
          () => ({ sessionId: "sess-http", pageId: "page-http" }),
          async () => null,
        );
        const httpInterimEvents: string[] = [];
        recHttp.onresult = (ev) => {
          const item = ev.results[ev.resultIndex];
          if (item && !item.isFinal) httpInterimEvents.push(item[0].transcript);
        };
        recHttp.start(fakeTrack);
        await Promise.resolve();
        // Feed 650ms of voiced speech so rolling interim fires
        const httpCtx = FakeAudioContext.instances.at(-1)!;
        for (let k = 0; k < 12; k += 1) {
          httpCtx.processor!.onaudioprocess?.({
            inputBuffer: { getChannelData: () => voiced },
          });
        }
        await vi.advanceTimersByTimeAsync(1_100);
        // Even if transcribe took > 350ms, signal must NOT be aborted
        await vi.advanceTimersByTimeAsync(400);
        const lastCallSignal = transcribeMock.mock.calls.at(-1)?.[1]?.signal as
          AbortSignal | undefined;
        expect(lastCallSignal?.aborted).not.toBe(true);
        httpInterimHolder.resolve?.({ text: "câu dài đang đọc", words: [] });
        recHttp.abort();
      } finally {
        vi.useRealTimers();
      }
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = prevWs;
      (globalThis as unknown as { MediaStream?: unknown }).MediaStream =
        prevMediaStream;
      (window as unknown as { AudioContext?: unknown }).AudioContext =
        prevAudioCtx;
      (
        window as unknown as { webkitAudioContext?: unknown }
      ).webkitAudioContext = prevWebkitAudioCtx;
    }
  });

  it("blocks browser SpeechRecognition fallback when parent policy forbids online fallback", async () => {
    window.localStorage.clear();
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: false,
    });
    const browserStart = vi.fn();
    (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition =
      class {
        start = browserStart;
        stop = vi.fn();
      };

    const speechService = {
      transcribe: vi
        .fn()
        .mockRejectedValue(new ServiceErrorLike("STT_LOCAL_UNAVAILABLE", 503)),
    } as unknown as SpeechService;

    const rec = new LocalSegmentSpeechRecognition(
      speechService,
      () => ({ sessionId: "s", pageId: "p" }),
      async () => null,
    );
    const fakeTrack = {
      readyState: "live",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    rec.start(fakeTrack);
    expect(browserStart).not.toHaveBeenCalled();
    rec.abort();
  });
});

class ServiceErrorLike extends Error {
  readonly retryable = true;
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

describe("ReadingAutomationRuntime states, 2-round ladder, WAIT_REQUESTED, TRY_MORE_REQUESTED & prolonged silence", () => {
  function createHarness(config = AUTO_HELP_LADDER_CONFIG) {
    let now = 0;
    const timers = new Map<number, { at: number; cb: () => void }>();
    let nextId = 1;
    const clock: AutomationClock = {
      now: () => now,
      setTimeout: (cb, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, cb });
        return id;
      },
      clearTimeout: (handle) => {
        if (typeof handle === "number") timers.delete(handle);
      },
    };
    const played: unknown[] = [];
    const shown: string[] = [];
    const stopAudio = vi.fn();
    const giveUpWord = vi.fn();
    const ports: AutomationPorts = {
      startListening: vi.fn(async () => ({ ok: true as const })),
      stopListening: vi.fn(),
      playModel: vi.fn(async (effect) => {
        played.push(effect);
      }),
      stopAudio,
      savePage: vi.fn(async () => true),
      turnPage: vi.fn(),
      finishSession: vi.fn(),
      giveUpWord,
      needsPractice: vi.fn(),
      show: vi.fn((msg) => {
        shown.push(msg);
      }),
    };
    const runtime = new ReadingAutomationRuntime(
      clock,
      ports,
      { assist: true, autoAdvance: true },
      config,
    );
    const advance = async (ms: number) => {
      const target = now + ms;
      while (true) {
        let earliest: [number, { at: number; cb: () => void }] | null = null;
        for (const entry of timers.entries()) {
          if (
            entry[1].at <= target &&
            (!earliest || entry[1].at < earliest[1].at)
          ) {
            earliest = entry;
          }
        }
        if (!earliest) break;
        timers.delete(earliest[0]);
        now = earliest[1].at;
        earliest[1].cb();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
    };
    return { runtime, advance, played, shown, stopAudio, giveUpWord, timers };
  }

  it("supports QUIZ_START/END, RECOVER_START/END, WAIT_REQUESTED, 2-round ladder, TRY_MORE_REQUESTED, and prolonged silence offer-pause", async () => {
    const h = createHarness();
    h.runtime.dispatch({
      type: "START_PAGE",
      page: { sessionId: "s", pageId: "p", revisionId: "r", isLastPage: false },
      words: [{ id: "w0" }, { id: "w1", punctAfter: true }],
    });
    await Promise.resolve();
    expect(h.runtime.getState().phase).toBe("listening");

    // Spelling grace holds silence past 9s
    h.runtime.dispatch({
      type: "SPEECH_ACTIVITY",
      runId: h.runtime.getState().runId,
      holdMs: 15_000,
    });
    await h.advance(10_000);
    expect(h.played).toHaveLength(0);

    // Round 1 wrong -> hinting
    h.runtime.dispatch({
      type: "WORD_EVIDENCE",
      runId: h.runtime.getState().runId,
      pageId: "p",
      revisionId: "r",
      wordId: "w0",
      outcome: "retry",
    });
    await h.advance(1_600);
    expect(h.played.at(-1)).toMatchObject({ kind: "hint", wordId: "w0" });

    // WAIT_REQUESTED ("chờ con") cancels active modeling & extends wait cleanly
    h.runtime.dispatch({ type: "WAIT_REQUESTED", extendMs: 20_000 });
    expect(h.stopAudio).toHaveBeenCalled();
    expect(h.shown).toContain("wait-extended");

    // Round 2 wrong -> phrase
    h.runtime.dispatch({
      type: "WORD_EVIDENCE",
      runId: h.runtime.getState().runId,
      pageId: "p",
      revisionId: "r",
      wordId: "w0",
      outcome: "retry",
    });
    await h.advance(1_600);
    expect(h.played.at(-1)).toMatchObject({ kind: "phrase", wordId: "w0" });

    // Attempt 3 (> 2 rounds) -> encourage + giveUpWord
    h.runtime.dispatch({
      type: "WORD_EVIDENCE",
      runId: h.runtime.getState().runId,
      pageId: "p",
      revisionId: "r",
      wordId: "w0",
      outcome: "retry",
    });
    await h.advance(1_600);
    expect(h.giveUpWord).toHaveBeenCalledWith("w0");

    // TRY_MORE_REQUESTED ("cho con thử thêm") allows extra retry even after 2 rounds!
    h.runtime.dispatch({ type: "TRY_MORE_REQUESTED", wordId: "w0" });
    expect(h.runtime.getState().phase).toBe("awaiting-retry");
    expect(h.runtime.getState().gaveUp).not.toContain("w0");

    // Recover phase while live, then prolonged silence offer-pause, then PAUSE, then QUIZ_START/END
    h.runtime.dispatch({ type: "RECOVER_START" });
    expect(h.runtime.getState().phase).toBe("recovering");
    h.runtime.dispatch({ type: "RECOVER_END" });
    expect(h.runtime.getState().phase).not.toBe("recovering");

    // Prolonged silence on awaiting-retry caps reminders and offers pause
    h.runtime.dispatch({ type: "TRY_MORE_REQUESTED", wordId: "w0" });
    await h.advance(9_500);
    await h.advance(9_500);
    await h.advance(9_500);
    expect(h.shown).toContain("offer-pause");

    // PAUSE clears timers cleanly
    h.runtime.dispatch({ type: "PAUSE", by: "voice" });
    expect(h.timers.size).toBe(0);
    expect(h.runtime.getState().phase).toBe("paused");

    // Quiz phase
    h.runtime.dispatch({ type: "RESUME" });
    h.runtime.dispatch({ type: "QUIZ_START" });
    expect(h.runtime.getState().phase).toBe("quiz-listening");
    h.runtime.dispatch({ type: "QUIZ_END" });
    expect(h.runtime.getState().phase).toBe("complete");
  });
});
