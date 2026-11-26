/**
 * Client wrapper for On-Device Browser WASM Vietnamese STT
 * (`sherpa-onnx-zipformer-vi-30M-int8-2026-02-09` inside `/workers/sherpa-stt-worker.js`).
 */

import { translateMessage } from "@/lib/i18n/formatter";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import { readLocaleCookie } from "@/lib/i18n/persistence";
import type { MessagesDictionary } from "@/lib/i18n/types";
import { getCachedLocaleMessages } from "@/messages/loader";
import { viMessages } from "@/messages/vi";

function resolveRuntimeLocale(): SupportedLocale {
  const cookieLocale = readLocaleCookie();
  if (cookieLocale) return cookieLocale;
  if (typeof document !== "undefined") {
    return normalizeLocale(document.documentElement?.lang) ?? DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

function tSpeechWasm(key: string): string {
  const locale = resolveRuntimeLocale();
  const activeMessages: MessagesDictionary =
    getCachedLocaleMessages(locale) ?? viMessages;
  return translateMessage(activeMessages, viMessages, locale, key);
}

export const SHERPA_WASM_MODEL_ID =
  "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09";
export const SHERPA_WASM_MODEL_BYTES = 33_920_802;
const MODEL_FILE_SPECS = [
  { name: "encoder.int8.onnx", expectedBytes: 27_699_063 },
  { name: "decoder.onnx", expectedBytes: 5_165_084 },
  { name: "joiner.int8.onnx", expectedBytes: 1_033_417 },
  { name: "tokens.txt", expectedBytes: 23_238 },
] as const;
const IDB_NAME = "viread-wasm-models-v1";
const IDB_STORE = "files";
const WASM_IDB_TIMEOUT_MS = 4_000;

export interface WasmSttProgressEvent {
  readonly stage: string;
  readonly file?: string;
  readonly index?: number;
  readonly total?: number;
}

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
  readonly isSecureContext: boolean;
  readonly reason: string | null;
}

export interface WasmModelCacheStatus {
  readonly ready: boolean;
  readonly cachedFiles: number;
  readonly expectedFiles: number;
  readonly cachedBytes: number;
  readonly totalBytes: number;
  readonly supported?: boolean;
  readonly error?: string | null;
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
  const isSecureContext =
    typeof globalThis.isSecureContext === "boolean"
      ? globalThis.isSecureContext
      : hasWindow && typeof window.isSecureContext === "boolean"
        ? window.isSecureContext
        : subtleCrypto;

  if (!hasWindow || !worker || !wasm || !subtleCrypto) {
    return {
      supported: false,
      worker,
      wasm,
      simd,
      indexedDb,
      subtleCrypto,
      isSecureContext,
      reason: !hasWindow
        ? tSpeechWasm("speech.wasm.deviceUnsupported")
        : !worker
          ? tSpeechWasm("speech.wasm.workerUnavailable")
          : !wasm
            ? tSpeechWasm("speech.wasm.wasmUnavailable")
            : tSpeechWasm("speech.wasm.cryptoUnavailable"),
    };
  }
  return {
    supported: true,
    worker,
    wasm,
    simd,
    indexedDb,
    subtleCrypto,
    isSecureContext,
    reason: null,
  };
}

function emptyWasmCacheStatus(
  supported = true,
  error: string | null = null,
): WasmModelCacheStatus {
  return {
    ready: false,
    cachedFiles: 0,
    expectedFiles: MODEL_FILE_SPECS.length,
    cachedBytes: 0,
    totalBytes: SHERPA_WASM_MODEL_BYTES,
    supported,
    error,
  };
}

function safeCloseWasmDb(db: IDBDatabase | null): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Ignore close error
  }
}

