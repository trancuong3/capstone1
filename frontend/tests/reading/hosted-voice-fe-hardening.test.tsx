import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpeechService } from "@/lib/api/speech-service";
import type { VoiceStudioService } from "@/lib/api/voice-studio-service";
import {
  acquireUnlockedAudioElement,
  installAndroidAudioUnlock,
  isAndroidAudioUnlocked,
  resetAndroidAudioUnlockForTest,
} from "@/lib/reading/android-audio-unlock";
import { AudioQualityMonitor } from "@/lib/reading/audio-quality";
import { BrowserTranscriptCollector } from "@/lib/reading/browser-transcript-collector";
import {
  BrowserWasmSttClient,
  getWasmModelCacheStatus,
  resetBrowserWasmSttForTests,
  SHERPA_WASM_MODEL_ID,
  type WasmSttProgressEvent,
} from "@/lib/reading/browser-wasm-stt";
import { analyzeComprehensionVoiceInput } from "@/lib/reading/comprehension-voice-matcher";
import { EchoGuard } from "@/lib/reading/echo-guard";
import {
  encodeFloat32ToWav16kBlob,
  LocalSegmentSpeechRecognition,
  resetLocalSttEmergencyStateForTests,
} from "@/lib/reading/local-segment-speech-recognition";
import { isPhonicsInProgress } from "@/lib/reading/phonics-spelling";
import { ReadingEvidencePipeline } from "@/lib/reading/reading-evidence-pipeline";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import {
  countUnintendedVoiceSwitches,
  getSessionVoiceLock,
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import { setSpeechPreferences } from "@/lib/reading/speech-preferences";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import {
  getVoiceEngineStatus,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import { evaluateRecordedShortWord } from "@/lib/reading/word-practice-engine";
import type {
  ComprehensionChoiceUI,
  ReadingPageWordDTO,
} from "@/types/reading";

function pageWords(sentence: string): ReadingPageWordDTO[] {
  return sentence.split(/\s+/u).map((text, index) => ({
    word_id: `w-${index}`,
    word_index: index,
    text,
    bbox: [0.08 * index, 0.2, 0.07, 0.05] as const,
  }));
}

describe("Hosted Voice FE Hardening (STT-01..STT-10 & TTS-03..TTS-09)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetBrowserWasmSttForTests();
    resetLocalSttEmergencyStateForTests();
    resetAndroidAudioUnlockForTest();
  });

  afterEach(() => {
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetBrowserWasmSttForTests();
    resetLocalSttEmergencyStateForTests();
    resetAndroidAudioUnlockForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("STT-01 & STT-10: Browser WASM progress, timeout race, error terminate, byte verification & Tier-3 fallback", () => {
    it("forwards progress events, races init timeout, terminates worker on error, and decodes WAV blobs", async () => {
      let terminated = 0;
      class ProgressWorker {
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: ErrorEvent) => void) | null = null;
        postMessage(msg: { type: string; id: string }) {
          if (msg.type === "init") {
            queueMicrotask(() => {
              this.onmessage?.({
                data: {
                  type: "progress",
                  stage: "loading-model",
                  file: "encoder.int8.onnx",
                  index: 0,
                  total: 4,
                },
              } as MessageEvent);
              this.onmessage?.({
                data: { type: "ready", id: msg.id },
              } as MessageEvent);
            });
          } else if (msg.type === "transcribe") {
            queueMicrotask(() => {
              this.onmessage?.({
                data: {
                  type: "result",
                  id: msg.id,
                  text: "con mèo",
                  decodeMs: 12,
                },
              } as MessageEvent);
            });
          }
        }
        terminate() {
          terminated += 1;
        }
      }
      vi.stubGlobal("Worker", ProgressWorker);
      if (!globalThis.crypto?.subtle) {
        vi.stubGlobal("crypto", { subtle: { digest: vi.fn() } });
      }

      const client = new BrowserWasmSttClient();
      const events: WasmSttProgressEvent[] = [];
      const unsub = client.subscribeProgress((ev) => events.push(ev));

      const wav = encodeFloat32ToWav16kBlob(new Float32Array(3200).fill(0.05));
      const res = await client.transcribeBlob(wav, {
        timeoutMs: 5_000,
        voicedDurationMs: 200,
      });
      expect(res.text).toBe("con mèo");
      expect(events).toEqual([
        expect.objectContaining({
          stage: "loading-model",
          file: "encoder.int8.onnx",
          index: 0,
          total: 4,
        }),
      ]);
      unsub();

      // Simulate worker crash -> must terminate zombie worker
      const internalWorker = (client as unknown as { worker: ProgressWorker })
        .worker;
      internalWorker.onerror?.({ message: "OOM" } as ErrorEvent);
      expect(terminated).toBe(1);
    });

    it("rejects truncated IndexedDB entries in getWasmModelCacheStatus()", async () => {
      const store = new Map<string, unknown>([
        [`${SHERPA_WASM_MODEL_ID}/encoder.int8.onnx`, { byteLength: 100 }],
        [`${SHERPA_WASM_MODEL_ID}/decoder.onnx`, { byteLength: 5_165_084 }],
        [`${SHERPA_WASM_MODEL_ID}/joiner.int8.onnx`, { byteLength: 1_033_417 }],
        [`${SHERPA_WASM_MODEL_ID}/tokens.txt`, { byteLength: 23_238 }],
      ]);
      const mkReq = (val: unknown) => {
        const req: { result: unknown; onsuccess: (() => void) | null } = {
          result: val,
          onsuccess: null,
        };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      };
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: {
            result: unknown;
            onsuccess: (() => void) | null;
          } = {
            result: {
              objectStoreNames: { contains: () => true },
              close: vi.fn(),
              transaction: () => ({
                objectStore: () => ({
                  get: (k: string) => mkReq(store.get(k)),
                }),
              }),
            },
            onsuccess: null,
          };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        },
      });
      const status = await getWasmModelCacheStatus();
      expect(status.ready).toBe(false);
      expect(status.cachedFiles).toBe(3);
    });

    it("sherpa-stt-worker caps excess leading pre-roll silence on short words without double-padding", async () => {
      const workerPath = resolve(
        process.cwd(),
        "public/workers/sherpa-stt-worker.js",
      );
      const source = readFileSync(workerPath, "utf8");
      const acceptedLengths: number[] = [];

      const workerGlobal: Record<string, unknown> = {
        performance: { now: () => 10 },
        crypto: { subtle: { digest: vi.fn() } },
        postMessage: vi.fn(),
        importScripts: () => {},
        OfflineRecognizer: class FakeOfflineRecognizer {
          handle = 1;
          createStream() {
            return {
              acceptWaveform: (_sr: number, wf: Float32Array) => {
                acceptedLengths.push(wf.length);
              },
              free: () => {},
            };
          }
          decode() {}
          getResult() {
            return { text: "cả" };
          }
          free() {}
        },
      };
      workerGlobal.self = workerGlobal;

      // Stub fetch to return exact-sized dummy buffers & bypass SHA mismatch via crypto mock
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
      workerGlobal.fetch = async (url: string) => {
        const name = String(url).split("/").pop() || "";
        const size = specSizes[name]?.bytes ?? 0;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(size),
        };
      };
      workerGlobal.crypto = {
        subtle: {
          digest: async (_alg: string, buf: ArrayBuffer) => {
            const matched = Object.values(specSizes).find(
              (entry) => entry.bytes === buf.byteLength,
            );
            return shaHexToBytes(matched?.sha ?? specSizes["tokens.txt"].sha);
          },
        },
      };
      workerGlobal.importScripts = () => {
        const mod = workerGlobal.Module as {
          onRuntimeInitialized?: () => void;
          FS_unlink?: (p: string) => void;
          FS_createDataFile?: () => void;
        };
        mod.FS_unlink = () => {};
        mod.FS_createDataFile = () => {};
        mod.onRuntimeInitialized?.();
      };

      const runWorker = new Function(
        "self",
        "fetch",
        "importScripts",
        "OfflineRecognizer",
        source,
      );
      runWorker(
        workerGlobal,
        workerGlobal.fetch,
        workerGlobal.importScripts,
        workerGlobal.OfflineRecognizer,
      );

      // 0.50s pre-roll silence + 0.40s voiced tone (16kHz) => 14,400 samples total
      const sr = 16000;
      const samples = new Float32Array(Math.round(0.9 * sr));
      for (let i = Math.round(0.5 * sr); i < samples.length; i += 1) {
        samples[i] = 0.15 * Math.sin((2 * Math.PI * 240 * i) / sr);
      }
      const onmessage = workerGlobal.onmessage as (ev: {
        data: unknown;
      }) => Promise<void>;
      await onmessage({
        data: {
          type: "transcribe",
          id: "cap-lead-1",
          samples,
          sampleRate: sr,
        },
      });

      expect(acceptedLengths).toHaveLength(1);
      // Trimmed to ~0.18s lead + 0.40s speech = ~9,280 samples (< 11,200), NOT 14,400 + 2,880 = 17,280!
      expect(acceptedLengths[0]).toBeLessThan(Math.round(0.7 * sr));
      expect(acceptedLengths[0]).toBeGreaterThan(Math.round(0.5 * sr));

      // 0.18s lead + 0.40s speech + 0.50s excess trailing silence => tail trimmed to <= 0.20s (~0.78s total)
      const tailSamples = new Float32Array(Math.round(1.08 * sr));
      for (let i = Math.round(0.18 * sr); i < Math.round(0.58 * sr); i += 1) {
        tailSamples[i] = 0.15 * Math.sin((2 * Math.PI * 240 * i) / sr);
      }
      await onmessage({
        data: {
          type: "transcribe",
          id: "cap-tail-1",
          samples: tailSamples,
          sampleRate: sr,
        },
      });
      expect(acceptedLengths).toHaveLength(2);
      expect(acceptedLengths[1]).toBeLessThan(Math.round(0.85 * sr));
      expect(acceptedLengths[1]).toBeGreaterThan(Math.round(0.65 * sr));

      // 20Hz sub-rumble hum stripped by 60Hz HPF must return "" with zero Sherpa decode
      // even when unfiltered client VAD passes voicedDurationMs > 0.
      const hum20 = new Float32Array(Math.round(0.5 * sr));
      for (let i = 0; i < hum20.length; i += 1) {
        hum20[i] = 0.004 * Math.sin((2 * Math.PI * 20 * i) / sr);
      }
      await onmessage({
        data: {
          type: "transcribe",
          id: "hpf-hum-silence",
          samples: hum20,
          sampleRate: sr,
          voicedDurationMs: 300,
        },
      });
      expect(acceptedLengths).toHaveLength(2);
      expect(workerGlobal.postMessage).toHaveBeenLastCalledWith({
        type: "result",
        id: "hpf-hum-silence",
        text: "",
        decodeMs: 0,
      });

      // Zod v4 jitless config prevents Function("") CSP eval violations in production
      const { z } = await import("@/lib/zod-config");
      expect(z.config().jitless).toBe(true);
    });

    it("falls back from failing Tier-1 WASM to Tier-3 Web Speech when allowed, and falls back in evaluateRecordedShortWord on 503", async () => {
      class FailingWasmWorker {
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: ErrorEvent) => void) | null = null;
        postMessage(msg: { type: string; id: string }) {
          queueMicrotask(() => {
            this.onmessage?.({
              data: {
                type: "error",
                id: msg.id,
                message: "Model fetch failed (encoder.int8.onnx): HTTP 502",
              },
            } as MessageEvent);
          });
        }
        terminate() {}
      }
      vi.stubGlobal("Worker", FailingWasmWorker);
      if (!globalThis.crypto?.subtle) {
        vi.stubGlobal("crypto", { subtle: { digest: vi.fn() } });
      }

      let browserStarted = 0;
      class FakeBrowserSpeechRec {
        continuous = true;
        interimResults = true;
        lang = "vi-VN";
        maxAlternatives = 1;
        onresult: ((ev: unknown) => void) | null = null;
        onerror: ((ev: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          browserStarted += 1;
        }
        stop() {
          this.onend?.();
        }
        abort() {
          this.onend?.();
        }
      }
      vi.stubGlobal("SpeechRecognition", FakeBrowserSpeechRec);

      setVoicePolicyPreferences({
        providerMode: "local_with_google_fallback",
        allowGoogleSttFallback: true,
      });
      setCachedVoiceEngineHealth({
        default_mode: "local_with_google_fallback",
        default_voice_id: "local_north_truc_ly",
        local: { available: false, stt_ready: false, tts_ready: false },
        google: {
          stt_configured: false,
          tts_configured: false,
          stt_cooldown: false,
          tts_cooldown: false,
        },
      });

      const rec = new LocalSegmentSpeechRecognition(
        { transcribe: vi.fn() } as unknown as SpeechService,
        () => ({ sessionId: "s-1", pageId: "p-1" }),
      );
      rec.start();
      expect(getVoiceEngineStatus().stt.tier).toBe("browser_wasm");
      const internal = rec as unknown as {
        active: boolean;
        consumeSamples16k: (chunk: Float32Array) => void;
      };
      internal.active = true;
      for (let i = 0; i < 10; i += 1) {
        internal.consumeSamples16k(new Float32Array(640).fill(0.05));
      }
      for (let i = 0; i < 20; i += 1) {
        internal.consumeSamples16k(new Float32Array(640).fill(0));
      }
      await new Promise((r) => setTimeout(r, 80));
      expect(browserStarted).toBe(1);
      expect(getVoiceEngineStatus().stt.tier).toBe("browser_default");
      rec.abort();

      // Now test evaluateRecordedShortWord falling back to BROWSER_WASM on server 503
      resetBrowserWasmSttForTests();
      class WorkingWasmWorker {
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: ErrorEvent) => void) | null = null;
        postMessage(msg: { type: string; id: string }) {
          queueMicrotask(() => {
            if (msg.type === "init") {
              this.onmessage?.({
                data: { type: "ready", id: msg.id },
              } as MessageEvent);
            } else if (msg.type === "transcribe") {
              this.onmessage?.({
                data: {
                  type: "result",
                  id: msg.id,
                  text: "cá",
                  decodeMs: 10,
                },
              } as MessageEvent);
            }
          });
        }
        terminate() {}
      }
      vi.stubGlobal("Worker", WorkingWasmWorker);
      const shortRes = await evaluateRecordedShortWord({
        expectedWord: "cá",
        audioBlob: encodeFloat32ToWav16kBlob(new Float32Array(3200).fill(0.05)),
        speechService: {
          transcribe: vi.fn().mockRejectedValue(new Error("503 Offline")),
        },
      });
      expect(shortRes.source).toBe("BROWSER_WASM");
      expect(shortRes.status).toBe("CORRECT");
    });
  });

  describe("STT-03 & STT-06: WebSocket first-frame auth, vad_mode: client, words timestamps & voiced-only RMS / sustained clipping", () => {
    it("authenticates via first JSON frame (no bearer in Sec-WebSocket-Protocol), sends vad_mode: client, forwards words, and retries once on 4401", async () => {
      const sentFrames: Array<Record<string, unknown>> = [];
      const seenProtocols: Array<string | string[] | undefined> = [];
      const sockets: MockWs[] = [];

      class MockWs {
        static OPEN = 1;
        static CONNECTING = 0;
        readyState = 1;
        binaryType = "";
        onopen: (() => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: ((ev: CloseEvent) => void) | null = null;
        constructor(_url: string, protocols?: string | string[]) {
          seenProtocols.push(protocols);
          sockets.push(this);
          queueMicrotask(() => this.onopen?.());
        }
        send(data: string | ArrayBuffer) {
          if (typeof data === "string") {
            sentFrames.push(JSON.parse(data) as Record<string, unknown>);
          }
        }
        close() {}
      }
      vi.stubGlobal("WebSocket", MockWs);

      let tokenCount = 0;
      const rec = new LocalSegmentSpeechRecognition(
        { transcribe: vi.fn() } as unknown as SpeechService,
        () => ({ sessionId: "s-ws", pageId: "p-ws" }),
        async () => ({
          wsUrl: "wss://api.example.test/voice/stt-stream",
          token: `jwt-${++tokenCount}`,
        }),
      );
      const receivedItems: Array<{ text: string; words?: unknown }> = [];
      rec.onresult = (ev) => {
        const item = ev.results[ev.resultIndex];
        if (item.isFinal) {
          receivedItems.push({ text: item[0].transcript, words: item.words });
        }
      };

      const internal = rec as unknown as {
        active: boolean;
        openSttWebSocket: () => Promise<void>;
        consumeSamples16k: (chunk: Float32Array) => void;
      };
      internal.active = true;
      await internal.openSttWebSocket();
      await new Promise((r) => setTimeout(r, 10));

      // No JWT in subprotocol!
      expect(seenProtocols[0]).toEqual(["viread-stt-v1"]);
      expect(sentFrames[0]).toEqual({ type: "auth", token: "jwt-1" });
      expect(sentFrames[1]).toMatchObject({
        type: "start",
        vad_mode: "client",
      });
      expect(sentFrames[1]).not.toHaveProperty("token");

      // Simulate 4401 close -> refreshes token and reconnects once!
      sockets[0].onclose?.({ code: 4401 } as CloseEvent);
      await new Promise((r) => setTimeout(r, 20));
      expect(sockets).toHaveLength(2);
      expect(
        sentFrames.some((f) => f.type === "auth" && f.token === "jwt-2"),
      ).toBe(true);

      // Mark WS ready, speak a single-sample plosive pop + quiet voiced speech -> verify OK quality & words passthrough
      sockets[1].onmessage?.({
        data: JSON.stringify({ type: "ready" }),
      } as MessageEvent);
      const chunkWithPop = new Float32Array(640).fill(0.015);
      chunkWithPop[10] = 0.995; // single-sample plosive must NOT mark CLIPPING
      internal.consumeSamples16k(chunkWithPop);
      for (let i = 0; i < 6; i += 1) {
        internal.consumeSamples16k(new Float32Array(640).fill(0.015));
      }
      for (let i = 0; i < 20; i += 1) {
        internal.consumeSamples16k(new Float32Array(640).fill(0));
      }

      const flushFrame = sentFrames.find((f) => f.type === "flush");
      expect(flushFrame).toBeDefined();
      expect(typeof flushFrame?.voiced_duration_ms).toBe("number");
      sockets[1].onmessage?.({
        data: JSON.stringify({
          type: "final",
          turn_id: flushFrame?.turn_id,
          text: "con mèo",
          words: [
            { text: "con", start: 0, end: 0.2 },
            { text: "mèo", start: 0.2, end: 0.5 },
          ],
        }),
      } as MessageEvent);
      await new Promise((r) => setTimeout(r, 20));

      expect(receivedItems).toHaveLength(1);
      expect(receivedItems[0].text).toBe("con mèo");
      expect(receivedItems[0].words).toHaveLength(2);
      rec.abort();
    });

    it("does not permanently poison AudioQualityMonitor on a single plosive spike", () => {
      const m = new AudioQualityMonitor({ mode: "child-passage" });
      const mk = (val: number) => Float32Array.from({ length: 128 }, () => val);
      for (let t = 0; t <= 200; t += 20) m.addFrame(mk(0.001), t);
      // Single clipped plosive frame
      m.addFrame(mk(1.0), 220);
      // Followed by clean speech > 300ms later
      for (let t = 240; t <= 900; t += 20) m.addFrame(mk(0.04), t);
      const snap = m.getSnapshot();
      expect(snap.clipped).toBe(false);
      expect(snap.status).toBe("SPEECH_DETECTED");
    });
  });

  describe("STT-05, STT-07 & STT-08: Voice Quiz adversarial matrix, -ơ/onsetless tone grading, cursor-1 self-correction, 2-token lookahead & NFC", () => {
    const ANIMAL_OPT: readonly ComprehensionChoiceUI[] = [
      { id: "A", label: "Con bò", value: "Con bò" },
      { id: "B", label: "Con bê", value: "Con bê" },
      { id: "C", label: "Con gà", value: "Con gà" },
    ];
    const BA_OPT: readonly ComprehensionChoiceUI[] = [
      { id: "A", label: "Ba con bò", value: "Ba con bò" },
      { id: "B", label: "Mẹ nấu cơm", value: "Mẹ nấu cơm" },
      { id: "C", label: "Ông đọc sách", value: "Ông đọc sách" },
    ];

    it("never submits negated options and resolves unanchored self-corrections, symmetric fillers, explicit letters, and 'ba' ambiguity", () => {
      // Inverted negation P0 must stay NEGATED (NEVER submit A!)
      expect(
        analyzeComprehensionVoiceInput("không phải con chọn A", ANIMAL_OPT)
          .type,
      ).toBe("NEGATED");
      expect(
        analyzeComprehensionVoiceInput("không con chọn A", ANIMAL_OPT).type,
      ).toBe("NEGATED");
      expect(
        analyzeComprehensionVoiceInput("dạ không phải con chọn A", ANIMAL_OPT)
          .type,
      ).toBe("NEGATED");

      // Unanchored negation + correction patterns
      expect(
        analyzeComprehensionVoiceInput("A, không phải, chọn B", ANIMAL_OPT),
      ).toMatchObject({ type: "CHOICE", choice: { id: "B" } });
      expect(
        analyzeComprehensionVoiceInput("không phải A mà C", ANIMAL_OPT),
      ).toMatchObject({ type: "CHOICE", choice: { id: "C" } });
      expect(
        analyzeComprehensionVoiceInput("đừng chọn A, chọn C", ANIMAL_OPT),
      ).toMatchObject({ type: "CHOICE", choice: { id: "C" } });
      expect(
        analyzeComprehensionVoiceInput("không phải A, đáp án C", ANIMAL_OPT),
      ).toMatchObject({ type: "CHOICE", choice: { id: "C" } });
      expect(
        analyzeComprehensionVoiceInput("bỏ A chọn C", ANIMAL_OPT),
      ).toMatchObject({ type: "CHOICE", choice: { id: "C" } });

      // Symmetric filler stripping: "chọn bò ạ" matches "Con bò"
      expect(
        analyzeComprehensionVoiceInput("chọn bò ạ", ANIMAL_OPT),
      ).toMatchObject({ type: "CHOICE", choice: { id: "A" } });

      // Explicit letter marker resolves B even when "bê" appears inside option "Con bê"
      expect(
        analyzeComprehensionVoiceInput("con chọn bê ạ", ANIMAL_OPT),
      ).toMatchObject({ type: "CHOICE", choice: { id: "B" } });

      // Non-positional "chọn ba" when Choice A contains "Ba" stays AMBIGUOUS instead of hijacking Choice C
      expect(analyzeComprehensionVoiceInput("chọn ba", BA_OPT).type).toBe(
        "AMBIGUOUS",
      );
    });

    it("never swallows tone errors on -ơ syllables or onsetless single vowels as phonics cues", () => {
      expect(isPhonicsInProgress(["mờ"], "mớ")).toBe(false);
      expect(isPhonicsInProgress(["cơ"], "cờ")).toBe(false);
      expect(isPhonicsInProgress(["bơ"], "bờ")).toBe(false);
      expect(isPhonicsInProgress(["tơ"], "tờ")).toBe(false);
      expect(isPhonicsInProgress(["a"], "á")).toBe(false);
      expect(isPhonicsInProgress(["a"], "à")).toBe(false);
      expect(isPhonicsInProgress(["ô"], "ố")).toBe(false);
      expect(isPhonicsInProgress(["ơ"], "ớ")).toBe(false);
    });

    it("upgrades immediate cursor-1 SUBSTITUTE self-correction, defers unconfirmed function-word skips, allows fluent Vietnamese speed, and normalizes NFC", () => {
      // Immediate self-correction at cursor-1 upgrades SUBSTITUTE -> MATCH
      const engine = new RealtimeAlignmentEngine(pageWords("Con mèo nhỏ"));
      engine.addFinalTranscript("Con méo");
      // Force pending token to flush onto "mèo" -> SUBSTITUTE, cursor advances to "nhỏ" (index 2)
      const internal = engine as unknown as { flushPendingToken: () => void };
      internal.flushPendingToken();
      expect(engine.getSnapshot().statusByWordId.get("w-1")?.status).toBe(
        "SUBSTITUTE",
      );
      // Child immediately corrects "mèo" (cursor - 1) -> upgrades to MATCH!
      const afterFix = engine.addFinalTranscript("mèo nhỏ");
      expect(afterFix.statusByWordId.get("w-1")?.status).toBe("MATCH");
      expect(afterFix.correctedWordIds?.has("w-1")).toBe(true);
      expect(afterFix.statusByWordId.get("w-2")?.status).toBe("MATCH");

      // Unconfirmed function-word insertion ("và") must NOT mark 2 words DELETE prematurely
      const driftEngine = new RealtimeAlignmentEngine(
        pageWords("Mèo nhỏ và chó con"),
      );
      driftEngine.addFinalTranscript("và");
      expect(
        driftEngine.getSnapshot().statusByWordId.get("w-0"),
      ).toBeUndefined();
      const recovered = driftEngine.addFinalTranscript("Mèo nhỏ và chó con");
      expect(recovered.statusByWordId.get("w-0")?.status).toBe("MATCH");
      expect(recovered.statusByWordId.get("w-1")?.status).toBe("MATCH");

      // Fluent Vietnamese child (5 monosyllables in 700ms = 140ms/word) is accepted
      const pipeline = new ReadingEvidencePipeline(
        pageWords("Bé Lan đi học vui"),
      );
      const fluentOutcome = pipeline.ingestFinal({
        text: "Bé Lan đi học vui",
        receivedAt: 1_000,
        speechDurationMs: 700,
      });
      expect(fluentOutcome.kind).toBe("scored");

      // BrowserTranscriptCollector normalizes NFD -> NFC
      const collector = new BrowserTranscriptCollector();
      const nfd = "con mèo".normalize("NFD");
      const finals = collector.addResults({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: nfd, confidence: 0.95 } }],
      });
      expect(finals[0]).toBe("con mèo".normalize("NFC"));
    });

    it("raises EchoGuard default onsetGraceMs to 400ms on Android user agent", () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
        "Mozilla/5.0 (Linux; Android 14; Pixel 7)",
      );
      const guard = new EchoGuard();
      guard.playbackStarted("p1", "Con chọn đáp án nào?", 1_000);
      guard.playbackEnded("p1", 2_000);
      expect(
        guard.evaluate({ text: "chọn B", receivedAt: 2_600, onsetAt: 2_350 }),
      ).toMatchObject({ accept: false, reason: "onset-during-playback" });
      expect(
        guard.evaluate({ text: "chọn B", receivedAt: 2_800, onsetAt: 2_450 })
          .accept,
      ).toBe(true);
    });
  });

  describe("TTS-04, TTS-05, TTS-07 FE & TTS-08 FE: SessionVoiceLock, MP3 timing rescale, NotAllowedError & Android audio unlock", () => {
    it("preserves gender across sessionStorage reload, enforces 0 switches on locked session, rescales MP3 >50ms timing padding, and keeps cache on NotAllowedError", async () => {
      // 1. SessionVoiceLock preserves gender on reload
      lockSessionVoice("sess-male", {
        voiceId: "local_north_thien_minh",
        forceUpdate: true,
      });
      resetVoiceLockAndPolicyForTests();
      const restored = getSessionVoiceLock("sess-male");
      expect(restored?.gender).toBe("male");

      // 2. Active SessionVoiceLock blocks explicit google_* retry & keeps countUnintendedVoiceSwitches === 0
      setVoicePolicyPreferences({
        providerMode: "local_with_google_fallback",
        allowGoogleTtsFallback: true,
      });
      lockSessionVoice("sess-lock", {
        voiceId: "local_north_truc_ly",
        forceUpdate: true,
      });

      const synthesize = vi.fn().mockRejectedValue(new Error("503 Local Down"));
      const synthesizeTimed = vi.fn();
      const player = new TtsPlayback(
        { synthesize } as unknown as SpeechService,
        { synthesizeTimed } as unknown as VoiceStudioService,
      );
      await expect(player.play("Xin chào")).rejects.toThrow();
      // Only 1 call (locked local voice) — NEVER switched to google_* or browser speechSynthesis!
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(countUnintendedVoiceSwitches("sess-lock")).toBe(0);
      player.dispose();
    });

    it("proportionally rescales >50ms MP3 duration delta without aborting & preserves cache on NotAllowedError", async () => {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:tts-test");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

      let failWithNotAllowed = false;
      const createdAudios: FakeAudio[] = [];
      class FakeAudio {
        src: string;
        defaultPlaybackRate = 1;
        playbackRate = 1;
        preservesPitch = true;
        volume = 1;
        duration = 2.0;
        currentTime = 0;
        paused = false;
        ended = false;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        ontimeupdate: (() => void) | null = null;
        onloadedmetadata: (() => void) | null = null;
        constructor(url = "") {
          this.src = url;
          createdAudios.push(this);
        }
        async play() {
          if (failWithNotAllowed) {
            const err = new Error("Autoplay blocked");
            err.name = "NotAllowedError";
            throw err;
          }
          queueMicrotask(() => {
            this.onloadedmetadata?.();
            this.currentTime = 1.9;
            this.ontimeupdate?.();
            this.ended = true;
            this.onended?.();
          });
        }
        pause() {
          this.paused = true;
        }
      }
      vi.stubGlobal("Audio", FakeAudio);
      setSpeechPreferences({ voiceId: "local_north_truc_ly", speed: 1.0 });

      const timedBlob = new Blob(["mp3"], { type: "audio/mpeg" });
      const synthesizeTimed = vi.fn().mockResolvedValue({
        audio: timedBlob,
        durationSeconds: 2.18,
        words: [
          { index: 0, start: 0, end: 1.09 },
          { index: 1, start: 1.09, end: 2.18 }, // 180ms > audio.duration (2.0s) MP3 padding!
        ],
        resolvedVoiceId: "local_north_truc_ly",
        usedFallbackVoice: false,
      });
      const player = new TtsPlayback(
        { synthesize: vi.fn() } as unknown as SpeechService,
        { synthesizeTimed } as unknown as VoiceStudioService,
      );

      // MP3 framing delta (+180ms) must rescale smoothly and highlight words (NOT abort!)
      const highlighted: number[] = [];
      await player.playWithWordTimings(["Hoa", "thơm"], {
        text: "Hoa thơm",
        onWordChange: (idx) => highlighted.push(idx),
      });
      expect(highlighted).toContain(1);

      // NotAllowedError on second play must NOT evict cache or set timedCooldownUntil!
      failWithNotAllowed = true;
      await expect(
        player.playWithWordTimings(["Hoa", "thơm"], { text: "Hoa thơm" }),
      ).rejects.toMatchObject({ name: "NotAllowedError" });
      expect(player.getFallbackNotice()).toMatch(/chạm nút Nghe lại/i);

      // Third play after user tap reuses the STILL-CACHED timed audio (synthesizeTimed called only ONCE!)
      failWithNotAllowed = false;
      await player.playWithWordTimings(["Hoa", "thơm"], { text: "Hoa thơm" });
      expect(synthesizeTimed).toHaveBeenCalledTimes(1);
      player.dispose();
    });

    it("gates Tier-1 precomputedAudioUrl on exact DEFAULT_LOCAL_VOICE_ID and !requireWordTimings", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:t2");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      class AutoFinishAudio {
        defaultPlaybackRate = 1;
        playbackRate = 1;
        preservesPitch = true;
        volume = 1;
        duration = 1.0;
        currentTime = 0;
        paused = false;
        ended = false;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        ontimeupdate: (() => void) | null = null;
        onloadedmetadata: (() => void) | null = null;
        async play() {
          queueMicrotask(() => {
            this.ended = true;
            this.onended?.();
          });
        }
        pause() {}
      }
      vi.stubGlobal("Audio", AutoFinishAudio);

      // Non-default voice (Southern) MUST skip Tier-1 default-voice precomputedAudioUrl!
      setSpeechPreferences({ voiceId: "local_south_thuc_doan", speed: 1.0 });
      const synthesizeTimed = vi.fn().mockResolvedValue({
        audio: new Blob(["south-mp3"], { type: "audio/mpeg" }),
        durationSeconds: 1.0,
        words: [{ index: 0, start: 0, end: 1.0 }],
        resolvedVoiceId: "local_south_thuc_doan",
        usedFallbackVoice: false,
      });
      const player = new TtsPlayback(
        { synthesize: vi.fn() } as unknown as SpeechService,
        { synthesizeTimed } as unknown as VoiceStudioService,
      );
      await player.playWithWordTimings(["Mèo"], {
        text: "Mèo",
        precomputedAudioUrl:
          "https://cdn.example.test/local_north_truc_ly/1.0/a.mp3",
        onWordChange: vi.fn(),
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(synthesizeTimed).toHaveBeenCalledTimes(1);
      player.dispose();
    });

    it("re-attaches unlock listeners on NotAllowedError, waits for AudioContext.resume before close, and reuses unlocked audio element", async () => {
      let resolveResume!: () => void;
      const resumeMock = vi.fn(
        () =>
          new Promise<void>((r) => {
            resolveResume = r;
          }),
      );
      const closeMock = vi.fn(async () => undefined);
      class DeferredAudioContext {
        state = "suspended";
        resume = resumeMock;
        close = closeMock;
      }
      vi.stubGlobal("AudioContext", DeferredAudioContext);

      const notAllowed = new Error("Not allowed");
      notAllowed.name = "NotAllowedError";
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockRejectedValueOnce(notAllowed)
        .mockResolvedValueOnce(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
        () => {},
      );

      installAndroidAudioUnlock();
      document.dispatchEvent(new Event("touchstart"));
      // close() must NOT have been called synchronously before resume() settles
      expect(closeMock).not.toHaveBeenCalled();
      resolveResume();
      await new Promise((r) => setTimeout(r, 10));
      expect(closeMock).toHaveBeenCalledTimes(1);
      // Because probe rejected with NotAllowedError, unlocked must reset to false AND listeners must be re-attached!
      expect(isAndroidAudioUnlocked()).toBe(false);

      // Second gesture MUST trigger unlockAudioNow again (proving installed was properly reset!)
      document.dispatchEvent(new Event("pointerdown"));
      await new Promise((r) => setTimeout(r, 10));
      expect(playSpy).toHaveBeenCalledTimes(2);
      expect(isAndroidAudioUnlocked()).toBe(true);

      // Persistent unlocked element can be borrowed & released cleanly
      const lease = acquireUnlockedAudioElement();
      expect(lease).not.toBeNull();
      expect(acquireUnlockedAudioElement()).toBeNull();
      lease?.release();
      expect(acquireUnlockedAudioElement()).not.toBeNull();
    });
  });
});
