/**
 * Client wrapper for On-Device Browser WASM Vietnamese STT
 * (`sherpa-onnx-zipformer-vi-30M-int8-2026-02-09` inside `/workers/sherpa-stt-worker.js`).
 */

export const SHERPA_WASM_MODEL_ID =
  "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09";
export const SHERPA_WASM_MODEL_BYTES = 33_920_802;
const MODEL_FILES = [
  "encoder.int8.onnx",
  "decoder.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
] as const;
const IDB_NAME = "viread-wasm-models-v1";
const IDB_STORE = "files";

// Minimal WebAssembly module using v128 + i32x4.splat to probe SIMD support
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
]);

export interface BrowserWasmCapabilities {
  readonly supported: boolean;
  readonly worker: boolean;
  readonly wasm: boolean;
  readonly simd: boolean;
  readonly indexedDb: boolean;
  readonly subtleCrypto: boolean;
  readonly reason: string | null;
}

export interface WasmModelCacheStatus {
  readonly ready: boolean;
  readonly cachedFiles: number;
  readonly expectedFiles: number;
  readonly cachedBytes: number;
  readonly totalBytes: number;
}

export interface BrowserWasmDecodeResult {
  readonly text: string;
  readonly decodeMs: number;
}

export function detectBrowserWasmSttSupport(): BrowserWasmCapabilities {
  const hasWindow = typeof window !== "undefined";
  const worker = typeof Worker === "function";
  const wasm = typeof WebAssembly === "object" && WebAssembly !== null;
  let simd = false;
  if (wasm && typeof WebAssembly.validate === "function") {
    try {
      simd = WebAssembly.validate(WASM_SIMD_PROBE);
    } catch {
      simd = false;
    }
  }
  const indexedDb = typeof indexedDB !== "undefined";
  const subtleCrypto = Boolean(globalThis.crypto?.subtle?.digest);

  if (!hasWindow || !worker || !wasm || !subtleCrypto) {
    return {
      supported: false,
      worker,
      wasm,
      simd,
      indexedDb,
      subtleCrypto,
      reason: !worker
        ? "Web Worker không khả dụng"
        : !wasm
          ? "WebAssembly không khả dụng"
          : "Web Crypto API không khả dụng",
    };
  }
  return {
    supported: true,
    worker,
    wasm,
    simd,
    indexedDb,
    subtleCrypto,
    reason: null,
  };
}

export async function getWasmModelCacheStatus(): Promise<WasmModelCacheStatus> {
  if (typeof indexedDB === "undefined") {
    return {
      ready: false,
      cachedFiles: 0,
      expectedFiles: MODEL_FILES.length,
      cachedBytes: 0,
      totalBytes: SHERPA_WASM_MODEL_BYTES,
    };
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        let settled = false;
        const finish = (status: WasmModelCacheStatus) => {
          if (settled) return;
          settled = true;
          try {
            db.close();
          } catch {
            // Ignore close error
          }
          resolve(status);
        };
        const emptyStatus: WasmModelCacheStatus = {
          ready: false,
          cachedFiles: 0,
          expectedFiles: MODEL_FILES.length,
          cachedBytes: 0,
          totalBytes: SHERPA_WASM_MODEL_BYTES,
        };
        try {
          const tx = db.transaction(IDB_STORE, "readonly");
          tx.onabort = () => finish(emptyStatus);
          tx.onerror = () => finish(emptyStatus);
          const store = tx.objectStore(IDB_STORE);
          let cachedFiles = 0;
          let cachedBytes = 0;
          let pending = MODEL_FILES.length;
          for (const fname of MODEL_FILES) {
            const getReq = store.get(`${SHERPA_WASM_MODEL_ID}/${fname}`);
            getReq.onsuccess = () => {
              const rec = getReq.result as
                { byteLength?: number; buffer?: ArrayBuffer } | undefined;
              const len = rec?.byteLength ?? rec?.buffer?.byteLength ?? 0;
              if (len > 0) {
                cachedFiles += 1;
                cachedBytes += len;
              }
              pending -= 1;
              if (pending === 0) {
                finish({
                  ready: cachedFiles === MODEL_FILES.length,
                  cachedFiles,
                  expectedFiles: MODEL_FILES.length,
                  cachedBytes,
                  totalBytes: SHERPA_WASM_MODEL_BYTES,
                });
              }
            };
            getReq.onerror = () => {
              pending -= 1;
              if (pending === 0) {
                finish({
                  ready: cachedFiles === MODEL_FILES.length,
                  cachedFiles,
                  expectedFiles: MODEL_FILES.length,
                  cachedBytes,
                  totalBytes: SHERPA_WASM_MODEL_BYTES,
                });
              }
            };
          }
        } catch {
          finish(emptyStatus);
        }
      };
      req.onerror = () =>
        resolve({
          ready: false,
          cachedFiles: 0,
          expectedFiles: MODEL_FILES.length,
          cachedBytes: 0,
          totalBytes: SHERPA_WASM_MODEL_BYTES,
        });
    } catch {
      resolve({
        ready: false,
        cachedFiles: 0,
        expectedFiles: MODEL_FILES.length,
        cachedBytes: 0,
        totalBytes: SHERPA_WASM_MODEL_BYTES,
      });
    }
  });
}