export async function getWasmModelCacheStatus(): Promise<WasmModelCacheStatus> {
  if (typeof indexedDB === "undefined") {
    return emptyWasmCacheStatus(false, "INDEXEDDB_UNAVAILABLE");
  }
  return new Promise((resolve) => {
    let settled = false;
    let openedDb: IDBDatabase | null = null;
    const finish = (status: WasmModelCacheStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      safeCloseWasmDb(openedDb);
      openedDb = null;
      resolve(status);
    };
    const timer = setTimeout(
      () => finish(emptyWasmCacheStatus(false, "INDEXEDDB_TIMEOUT")),
      WASM_IDB_TIMEOUT_MS,
    );
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "key" });
        }
      };
      req.onblocked = () =>
        finish(emptyWasmCacheStatus(false, "INDEXEDDB_BLOCKED"));
      req.onerror = () =>
        finish(emptyWasmCacheStatus(false, "INDEXEDDB_OPEN_ERROR"));
      req.onsuccess = () => {
        const db = req.result;
        if (settled) {
          safeCloseWasmDb(db);
          return;
        }
        openedDb = db;
        try {
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            finish(emptyWasmCacheStatus(true, null));
            return;
          }
          const tx = db.transaction(IDB_STORE, "readonly");
          tx.onabort = () =>
            finish(
              emptyWasmCacheStatus(false, "INDEXEDDB_TRANSACTION_ABORTED"),
            );
          tx.onerror = () =>
            finish(emptyWasmCacheStatus(false, "INDEXEDDB_TRANSACTION_ERROR"));
          const store = tx.objectStore(IDB_STORE);
          let cachedFiles = 0;
          let cachedBytes = 0;
          let pending = MODEL_FILE_SPECS.length;
          for (const spec of MODEL_FILE_SPECS) {
            const getReq = store.get(`${SHERPA_WASM_MODEL_ID}/${spec.name}`);
            getReq.onsuccess = () => {
              const rec = getReq.result as
                { byteLength?: number; buffer?: ArrayBuffer } | undefined;
              const rawLen = rec?.buffer?.byteLength ?? rec?.byteLength ?? 0;
              const len =
                typeof rawLen === "number" &&
                Number.isFinite(rawLen) &&
                rawLen > 0
                  ? rawLen
                  : 0;
              if (len === spec.expectedBytes) {
                cachedFiles += 1;
                cachedBytes += len;
              }
              pending -= 1;
              if (pending === 0) {
                finish({
                  ready: cachedFiles === MODEL_FILE_SPECS.length,
                  cachedFiles,
                  expectedFiles: MODEL_FILE_SPECS.length,
                  cachedBytes,
                  totalBytes: SHERPA_WASM_MODEL_BYTES,
                  supported: true,
                  error: null,
                });
              }
            };
            getReq.onerror = () => {
              pending -= 1;
              if (pending === 0) {
                finish({
                  ready: cachedFiles === MODEL_FILE_SPECS.length,
                  cachedFiles,
                  expectedFiles: MODEL_FILE_SPECS.length,
                  cachedBytes,
                  totalBytes: SHERPA_WASM_MODEL_BYTES,
                  supported: true,
                  error: null,
                });
              }
            };
          }
        } catch {
          finish(emptyWasmCacheStatus(false, "INDEXEDDB_TRANSACTION_ERROR"));
        }
      };
    } catch {
      finish(emptyWasmCacheStatus(false, "INDEXEDDB_OPEN_ERROR"));
    }
  });
}

export async function clearWasmModelCache(): Promise<boolean> {
  if (sharedClient) {
    sharedClient.dispose();
    sharedClient = null;
  }
  if (typeof indexedDB === "undefined") {
    return false;
  }
  return new Promise((resolve) => {
    let settled = false;
    let openedDb: IDBDatabase | null = null;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      safeCloseWasmDb(openedDb);
      openedDb = null;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), WASM_IDB_TIMEOUT_MS);
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "key" });
        }
      };
      req.onblocked = () => finish(false);
      req.onerror = () => finish(false);
      req.onsuccess = () => {
        const db = req.result;
        if (settled) {
          safeCloseWasmDb(db);
          return;
        }
        openedDb = db;
        try {
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            finish(true);
            return;
          }
          const tx = db.transaction(IDB_STORE, "readwrite");
          tx.oncomplete = () => finish(true);
          tx.onerror = () => finish(false);
          tx.onabort = () => finish(false);
          const clearReq = tx.objectStore(IDB_STORE).clear();
          clearReq.onerror = () => finish(false);
        } catch {
          finish(false);
        }
      };
    } catch {
      finish(false);
    }
  });
}

