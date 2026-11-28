/**
 * Client wrapper for On-Device Browser WASM Vietnamese Neural TTS
 * (`sherpa-onnx` + `piper-phonemize` inside `/workers/sherpa-tts-worker.js`).
 *
 * Female: csukuangfj/vits-piper-vi_VN-vais1000-medium (median F0 ~235 Hz, 6 tones preserved)
 * Male:   vnhellboy/vietnamese-piper-voices diemdam-medium (median F0 ~143 Hz, 6 tones preserved)
 */

import type { VoiceRegion } from "@/lib/reading/session-voice-lock";
import type { VoiceGender } from "@/lib/reading/voice-persona";

export const SHERPA_WASM_TTS_MODEL_IDS: Record<VoiceGender, string> = {
  female: "vits-piper-vi_VN-vais1000-medium",
  male: "vits-piper-vi_VN-diemdam-medium",
};

const MODEL_MANIFEST_KEYS: Record<VoiceGender, readonly string[]> = {
  female: [
    "vits-piper-vi_VN-vais1000-medium/model.onnx",
    "vits-piper-vi_VN-vais1000-medium/tokens.txt",
  ],
  male: [
    "vits-piper-vi_VN-diemdam-medium/model.onnx",
    "vits-piper-vi_VN-diemdam-medium/tokens.txt",
  ],
};

const EXPECTED_MODEL_BYTES: Record<VoiceGender, number> = {
  female: 63_202_346,
  male: 63_517_150,
};

const ESPEAK_EXPECTED_BYTES = 867_182;
const IDB_NAME = "viread-wasm-tts-v1";
const IDB_STORE = "files";
const WASM_IDB_TIMEOUT_MS = 4_000;

const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
]);

export interface WasmTtsProgressEvent {
  readonly stage: string;
  readonly gender?: VoiceGender;
  readonly file?: string;
  readonly index?: number;
  readonly total?: number;
}

export interface BrowserWasmTtsCapabilities {
  readonly supported: boolean;
  readonly worker: boolean;
  readonly wasm: boolean;
  readonly simd: boolean;
  readonly indexedDb: boolean;
  readonly subtleCrypto: boolean;
}

export interface WasmTtsCacheStatus {
  readonly ready: boolean;
  readonly gender: VoiceGender;
  readonly cachedBytes: number;
  readonly totalBytes: number;
}

export interface BrowserWasmSynthesizeResult {
  readonly wavBuffer: ArrayBuffer;
  readonly sampleRate: number;
  readonly durationSeconds: number;
  readonly gender: VoiceGender;
  readonly synthMs: number;
}

export interface PhonicsStepTiming {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
}

export interface BrowserWasmPhonicsResult extends BrowserWasmSynthesizeResult {
  readonly stepTimings: readonly PhonicsStepTiming[];
}

