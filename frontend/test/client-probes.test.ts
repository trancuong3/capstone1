import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearBrowserTtsCache,
  clearBrowserTtsCacheForTests,
  getBrowserTtsCacheStats,
  MAX_BROWSER_TTS_CACHE_BYTES,
} from "@/lib/reading/tts-audio-cache";
import {
  clearWasmModelCache,
  detectBrowserWasmSttSupport,
  getWasmModelCacheStatus,
  SHERPA_WASM_MODEL_BYTES,
  SHERPA_WASM_MODEL_ID,
} from "@/lib/reading/browser-wasm-stt";

interface FakeCursor {
  readonly value: unknown;
  continue: () => void;
}

function makeCursorRequest(values: unknown[]) {
  const req: {
    result: FakeCursor | null;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
  } = {
    result: null,
    onsuccess: null,
    onerror: null,
  };
  let index = 0;
  const emitNext = () => {
    queueMicrotask(() => {
      if (index >= values.length) {
        req.result = null;
        req.onsuccess?.();
        return;
      }
      const value = values[index];
      index += 1;
      req.result = {
        value,
        continue: emitNext,
      };
      req.onsuccess?.();
    });
  };
  emitNext();
  return req;
}

describe("Client IndexedDB probes (tts-audio-cache & browser-wasm-stt)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("tts-audio-cache cursor stats, timeout/blocked guards, and clearBrowserTtsCache", () => {
    it("walks openCursor() without calling entries.getAll() and guards non-finite/negative byteSize", async () => {
      const closeSpy = vi.fn();
      const getAllSpy = vi.fn(() => {
        throw new Error("getAll must never be called when openCursor exists");
      });
      const entries = [
        { key: "k1", byteSize: 1024, buffer: new ArrayBuffer(1024) },
        { key: "k2", byteSize: Number.NaN, buffer: new ArrayBuffer(999) },
        { key: "k3", byteSize: Number.POSITIVE_INFINITY },
        { key: "k4", byteSize: -500 },
        { key: "k5", byteSize: 2048 },
        { key: "k6", buffer: new ArrayBuffer(512) },
      ];

      vi.stubGlobal("indexedDB", {
        open: () => {
          const openReq: {
            result: unknown;
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
            onblocked: (() => void) | null;
            onupgradeneeded: (() => void) | null;
          } = {
            result: {
              // Simulate legacy v1 store without `meta` store to verify zero entries.getAll() OOM spike.
              objectStoreNames: {
                contains: (name: string) => name === "entries",
              },
              close: closeSpy,
              transaction: () => ({
                oncomplete: null,
                onerror: null,
                onabort: null,
                objectStore: () => ({
                  openCursor: () => makeCursorRequest(entries),
                  getAll: getAllSpy,
                }),
              }),
            },
            onsuccess: null,
            onerror: null,
            onblocked: null,
            onupgradeneeded: null,
          };
          queueMicrotask(() => openReq.onsuccess?.());
          return openReq;
        },
      });

      const stats = await getBrowserTtsCacheStats();
      expect(getAllSpy).not.toHaveBeenCalled();
      expect(stats).toMatchObject({
        supported: true,
        entryCount: 6,
        usedBytes: 1024 + 0 + 0 + 0 + 2048 + 512,
        quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
        error: null,
      });
      expect(typeof stats.hits).toBe("number");
      expect(typeof stats.misses).toBe("number");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it("distinguishes legitimately empty cache from IndexedDB open error / onblocked / tx.onabort / timeout", async () => {
      // 1. Legitimately empty cache
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: {
            result: unknown;
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
            onblocked: (() => void) | null;
          } = {
            result: {
              objectStoreNames: { contains: (n: string) => n === "meta" },
              close: vi.fn(),
              transaction: () => ({
                onerror: null,
                onabort: null,
                objectStore: () => ({
                  openCursor: () => makeCursorRequest([]),
                }),
              }),
            },
            onsuccess: null,
            onerror: null,
            onblocked: null,
          };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        },
      });
      const emptyStats = await getBrowserTtsCacheStats();
      expect(emptyStats).toMatchObject({
        supported: true,
        entryCount: 0,
        usedBytes: 0,
        error: null,
      });

      // 2. req.onblocked
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: {
            onblocked: (() => void) | null;
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
          } = { onblocked: null, onsuccess: null, onerror: null };
          queueMicrotask(() => req.onblocked?.());
          return req;
        },
      });
      const blockedStats = await getBrowserTtsCacheStats();
      expect(blockedStats).toMatchObject({
        supported: false,
        entryCount: 0,
        usedBytes: 0,
        error: "INDEXEDDB_BLOCKED",
      });

      // 3. tx.onabort
      const abortCloseSpy = vi.fn();
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: {
            result: unknown;
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
            onblocked: (() => void) | null;
          } = {
            result: {
              objectStoreNames: { contains: (n: string) => n === "meta" },
              close: abortCloseSpy,
              transaction: () => {
                const tx: {
                  onabort: (() => void) | null;
                  onerror: (() => void) | null;
                  objectStore: () => Record<string, unknown>;
                } = {
                  onabort: null,
                  onerror: null,
                  objectStore: () => ({
                    openCursor: () => {
                      queueMicrotask(() => tx.onabort?.());
                      return { onsuccess: null, onerror: null };
                    },
                  }),
                };
                return tx;
              },
            },
            onsuccess: null,
            onerror: null,
            onblocked: null,
          };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        },
      });
      const abortedStats = await getBrowserTtsCacheStats();
      expect(abortedStats).toMatchObject({
        supported: false,
        error: "INDEXEDDB_TRANSACTION_ABORTED",
      });
      expect(abortCloseSpy).toHaveBeenCalledTimes(1);

      // 4. 4000ms open timeout + late onsuccess closes leaked DB handle
      vi.useFakeTimers();
      const lateCloseSpy = vi.fn();
      let openReqRef: {
        result: unknown;
        onsuccess: (() => void) | null;
      } | null = null;
      vi.stubGlobal("indexedDB", {
        open: () => {
          openReqRef = {
            result: { close: lateCloseSpy },
            onsuccess: null,
          };
          return openReqRef;
        },
      });
      const timedOutPromise = getBrowserTtsCacheStats();
      await vi.advanceTimersByTimeAsync(4_000);
      const timedOutStats = await timedOutPromise;
      expect(timedOutStats).toMatchObject({
        supported: false,
        error: "INDEXEDDB_TIMEOUT",
      });
      openReqRef!.onsuccess?.();
      expect(lateCloseSpy).toHaveBeenCalledTimes(1);
    });

    it("clears both entries and meta stores via clearBrowserTtsCache() and keeps clearBrowserTtsCacheForTests alias", async () => {
      const clearedStores: string[] = [];
      const closeSpy = vi.fn();
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: {
            result: unknown;
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
            onblocked: (() => void) | null;
          } = {
            result: {
              objectStoreNames: {
                contains: (name: string) =>
                  name === "entries" || name === "meta",
              },
              close: closeSpy,
              transaction: () => {
                const tx: {
                  oncomplete: (() => void) | null;
                  onerror: (() => void) | null;
                  onabort: (() => void) | null;
                  objectStore: (name: string) => {
                    clear: () => Record<string, unknown>;
                  };
                } = {
                  oncomplete: null,
                  onerror: null,
                  onabort: null,
                  objectStore: (name: string) => ({
                    clear: () => {
                      clearedStores.push(name);
                      if (name === "meta") {
                        queueMicrotask(() => tx.oncomplete?.());
                      }
                      return { onerror: null };
                    },
                  }),
                };
                return tx;
              },
            },
            onsuccess: null,
            onerror: null,
            onblocked: null,
          };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        },
      });

      await expect(clearBrowserTtsCache()).resolves.toBe(true);
      expect(clearedStores).toEqual(["entries", "meta"]);
      expect(closeSpy).toHaveBeenCalledTimes(1);

      clearedStores.length = 0;
      await expect(clearBrowserTtsCacheForTests()).resolves.toBeUndefined();
      expect(clearedStores).toEqual(["entries", "meta"]);

      // Blocked clear resolves false without hanging
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: { onblocked: (() => void) | null } = { onblocked: null };
          queueMicrotask(() => req.onblocked?.());
          return req;
        },
      });
      await expect(clearBrowserTtsCache()).resolves.toBe(false);
    });
  });

  describe("browser-wasm-stt capability probe, IDB hang protection, and clearWasmModelCache", () => {
    it("exposes reason, indexedDb, and isSecureContext in detectBrowserWasmSttSupport()", () => {
      vi.stubGlobal("Worker", class MockWorker {});
      vi.stubGlobal("indexedDB", {});
      vi.stubGlobal("isSecureContext", true);
      vi.stubGlobal("crypto", { subtle: { digest: vi.fn() } });

      const readyCaps = detectBrowserWasmSttSupport();
      expect(readyCaps).toMatchObject({
        supported: true,
        worker: true,
        wasm: true,
        indexedDb: true,
        subtleCrypto: true,
        isSecureContext: true,
        reason: null,
      });

      vi.stubGlobal("Worker", undefined);
      vi.stubGlobal("indexedDB", undefined);
      vi.stubGlobal("isSecureContext", false);
      const unsupportedCaps = detectBrowserWasmSttSupport();
      expect(unsupportedCaps.supported).toBe(false);
      expect(unsupportedCaps.indexedDb).toBe(false);
      expect(unsupportedCaps.isSecureContext).toBe(false);
      expect(unsupportedCaps.reason).toBeTruthy();
    });

    it("guards getWasmModelCacheStatus() against req.onblocked, tx.onerror, and 4000ms IDB hang", async () => {
      // 1. req.onblocked
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: { onblocked: (() => void) | null } = { onblocked: null };
          queueMicrotask(() => req.onblocked?.());
          return req;
        },
      });
      const blocked = await getWasmModelCacheStatus();
      expect(blocked).toMatchObject({
        ready: false,
        cachedFiles: 0,
        expectedFiles: 4,
        cachedBytes: 0,
        totalBytes: SHERPA_WASM_MODEL_BYTES,
        supported: false,
        error: "INDEXEDDB_BLOCKED",
      });

      // 2. tx.onerror
      const errCloseSpy = vi.fn();
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: {
            result: unknown;
            onsuccess: (() => void) | null;
          } = {
            result: {
              objectStoreNames: { contains: () => true },
              close: errCloseSpy,
              transaction: () => {
                const tx: {
                  onabort: (() => void) | null;
                  onerror: (() => void) | null;
                  objectStore: () => { get: () => Record<string, unknown> };
                } = {
                  onabort: null,
                  onerror: null,
                  objectStore: () => ({
                    get: () => {
                      queueMicrotask(() => tx.onerror?.());
                      return { onsuccess: null, onerror: null };
                    },
                  }),
                };
                return tx;
              },
            },
            onsuccess: null,
          };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        },
      });
      const errored = await getWasmModelCacheStatus();
      expect(errored).toMatchObject({
        ready: false,
        supported: false,
        error: "INDEXEDDB_TRANSACTION_ERROR",
      });
      expect(errCloseSpy).toHaveBeenCalledTimes(1);

      // 3. 4000ms hang timeout resolves cleanly (never hangs Promise.all) and closes late DB handle
      vi.useFakeTimers();
      const lateCloseSpy = vi.fn();
      let openReqRef: {
        result: unknown;
        onsuccess: (() => void) | null;
      } | null = null;
      vi.stubGlobal("indexedDB", {
        open: () => {
          openReqRef = {
            result: { close: lateCloseSpy },
            onsuccess: null,
          };
          return openReqRef;
        },
      });
      const hungPromise = getWasmModelCacheStatus();
      await vi.advanceTimersByTimeAsync(4_000);
      const timedOut = await hungPromise;
      expect(timedOut).toMatchObject({
        ready: false,
        cachedFiles: 0,
        supported: false,
        error: "INDEXEDDB_TIMEOUT",
      });
      openReqRef!.onsuccess?.();
      expect(lateCloseSpy).toHaveBeenCalledTimes(1);
    });

    it("purges cached STT model files via clearWasmModelCache() and handles onblocked/timeout", async () => {
      const files = new Map<string, unknown>([
        [
          `${SHERPA_WASM_MODEL_ID}/encoder.int8.onnx`,
          { byteLength: 27_699_063 },
        ],
      ]);
      const closeSpy = vi.fn();
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: {
            result: unknown;
            onsuccess: (() => void) | null;
          } = {
            result: {
              objectStoreNames: { contains: (n: string) => n === "files" },
              close: closeSpy,
              transaction: () => {
                const tx: {
                  oncomplete: (() => void) | null;
                  onerror: (() => void) | null;
                  onabort: (() => void) | null;
                  objectStore: () => { clear: () => Record<string, unknown> };
                } = {
                  oncomplete: null,
                  onerror: null,
                  onabort: null,
                  objectStore: () => ({
                    clear: () => {
                      files.clear();
                      queueMicrotask(() => tx.oncomplete?.());
                      return { onerror: null };
                    },
                  }),
                };
                return tx;
              },
            },
            onsuccess: null,
          };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        },
      });

      await expect(clearWasmModelCache()).resolves.toBe(true);
      expect(files.size).toBe(0);
      expect(closeSpy).toHaveBeenCalledTimes(1);

      // onblocked returns false
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: { onblocked: (() => void) | null } = { onblocked: null };
          queueMicrotask(() => req.onblocked?.());
          return req;
        },
      });
      await expect(clearWasmModelCache()).resolves.toBe(false);

      // 4000ms timeout returns false
      vi.useFakeTimers();
      vi.stubGlobal("indexedDB", {
        open: () => ({}),
      });
      const clearTimeoutPromise = clearWasmModelCache();
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(clearTimeoutPromise).resolves.toBe(false);
    });
  });
});