function parseWavPcmToFloat32(
  buffer: ArrayBuffer,
): { samples: Float32Array; sampleRate: number } | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 16_000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = tag(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (chunkId === "fmt " && bodyStart + 16 <= buffer.byteLength) {
      audioFormat = view.getUint16(bodyStart, true);
      numChannels = Math.max(1, view.getUint16(bodyStart + 2, true));
      sampleRate = view.getUint32(bodyStart + 4, true) || 16_000;
      bitsPerSample = view.getUint16(bodyStart + 14, true);
    } else if (chunkId === "data") {
      dataOffset = bodyStart;
      dataSize = Math.min(chunkSize, buffer.byteLength - bodyStart);
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) return null;
  if (audioFormat === 1 && bitsPerSample === 16) {
    const frameBytes = numChannels * 2;
    const frameCount = Math.floor(dataSize / frameBytes);
    const samples = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i += 1) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch += 1) {
        const s = view.getInt16(dataOffset + i * frameBytes + ch * 2, true);
        sum += s < 0 ? s / 0x8000 : s / 0x7fff;
      }
      samples[i] = sum / numChannels;
    }
    return { samples, sampleRate };
  }
  if (audioFormat === 3 && bitsPerSample === 32) {
    const frameBytes = numChannels * 4;
    const frameCount = Math.floor(dataSize / frameBytes);
    const samples = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i += 1) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch += 1) {
        sum += view.getFloat32(dataOffset + i * frameBytes + ch * 4, true);
      }
      samples[i] = sum / numChannels;
    }
    return { samples, sampleRate };
  }
  return null;
}

function resampleLinearTo16k(
  samples: Float32Array,
  sampleRate: number,
): Float32Array {
  if (sampleRate === 16_000 || sampleRate <= 0 || samples.length === 0) {
    return samples;
  }
  const ratio = sampleRate / 16_000;
  const outLen = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = samples[Math.min(idx, samples.length - 1)];
    const s1 = samples[Math.min(idx + 1, samples.length - 1)];
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

export async function decodeAudioBlobTo16kFloat32(
  blob: Blob,
): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const parsedWav = parseWavPcmToFloat32(arrayBuffer);
  if (parsedWav) {
    return resampleLinearTo16k(parsedWav.samples, parsedWav.sampleRate);
  }
  const win =
    typeof window !== "undefined"
      ? (window as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
          OfflineAudioContext?: typeof OfflineAudioContext;
        })
      : null;
  const AudioCtx = win?.AudioContext ?? win?.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("AudioContext unavailable to decode recorded audio");
  }
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const length = decoded.length;
    const channels = Math.max(1, decoded.numberOfChannels);
    const mono = new Float32Array(length);
    for (let ch = 0; ch < channels; ch += 1) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < length; i += 1) {
        mono[i] += data[i] / channels;
      }
    }
    if (decoded.sampleRate === 16_000) {
      return mono;
    }
    const OfflineCtx = win?.OfflineAudioContext;
    if (OfflineCtx) {
      try {
        const targetFrames = Math.max(
          1,
          Math.ceil((length * 16_000) / decoded.sampleRate),
        );
        const offline = new OfflineCtx(1, targetFrames, 16_000);
        const buffer = offline.createBuffer(1, length, decoded.sampleRate);
        buffer.copyToChannel(mono, 0);
        const src = offline.createBufferSource();
        src.buffer = buffer;
        src.connect(offline.destination);
        src.start(0);
        const rendered = await offline.startRendering();
        return new Float32Array(rendered.getChannelData(0));
      } catch {
        return resampleLinearTo16k(mono, decoded.sampleRate);
      }
    }
    return resampleLinearTo16k(mono, decoded.sampleRate);
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