export function normalizePhonicsSpeechTextForTts(rawText: string): string {
  const cleaned = rawText
    .normalize("NFC")
    .replace(/\s*(?:→|=>|->|·|—|\+)\s*/g, ", ")
    .replace(/\s*[,;]+\s*[,;]+\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || rawText.trim();
}

export function detectBrowserWasmTtsSupport(): BrowserWasmTtsCapabilities {
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

  return {
    supported: Boolean(hasWindow && worker && wasm && subtleCrypto),
    worker,
    wasm,
    simd,
    indexedDb,
    subtleCrypto,
  };
}

export async function getWasmTtsCacheStatus(
  gender: VoiceGender = "female",
): Promise<WasmTtsCacheStatus> {
  const caps = detectBrowserWasmTtsSupport();
  const totalBytes = EXPECTED_MODEL_BYTES[gender] + ESPEAK_EXPECTED_BYTES;
  if (!caps.supported || !caps.indexedDb) {
    return { ready: false, gender, cachedBytes: 0, totalBytes };
  }

  return await new Promise<WasmTtsCacheStatus>((resolve) => {
    let settled = false;
    let db: IDBDatabase | null = null;
    const finish = (status: WasmTtsCacheStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        db?.close();
      } catch {
        // Ignore close errors
      }
      resolve(status);
    };
    const timer = setTimeout(
      () => finish({ ready: false, gender, cachedBytes: 0, totalBytes }),
      WASM_IDB_TIMEOUT_MS,
    );

    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(IDB_STORE)) {
          database.createObjectStore(IDB_STORE, { keyPath: "key" });
        }
      };
      req.onerror = () =>
        finish({ ready: false, gender, cachedBytes: 0, totalBytes });
      req.onsuccess = () => {
        db = req.result;
        try {
          const tx = db.transaction(IDB_STORE, "readonly");
          const store = tx.objectStore(IDB_STORE);
          const modelVersion = SHERPA_WASM_TTS_MODEL_IDS[gender];
          const modelManifestReq = store.get(`${modelVersion}/__manifest__`);
          const espeakManifestReq = store.get(
            "espeak-ng-data-vi-v1/__manifest__",
          );
          let modelManifestOk = false;
          let espeakManifestOk = false;
          let remaining = 2;
          const maybeFinish = () => {
            remaining -= 1;
            if (remaining > 0) return;
            const ready = modelManifestOk && espeakManifestOk;
            if (ready) {
              finish({
                ready: true,
                gender,
                cachedBytes: totalBytes,
                totalBytes,
              });
              return;
            }
            // Fallback check for individual entries
            const checks = MODEL_MANIFEST_KEYS[gender].map(
              (k) =>
                new Promise<number>((res) => {
                  const r = store.get(k);
                  r.onsuccess = () => {
                    const val = r.result as
                      | { byteLength?: number; verifiedSha256?: string }
                      | undefined;
                    res(
                      val?.verifiedSha256 && typeof val.byteLength === "number"
                        ? val.byteLength
                        : 0,
                    );
                  };
                  r.onerror = () => res(0);
                }),
            );
            void Promise.all(checks).then((sizes) => {
              const cachedBytes = sizes.reduce((sum, n) => sum + n, 0);
              finish({
                ready: cachedBytes >= EXPECTED_MODEL_BYTES[gender],
                gender,
                cachedBytes,
                totalBytes,
              });
            });
          };
          modelManifestReq.onsuccess = () => {
            const m = modelManifestReq.result as
              { files?: Record<string, { verified?: boolean }> } | undefined;
            modelManifestOk = Boolean(
              m?.files?.["model.onnx"]?.verified &&
              m?.files?.["tokens.txt"]?.verified,
            );
            maybeFinish();
          };
          modelManifestReq.onerror = maybeFinish;
          espeakManifestReq.onsuccess = () => {
            const m = espeakManifestReq.result as
              { files?: Record<string, { verified?: boolean }> } | undefined;
            espeakManifestOk = Boolean(
              m?.files?.phontab?.verified && m?.files?.vi_dict?.verified,
            );
            maybeFinish();
          };
          espeakManifestReq.onerror = maybeFinish;
          tx.onerror = () =>
            finish({ ready: false, gender, cachedBytes: 0, totalBytes });
          tx.onabort = () =>
            finish({ ready: false, gender, cachedBytes: 0, totalBytes });
        } catch {
          finish({ ready: false, gender, cachedBytes: 0, totalBytes });
        }
      };
    } catch {
      finish({ ready: false, gender, cachedBytes: 0, totalBytes });
    }
  });
}

