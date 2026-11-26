import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSpeechService,
  getSynthesizedAudioMeta,
} from "@/lib/api/speech-service";
import {
  BrowserWasmSttClient,
  detectBrowserWasmSttSupport,
  getBrowserWasmSttClient,
  resetBrowserWasmSttForTests,
} from "@/lib/reading/browser-wasm-stt";
import { LocalSegmentSpeechRecognition } from "@/lib/reading/local-segment-speech-recognition";
import {
  buildTtsBrowserCacheKey,
  clearBrowserTtsCacheForTests,
  getBrowserTtsCacheStats,
  getCachedTtsAudio,
  MAX_BROWSER_TTS_CACHE_BYTES,
  putCachedTtsAudio,
  shouldPersistTtsCacheEntry,
} from "@/lib/reading/tts-audio-cache";
import {
  getVoiceEngineStatus,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import type { SpeechService } from "@/lib/api/speech-service";

const { getSession, initialize, fetchMock } = vi.hoisted(() => ({
  getSession: vi.fn(),
  initialize: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({ auth: { initialize, getSession } }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

function installMemoryIndexedDb(): void {
  const dbs = new Map<string, Map<string, Map<string, unknown>>>();
  const makeRequest = <T>(run: () => T) => {
    const req: {
      result: T | undefined;
      error: unknown;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      onupgradeneeded: (() => void) | null;
    } = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (err) {
        req.error = err;
        req.onerror?.();
      }
    });
    return req;
  };

  vi.stubGlobal("indexedDB", {
    open: (name: string) => {
      let stores = dbs.get(name);
      const isNew = !stores;
      if (!stores) {
        stores = new Map<string, Map<string, unknown>>();
        dbs.set(name, stores);
      }
      const getStoreMap = (storeName: string) => {
        let map = stores!.get(storeName);
        if (!map) {
          map = new Map<string, unknown>();
          stores!.set(storeName, map);
        }
        return map;
      };
      const dbObj = {
        objectStoreNames: { contains: () => true },
        createObjectStore: vi.fn((storeName: string) => getStoreMap(storeName)),
        close: vi.fn(),
        transaction: () => {
          const tx: {
            oncomplete: (() => void) | null;
            onerror: (() => void) | null;
            onabort: (() => void) | null;
            objectStore: (storeName: string) => Record<string, unknown>;
          } = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore: (storeName: string) => {
              const storeMap = getStoreMap(storeName);
              return {
                get: (key: string) => makeRequest(() => storeMap.get(key)),
                getAll: () => makeRequest(() => Array.from(storeMap.values())),
                put: (value: { key: string }) =>
                  makeRequest(() => {
                    storeMap.set(value.key, value);
                    queueMicrotask(() => tx.oncomplete?.());
                    return value.key;
                  }),
                delete: (key: string) =>
                  makeRequest(() => {
                    storeMap.delete(key);
                    return undefined;
                  }),
                clear: () =>
                  makeRequest(() => {
                    storeMap.clear();
                    queueMicrotask(() => tx.oncomplete?.());
                    return undefined;
                  }),
              };
            },
          };
          return tx;
        },
      };
      const openReq: {
        result: typeof dbObj;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = {
        result: dbObj,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        if (isNew) openReq.onupgradeneeded?.();
        openReq.onsuccess?.();
      });
      return openReq;
    },
  });
}

describe("Browser WASM STT worker, client & 50MB TTS IndexedDB cache", () => {
  beforeEach(() => {
    localStorage.clear();
    resetVoiceEngineStatus();
    resetBrowserWasmSttForTests();
    initialize.mockReset().mockResolvedValue({ error: null });
    getSession.mockReset().mockResolvedValue({
      data: { session: { access_token: "test-token" } },
      error: null,
    });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    installMemoryIndexedDb();
  });

  afterEach(async () => {
    await clearBrowserTtsCacheForTests();
    resetBrowserWasmSttForTests();
    resetVoiceEngineStatus();
    vi.unstubAllGlobals();
  });

  it("enforces worker lead padding, voiced-duration-gated trailing pad, child-voice AGC, beam search, db.close(), NFC lowercase, zero book text, and free()", async () => {
    const workerSrc = fs.readFileSync(
      path.resolve(__dirname, "../../public/workers/sherpa-stt-worker.js"),
      "utf8",
    );

    const acceptedLengths: number[] = [];
    const acceptedWaveforms: Float32Array[] = [];
    const recognizerConfigs: Array<Record<string, unknown>> = [];
    const freedStreams: number[] = [];
    let recognizerFreed = false;
    const posted: unknown[] = [];

    const expectedSizes: Record<string, number> = {
      "encoder.int8.onnx": 27699063,
      "decoder.onnx": 5165084,
      "joiner.int8.onnx": 1033417,
      "tokens.txt": 23238,
    };
    const expectedHashes: Record<string, string> = {
      "encoder.int8.onnx":
        "8ef5286dd427eb108055c2ddc1982aa31e544706072d5ea228729292dacade68",
      "decoder.onnx":
        "cf2aa385b82c9d5d40cd29c3188af52d0249b3b78f0d4b7eb84ad502d50c7e7f",
      "joiner.int8.onnx":
        "7311d2e17b810ecea515d79c71cc4668af8759256a06fa01d27047772320c821",
      "tokens.txt":
        "ca8171f8bbd516c050b627582f2125c8f5f1f6ed967ab41b0fa9aae2cf61b492",
    };

    const fakeSelf: Record<string, unknown> = {
      performance: { now: () => 100 },
      postMessage: (m: unknown) => posted.push(m),
      importScripts: vi.fn(),
      SherpaWasmVadAsr: () =>
        Promise.resolve({
          FS_unlink: vi.fn(),
          FS_createDataFile: vi.fn(),
        }),
      OfflineRecognizer: class {
        constructor(config: Record<string, unknown>) {
          recognizerConfigs.push(config);
        }
        createStream() {
          return {
            acceptWaveform: (_sr: number, wav: Float32Array) => {
              acceptedLengths.push(wav.length);
              acceptedWaveforms.push(new Float32Array(wav));
            },
            free: () => freedStreams.push(1),
          };
        }
        decode() {}
        getResult() {
          return { text: "  CON MÈO NGỦ  " };
        }
        free() {
          recognizerFreed = true;
        }
      },
      crypto: {
        subtle: {
          digest: async (_alg: string, buf: ArrayBuffer) => {
            const entry = Object.entries(expectedSizes).find(
              ([, len]) => len === buf.byteLength,
            );
            const hex = entry
              ? expectedHashes[entry[0]]
              : crypto
                  .createHash("sha256")
                  .update(Buffer.from(buf))
                  .digest("hex");
            return Uint8Array.from(Buffer.from(hex, "hex")).buffer;
          },
        },
      },
      fetch: async (url: string) => {
        const fname = url.split("/").pop() ?? "";
        const len = expectedSizes[fname] ?? 4;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(len),
        };
      },
      indexedDB: globalThis.indexedDB,
      onmessage: null,
    };

    vm.runInNewContext(workerSrc, {
      self: fakeSelf,
      fetch: fakeSelf.fetch,
      crypto: fakeSelf.crypto,
      indexedDB: fakeSelf.indexedDB,
      importScripts: () => {
        const mod = fakeSelf.Module as Record<string, unknown>;
        mod.FS_unlink = vi.fn();
        mod.FS_createDataFile = vi.fn();
        (mod.onRuntimeInitialized as () => void)();
      },
      Float32Array,
      Uint8Array,
      ArrayBuffer,
      Map,
      Set,
      Promise,
      Error,
      String,
      Number,
      Date,
      Math,
      Object,
      JSON,
    });

    const onmessage = fakeSelf.onmessage as (e: {
      data: Record<string, unknown>;
    }) => Promise<void>;

    const makeSine = (len: number, amp = 0.005, freq = 320) => {
      const arr = new Float32Array(len);
      for (let i = 0; i < len; i += 1) {
        arr[i] = amp * Math.sin((2 * Math.PI * freq * i) / 16000);
      }
      return arr;
    };

    // 1. Short isolated word with 0.45s pre-roll (total 1.21s = 19,360 samples, voicedDurationMs = 600 < 1200)
    //    MUST receive 0.18s lead pad (2880) and ZERO trailing pad (prevents collocation hallucinations!)
    await onmessage({
      data: {
        type: "transcribe",
        id: "short-preroll",
        samples: makeSine(19360, 0.005),
        sampleRate: 16000,
        voicedDurationMs: 600,
      },
    });
    expect(
      posted.filter((m) => (m as { type?: string }).type === "error"),
    ).toEqual([]);
    expect(acceptedLengths[0]).toBe(2880 + 19360);
    // Child-voice AGC lifts quiet 0.005 sine wave above 0.05!
    const boostedPeak = acceptedWaveforms[0].reduce(
      (max, v) => Math.max(max, Math.abs(v)),
      0,
    );
    expect(boostedPeak).toBeGreaterThan(0.05);

    // 2. Longer sentence (voicedDurationMs = 1400 >= 1200) receives lead pad (2880) + trailing pad (5600)
    await onmessage({
      data: {
        type: "transcribe",
        id: "long-1",
        samples: makeSine(24000, 0.08),
        sampleRate: 16000,
        voicedDurationMs: 1400,
      },
    });
    expect(acceptedLengths[1]).toBe(2880 + 24000 + 5600);
    expect(freedStreams).toHaveLength(2);
    expect(recognizerConfigs[0]).toMatchObject({
      decodingMethod: "modified_beam_search",
      blankPenalty: -0.05,
    });
    expect(posted.find((p) => (p as { id?: string }).id === "long-1")).toEqual(
      expect.objectContaining({ type: "result", text: "con mèo ngủ" }),
    );

    // 3. Pure 0.5s all-zero silence (and low-level silent hum with voicedDurationMs=0)
    //    MUST short-circuit to "" before invoking Sherpa decode() (never hallucinate "vâng")!
    await onmessage({
      data: {
        type: "transcribe",
        id: "silence-zeros",
        samples: new Float32Array(8000),
        sampleRate: 16000,
        voicedDurationMs: 0,
      },
    });
    await onmessage({
      data: {
        type: "transcribe",
        id: "silence-dc",
        samples: new Float32Array(8000).fill(0.02),
        sampleRate: 16000,
      },
    });
    expect(acceptedLengths).toHaveLength(2);
    expect(freedStreams).toHaveLength(2);
    expect(
      posted.find((p) => (p as { id?: string }).id === "silence-zeros"),
    ).toEqual(
      expect.objectContaining({ type: "result", text: "", decodeMs: 0 }),
    );
    expect(
      posted.find((p) => (p as { id?: string }).id === "silence-dc"),
    ).toEqual(
      expect.objectContaining({ type: "result", text: "", decodeMs: 0 }),
    );

    // Worker source must never inject expected book text into OfflineRecognizer
    expect(workerSrc).not.toContain("hotwords");
    expect(workerSrc).not.toContain("keyterms");

    await onmessage({ data: { type: "dispose", id: "d1" } });
    expect(recognizerFreed).toBe(true);
  });

  it("wires WASM STT into LocalSegmentSpeechRecognition under local_only outage & recovers to local_offline", async () => {
    class MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      static instances: MockWorker[] = [];
      constructor() {
        MockWorker.instances.push(this);
      }
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
                text: "con mèo",
                decodeMs: 25,
              },
            } as MessageEvent);
          }
        });
      }
      terminate() {}
    }

    vi.stubGlobal("Worker", MockWorker);
    if (!globalThis.crypto?.subtle) {
      vi.stubGlobal("crypto", { subtle: { digest: vi.fn() } });
    }
    expect(detectBrowserWasmSttSupport().supported).toBe(true);

    // Local worker offline, default local_only policy -> uses Browser WASM STT instead of Google
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
    const transcribe = vi.fn();
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "s-wasm", pageId: "p-1" }),
    );
    const results: string[] = [];
    rec.onresult = (ev) => {
      const item = ev.results[ev.resultIndex];
      if (item.isFinal) results.push(item[0].transcript);
    };
    rec.start();
    expect(getVoiceEngineStatus().stt.tier).toBe("browser_wasm");

    const internal = rec as unknown as {
      active: boolean;
      consumeSamples16k: (chunk: Float32Array) => void;
    };
    internal.active = true;
    for (let i = 0; i < 10; i += 1)
      internal.consumeSamples16k(new Float32Array(640).fill(0.05));
    for (let i = 0; i < 20; i += 1)
      internal.consumeSamples16k(new Float32Array(640).fill(0));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(transcribe).not.toHaveBeenCalled();
    expect(results).toEqual(["con mèo"]);
    rec.stop();

    // Verify BrowserWasmSttClient can also be tested cleanly directly
    const client = getBrowserWasmSttClient();
    const direct = await client.transcribeSamples(
      new Float32Array(1600).fill(0.1),
    );
    expect(direct.text).toBe("con mèo");
    expect(new BrowserWasmSttClient()).toBeInstanceOf(BrowserWasmSttClient);

    // Now local :8010 recovers -> switches back to local_offline automatically
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
    const rec2 = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "s-wasm-2", pageId: "p-1" }),
    );
    rec2.start();
    expect(getVoiceEngineStatus().stt.tier).toBe("local_offline");
    rec2.abort();
  });

  it("caches CATALOG/COACHING TTS in 50MB LRU IndexedDB gated on X-TTS-Scope (decoupled from Cache-Control: no-store) and NEVER persists PRIVATE", async () => {
    expect(shouldPersistTtsCacheEntry({ scope: "CATALOG" })).toBe(true);
    expect(shouldPersistTtsCacheEntry({ scope: "COACHING" })).toBe(true);
    expect(shouldPersistTtsCacheEntry({ scope: "PRIVATE" })).toBe(false);
    expect(shouldPersistTtsCacheEntry({ scope: undefined })).toBe(false);
    expect(
      shouldPersistTtsCacheEntry({ scope: "CATALOG", isPrivateBook: true }),
    ).toBe(false);
    // Decoupled from HTTP Cache-Control: no-store when explicitly scoped CATALOG/COACHING
    expect(
      shouldPersistTtsCacheEntry({
        scope: "CATALOG",
        cacheControl: "no-store, max-age=0",
      }),
    ).toBe(true);
    expect(
      shouldPersistTtsCacheEntry({
        scope: "PRIVATE",
        cacheControl: "no-store, max-age=0",
      }),
    ).toBe(false);

    // First CATALOG fetch hits backend (even with Cache-Control: no-store) & caches in IndexedDB
    fetchMock.mockResolvedValueOnce(
      new Response("catalog-mp3", {
        headers: {
          "content-type": "audio/mpeg",
          "cache-control": "no-store",
          "x-tts-scope": "CATALOG",
        },
      }),
    );
    const service = createSpeechService();
    const first = await service.synthesize("Con mèo", {
      bookId: "book-1",
      pageId: "page-1",
      cacheScope: "CATALOG",
      isPrivateBook: false,
    });
    expect(await first.text()).toBe("catalog-mp3");
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Second CATALOG request serves directly from IndexedDB with ZERO network calls
    const second = await service.synthesize("Con mèo", {
      bookId: "book-1",
      pageId: "page-1",
      cacheScope: "CATALOG",
      isPrivateBook: false,
    });
    expect(await second.text()).toBe("catalog-mp3");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getVoiceEngineStatus().tts.tier).toBe("local_offline");

    // PRIVATE book clip MUST never hit or populate IndexedDB
    fetchMock.mockResolvedValueOnce(
      new Response("private-mp3", {
        headers: {
          "content-type": "audio/mpeg",
          "x-tts-scope": "PRIVATE",
        },
      }),
    );
    const priv = await service.synthesize("Sách riêng", {
      cacheScope: "PRIVATE",
      isPrivateBook: true,
    });
    expect(await priv.text()).toBe("private-mp3");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const statsAfterPrivate = await getBrowserTtsCacheStats();
    expect(statsAfterPrivate.entryCount).toBe(1);

    // LRU eviction respects 50 MB ceiling
    const bigHalfQuota = new Blob([new Uint8Array(26 * 1024 * 1024)], {
      type: "audio/mpeg",
    });
    const k1 = buildTtsBrowserCacheKey({
      kind: "short",
      textOrTokens: "clip-1",
      voiceId: "v1",
      modelVersion: "m1",
      speed: 1,
      scope: "CATALOG",
    });
    const k2 = buildTtsBrowserCacheKey({
      kind: "short",
      textOrTokens: "clip-2",
      voiceId: "v1",
      modelVersion: "m1",
      speed: 1,
      scope: "CATALOG",
    });
    expect(
      await putCachedTtsAudio({
        key: k1,
        audio: bigHalfQuota,
        scope: "CATALOG",
      }),
    ).toBe(true);
    expect(
      await putCachedTtsAudio({
        key: k2,
        audio: bigHalfQuota,
        scope: "CATALOG",
      }),
    ).toBe(true);
    expect(await getCachedTtsAudio(k1)).toBeNull();
    expect(await getCachedTtsAudio(k2)).not.toBeNull();
    const finalStats = await getBrowserTtsCacheStats();
    expect(finalStats.usedBytes).toBeLessThanOrEqual(
      MAX_BROWSER_TTS_CACHE_BYTES,
    );
  });

  it("persists and restores X-TTS-Cached-Speed across IndexedDB cache hits", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("cached-1p00-word", {
        headers: {
          "content-type": "audio/mpeg",
          "cache-control": "private, max-age=86400",
          "x-tts-cache": "HIT",
          "x-tts-provider": "precomputed_cache",
          "x-tts-scope": "CATALOG",
          "x-tts-cached-speed": "1.00",
        },
      }),
    );

    const service1 = createSpeechService();
    const first = await service1.synthesize("mèo", {
      speed: 0.9,
      wordSample: true,
      bookId: "book-1",
      pageId: "page-1",
      cacheScope: "CATALOG",
      isPrivateBook: false,
    });
    expect(getSynthesizedAudioMeta(first)?.cachedSpeed).toBe(1.0);
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Simulate reload with a fresh SpeechService instance hitting IndexedDB directly
    const service2 = createSpeechService();
    const second = await service2.synthesize("mèo", {
      speed: 0.9,
      wordSample: true,
      bookId: "book-1",
      pageId: "page-1",
      cacheScope: "CATALOG",
      isPrivateBook: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await second.text()).toBe("cached-1p00-word");
    expect(getSynthesizedAudioMeta(second)?.cachedSpeed).toBe(1.0);
  });
});