function raceWithSignalAndTimeout<T>(
  promise: Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    timeoutMessage?: string;
  },
): Promise<T> {
  const {
    signal,
    timeoutMs,
    timeoutMessage = "WASM STT request timed out",
  } = options;
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  if (!signal && (timeoutMs === undefined || timeoutMs <= 0)) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer =
      timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(timeoutMessage));
          }, timeoutMs)
        : null;
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
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
  private readonly progressListeners = new Set<
    (event: WasmSttProgressEvent) => void
  >();

  subscribeProgress(
    listener: (event: WasmSttProgressEvent) => void,
  ): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const caps = detectBrowserWasmSttSupport();
    if (!caps.supported) {
      throw new Error(
        caps.reason ?? tSpeechWasm("speech.wasm.deviceUnsupported"),
      );
    }
    const worker = new Worker("/workers/sherpa-stt-worker.js");
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        id?: string;
        text?: string;
        decodeMs?: number;
        message?: string;
        stage?: string;
        file?: string;
        index?: number;
        total?: number;
      };
      if (!msg) return;
      if (msg.type === "progress") {
        const progressEvent: WasmSttProgressEvent = {
          stage: msg.stage ?? "loading-model",
          file: msg.file,
          index: msg.index,
          total: msg.total,
        };
        for (const listener of this.progressListeners) {
          try {
            listener(progressEvent);
          } catch {
            // Ignore listener errors
          }
        }
        return;
      }
      if (!msg.id) return;
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

  async init(
    signal?: AbortSignal,
    options: {
      timeoutMs?: number;
      onProgress?: (event: WasmSttProgressEvent) => void;
    } = {},
  ): Promise<void> {
    const unsubscribe = options.onProgress
      ? this.subscribeProgress(options.onProgress)
      : null;
    try {
      if (!this.readyPromise) {
        // Keep shared init independent of individual caller aborts so a TTS pause
        // never cancels an in-flight 34MB model download for the next utterance.
        this.readyPromise = this.postRequest<void>(
          { type: "init" },
          [],
          90_000,
        ).catch((err) => {
          this.readyPromise = null;
          throw err;
        });
      }
      await raceWithSignalAndTimeout(this.readyPromise, {
        signal,
        timeoutMs: options.timeoutMs,
      });
    } finally {
      unsubscribe?.();
    }
  }

  async transcribeSamples(
    samples16k: Float32Array,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      sampleRate?: number;
      voicedDurationMs?: number;
      onProgress?: (event: WasmSttProgressEvent) => void;
    } = {},
  ): Promise<BrowserWasmDecodeResult> {
    const totalTimeoutMs = options.timeoutMs ?? 15_000;
    const deadline = Date.now() + totalTimeoutMs;
    await this.init(options.signal, {
      timeoutMs: totalTimeoutMs,
      onProgress: options.onProgress,
    });
    const remainingMs = Math.max(100, deadline - Date.now());
    const copy = new Float32Array(samples16k);
    return this.postRequest<BrowserWasmDecodeResult>(
      {
        type: "transcribe",
        samples: copy,
        sampleRate: options.sampleRate ?? 16_000,
        ...(typeof options.voicedDurationMs === "number" &&
        Number.isFinite(options.voicedDurationMs)
          ? { voicedDurationMs: options.voicedDurationMs }
          : {}),
      },
      [copy.buffer],
      remainingMs,
      options.signal,
    );
  }

  async transcribeBlob(
    audio: Blob,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      voicedDurationMs?: number;
      onProgress?: (event: WasmSttProgressEvent) => void;
    } = {},
  ): Promise<BrowserWasmDecodeResult> {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const samples16k = await decodeAudioBlobTo16kFloat32(audio);
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    return this.transcribeSamples(samples16k, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      sampleRate: 16_000,
      voicedDurationMs: options.voicedDurationMs,
      onProgress: options.onProgress,
    });
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