function raceWithSignalAndTimeout<T>(
  promise: Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  const hasTimeout =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0;
  if (!options.signal && !hasTimeout) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (hasTimeout) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("WASM TTS operation timed out"));
      }, options.timeoutMs);
    }
    promise.then(
      (val) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
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

interface PendingTtsJob {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanup?: () => void;
}

export class BrowserWasmTtsClient {
  private worker: Worker | null = null;
  private readonly readyGenders = new Set<VoiceGender>();
  private pendingInit: { gender: VoiceGender; promise: Promise<void> } | null =
    null;
  private reqCounter = 0;
  private readonly pending = new Map<string, PendingTtsJob>();
  private readonly progressListeners = new Set<
    (event: WasmTtsProgressEvent) => void
  >();

  isReady(gender?: VoiceGender): boolean {
    if (!this.worker || this.readyGenders.size === 0) return false;
    if (gender) return this.readyGenders.has(gender);
    return true;
  }

  private syncReadyGenders(
    rawReadyGenders?: readonly VoiceGender[],
    fallbackGender?: VoiceGender,
  ): void {
    if (Array.isArray(rawReadyGenders) && rawReadyGenders.length > 0) {
      this.readyGenders.clear();
      for (const g of rawReadyGenders) {
        if (g === "male" || g === "female") {
          this.readyGenders.add(g);
        }
      }
      return;
    }
    if (fallbackGender === "male" || fallbackGender === "female") {
      this.readyGenders.add(fallbackGender);
    }
  }

  subscribeProgress(
    listener: (event: WasmTtsProgressEvent) => void,
  ): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const caps = detectBrowserWasmTtsSupport();
    if (!caps.supported) {
      throw new Error("Browser WASM TTS is not supported on this device");
    }
    const worker = new Worker("/workers/sherpa-tts-worker.js");
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        id?: string;
        gender?: VoiceGender;
        readyGenders?: readonly VoiceGender[];
        stage?: string;
        file?: string;
        index?: number;
        total?: number;
        sampleRate?: number;
        durationSeconds?: number;
        synthMs?: number;
        stepTimings?: readonly PhonicsStepTiming[];
        wavBuffer?: ArrayBuffer;
        message?: string;
      };
      if (!msg) return;
      if (msg.type === "progress") {
        const progressEvent: WasmTtsProgressEvent = {
          stage: msg.stage ?? "loading-tts-model",
          gender: msg.gender,
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
        job.reject(new Error(msg.message ?? "WASM TTS failed"));
      } else if (msg.type === "phonics_result" && msg.wavBuffer) {
        const resolvedGender: VoiceGender =
          msg.gender === "male" ? "male" : "female";
        this.syncReadyGenders(msg.readyGenders, resolvedGender);
        job.resolve({
          wavBuffer: msg.wavBuffer,
          sampleRate: msg.sampleRate ?? 22050,
          durationSeconds: msg.durationSeconds ?? 0,
          gender: resolvedGender,
          synthMs: msg.synthMs ?? 0,
          stepTimings: Array.isArray(msg.stepTimings) ? msg.stepTimings : [],
        } satisfies BrowserWasmPhonicsResult);
      } else if (msg.type === "result" && msg.wavBuffer) {
        const resolvedGender: VoiceGender =
          msg.gender === "male" ? "male" : "female";
        this.syncReadyGenders(msg.readyGenders, resolvedGender);
        job.resolve({
          wavBuffer: msg.wavBuffer,
          sampleRate: msg.sampleRate ?? 22050,
          durationSeconds: msg.durationSeconds ?? 0,
          gender: resolvedGender,
          synthMs: msg.synthMs ?? 0,
        } satisfies BrowserWasmSynthesizeResult);
      } else {
        if (msg.type === "ready") {
          this.syncReadyGenders(msg.readyGenders, msg.gender);
        }
        job.resolve(msg);
      }
    };
    worker.onerror = (err) => {
      const failure = new Error(err.message || "WASM TTS worker crashed");
      try {
        worker.terminate();
      } catch {
        // Ignore
      }
      if (this.worker === worker) {
        this.worker = null;
      }
      this.readyGenders.clear();
      this.pendingInit = null;
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
    timeoutMs = 20_000,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    const worker = this.ensureWorker();
    const id = `wasm_tts_${++this.reqCounter}`;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        try {
          worker.postMessage({ type: "cancel", id });
        } catch {
          // Ignore
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
          // Ignore
        }
        reject(new Error("WASM TTS request timed out"));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      worker.postMessage({ ...payload, id });
    });
  }

  async init(
    options: {
      gender?: VoiceGender;
      signal?: AbortSignal;
      timeoutMs?: number;
      onProgress?: (event: WasmTtsProgressEvent) => void;
    } = {},
  ): Promise<void> {
    const gender: VoiceGender = options.gender === "male" ? "male" : "female";
    const unsubscribe = options.onProgress
      ? this.subscribeProgress(options.onProgress)
      : null;
    try {
      while (true) {
        if (this.readyGenders.has(gender) && this.worker && !this.pendingInit) {
          return;
        }
        if (this.pendingInit && this.pendingInit.gender !== gender) {
          await raceWithSignalAndTimeout(
            this.pendingInit.promise.catch(() => undefined),
            {
              signal: options.signal,
              timeoutMs: options.timeoutMs,
            },
          );
          continue;
        }
        break;
      }

      if (this.readyGenders.has(gender) && this.worker && !this.pendingInit) {
        return;
      }

      if (!this.pendingInit || this.pendingInit.gender !== gender) {
        const initPromise = this.postRequest<unknown>(
          { type: "init", gender },
          90_000,
        )
          .then((res) => {
            if (this.pendingInit?.promise === initPromise) {
              const readyList = (
                res as { readyGenders?: readonly VoiceGender[] } | undefined
              )?.readyGenders;
              this.syncReadyGenders(readyList, gender);
            }
          })
          .catch((err) => {
            this.readyGenders.delete(gender);
            throw err;
          })
          .finally(() => {
            if (this.pendingInit?.promise === initPromise) {
              this.pendingInit = null;
            }
          });
        this.pendingInit = { gender, promise: initPromise };
      }

      await raceWithSignalAndTimeout(this.pendingInit.promise, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
    } finally {
      unsubscribe?.();
    }
  }

  async synthesize(
    text: string,
    options: {
      gender?: VoiceGender;
      region?: VoiceRegion;
      speed?: number;
      signal?: AbortSignal;
      timeoutMs?: number;
      initTimeoutMs?: number;
      onProgress?: (event: WasmTtsProgressEvent) => void;
    } = {},
  ): Promise<BrowserWasmSynthesizeResult> {
    const gender: VoiceGender = options.gender === "male" ? "male" : "female";
    const synthTimeoutMs = options.timeoutMs ?? 20_000;
    const initTimeoutMs =
      options.initTimeoutMs ?? Math.max(synthTimeoutMs, 60_000);

    await this.init({
      gender,
      signal: options.signal,
      timeoutMs: initTimeoutMs,
      onProgress: options.onProgress,
    });

    const normalizedText = normalizePhonicsSpeechTextForTts(text);
    return this.postRequest<BrowserWasmSynthesizeResult>(
      {
        type: "synthesize",
        text: normalizedText,
        gender,
        region: options.region ?? "north",
        speed: options.speed ?? 1.0,
      },
      synthTimeoutMs,
      options.signal,
    );
  }

  async synthesizePhonics(
    steps: readonly {
      readonly index: number;
      readonly kind?: string;
      readonly spokenText: string;
      readonly pauseAfterMs: number;
    }[],
    options: {
      gender?: VoiceGender;
      region?: VoiceRegion;
      speed?: number;
      signal?: AbortSignal;
      timeoutMs?: number;
      initTimeoutMs?: number;
      onProgress?: (event: WasmTtsProgressEvent) => void;
    } = {},
  ): Promise<BrowserWasmPhonicsResult> {
    const gender: VoiceGender = options.gender === "male" ? "male" : "female";
    const synthTimeoutMs = options.timeoutMs ?? 25_000;
    const initTimeoutMs =
      options.initTimeoutMs ?? Math.max(synthTimeoutMs, 60_000);

    await this.init({
      gender,
      signal: options.signal,
      timeoutMs: initTimeoutMs,
      onProgress: options.onProgress,
    });

    const normalizedSteps = steps.map((step, idx) => ({
      index: typeof step.index === "number" ? step.index : idx,
      kind: step.kind ?? "step",
      spokenText: normalizePhonicsSpeechTextForTts(step.spokenText),
      pauseAfterMs: step.pauseAfterMs,
    }));

    return this.postRequest<BrowserWasmPhonicsResult>(
      {
        type: "synthesize_phonics",
        steps: normalizedSteps,
        gender,
        region: options.region ?? "north",
        speed: options.speed ?? 1.0,
      },
      synthTimeoutMs,
      options.signal,
    );
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    this.readyGenders.clear();
    this.pendingInit = null;
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

let sharedTtsClient: BrowserWasmTtsClient | null = null;

export function getBrowserWasmTtsClient(): BrowserWasmTtsClient {
  if (!sharedTtsClient) {
    sharedTtsClient = new BrowserWasmTtsClient();
  }
  return sharedTtsClient;
}

export function resetBrowserWasmTtsForTests(): void {
  if (sharedTtsClient) {
    sharedTtsClient.dispose();
    sharedTtsClient = null;
  }
}