interface PendingJob {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanup?: () => void;
}

export class BrowserWasmSttClient {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private reqCounter = 0;
  private readonly pending = new Map<string, PendingJob>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const caps = detectBrowserWasmSttSupport();
    if (!caps.supported) {
      throw new Error(caps.reason ?? "WASM STT không khả dụng trên thiết bị.");
    }
    const worker = new Worker("/workers/sherpa-stt-worker.js");
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        id?: string;
        text?: string;
        decodeMs?: number;
        message?: string;
      };
      if (!msg || !msg.id) return;
      const job = this.pending.get(msg.id);
      if (!job) return;
      this.pending.delete(msg.id);
      clearTimeout(job.timer);
      job.cleanup?.();
      if (msg.type === "error") {
        job.reject(new Error(msg.message ?? "WASM STT failed"));
      } else if (msg.type === "result") {
        job.resolve({
          text: msg.text ?? "",
          decodeMs: msg.decodeMs ?? 0,
        } satisfies BrowserWasmDecodeResult);
      } else {
        job.resolve(undefined);
      }
    };
    worker.onerror = (err) => {
      const failure = new Error(err.message || "WASM STT worker crashed");
      try {
        worker.terminate();
      } catch {
        // Ignore terminate failure on already-dead worker
      }
      if (this.worker === worker) {
        this.worker = null;
      }
      this.readyPromise = null;
      this.failAllPending(failure);
    };
    this.worker = worker;
    return worker;
  }

  private failAllPending(error: unknown): void {
    for (const [id, job] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(job.timer);
      job.cleanup?.();
      job.reject(error);
    }
  }

  private postRequest<T>(
    payload: Record<string, unknown>,
    transfer: Transferable[] = [],
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    const worker = this.ensureWorker();
    const id = `wasm_${++this.reqCounter}`;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        try {
          worker.postMessage({ type: "cancel", id });
        } catch {
          // Ignore cancel on dead worker
        }
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        try {
          worker.postMessage({ type: "cancel", id });
        } catch {
          // Ignore cancel on dead worker
        }
        if (payload.type === "init" && this.worker === worker) {
          this.worker = null;
          this.readyPromise = null;
          try {
            worker.postMessage({ type: "dispose", id: "init_timeout_dispose" });
          } catch {
            // Ignore
          }
          try {
            worker.terminate();
          } catch {
            // Ignore
          }
        }
        reject(new Error("WASM STT request timed out"));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      worker.postMessage({ ...payload, id }, transfer);
    });
  }

  async init(signal?: AbortSignal): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.postRequest<void>(
      { type: "init" },
      [],
      90_000,
      signal,
    ).catch((err) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  async transcribeSamples(
    samples16k: Float32Array,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<BrowserWasmDecodeResult> {
    await this.init(options.signal);
    const copy = new Float32Array(samples16k);
    return this.postRequest<BrowserWasmDecodeResult>(
      { type: "transcribe", samples: copy, sampleRate: 16_000 },
      [copy.buffer],
      options.timeoutMs ?? 15_000,
      options.signal,
    );
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    this.failAllPending(new DOMException("Disposed", "AbortError"));
    if (worker) {
      try {
        worker.postMessage({ type: "dispose", id: "dispose" });
      } catch {
        // Ignore
      }
      worker.terminate();
    }
  }
}

let sharedClient: BrowserWasmSttClient | null = null;

export function getBrowserWasmSttClient(): BrowserWasmSttClient {
  if (!sharedClient) {
    sharedClient = new BrowserWasmSttClient();
  }
  return sharedClient;
}

export function resetBrowserWasmSttForTests(): void {
  if (sharedClient) {
    sharedClient.dispose();
    sharedClient = null;
  }
}
