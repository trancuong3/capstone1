/**
 * Dedicated Web Worker for On-Device Vietnamese STT using sherpa-onnx WASM SIMD
 * (`sherpa-onnx-zipformer-vi-30M-int8-2026-02-09`, ~33.92 MB).
 *
 * Security & correctness invariants:
 * - Self-hosted WASM runtime loaded from `/wasm/sherpa/` (no eval, Apache-2.0).
 * - Model weights fetched on-demand from verified CORS-safe Hugging Face Hub,
 *   verified with SHA-256 before caching in IndexedDB (`0` Supabase/Vercel egress).
 * - NEVER receives or injects expected book text into the recognizer.
 * - Conditionally appends 0.35s trailing silence ONLY when clip duration >= 1.2s
 *   (computed dynamically from the actual input sample rate); shorter isolated words
 *   stay unpadded to avoid OfflineRecognizer trailing collocation hallucinations.
 */

const MODEL_VERSION = "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09";
const HF_BASE_URL =
  "https://huggingface.co/csukuangfj2/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09/resolve/main";
const SAMPLE_RATE = 16000;
const MIN_PAD_DURATION_SECONDS = 1.2;
const LEAD_PAD_SECONDS = 0.18;
const SHORT_TRAIL_CAP_SECONDS = 0.2;
const TRAILING_PAD_SECONDS = 0.35;
const IDB_NAME = "viread-wasm-models-v1";
const IDB_STORE = "files";

const MODEL_FILES = [
  {
    name: "encoder.int8.onnx",
    expectedBytes: 27699063,
    sha256: "8ef5286dd427eb108055c2ddc1982aa31e544706072d5ea228729292dacade68",
  },
  {
    name: "decoder.onnx",
    expectedBytes: 5165084,
    sha256: "cf2aa385b82c9d5d40cd29c3188af52d0249b3b78f0d4b7eb84ad502d50c7e7f",
  },
  {
    name: "joiner.int8.onnx",
    expectedBytes: 1033417,
    sha256: "7311d2e17b810ecea515d79c71cc4668af8759256a06fa01d27047772320c821",
  },
  {
    name: "tokens.txt",
    expectedBytes: 23238,
    sha256: "ca8171f8bbd516c050b627582f2125c8f5f1f6ed967ab41b0fa9aae2cf61b492",
  },
];

let wasmModulePromise = null;
let recognizerPromise = null;
let recognizerInstance = null;
const cancelledIds = new Set();

function trackCancel(id) {
  if (!id) return;
  cancelledIds.add(id);
  if (cancelledIds.size > 256) {
    const first = cancelledIds.values().next().value;
    if (first !== undefined) cancelledIds.delete(first);
  }
}

async function sha256Hex(arrayBuffer) {
  const digest = await self.crypto.subtle.digest("SHA-256", arrayBuffer);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function openModelsDb() {
  if (typeof self.indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = self.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readCachedFile(db, key) {
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.buffer : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeCachedFile(db, key, buffer) {
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put({
        key,
        modelVersion: MODEL_VERSION,
        byteLength: buffer.byteLength,
        updatedAt: Date.now(),
        buffer,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function deleteCachedFile(db, key) {
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function ensureWasmModule() {
  if (wasmModulePromise) return wasmModulePromise;
  wasmModulePromise = new Promise((resolve, reject) => {
    try {
      self.Module = {
        locateFile: (file) => `/wasm/sherpa/${file}`,
        onRuntimeInitialized: () => resolve(self.Module),
        onAbort: (reason) =>
          reject(new Error(String(reason || "WASM aborted"))),
      };
      importScripts(
        "/wasm/sherpa/sherpa-onnx-asr.js",
        "/wasm/sherpa/sherpa-onnx-wasm-main-vad-asr-clean.js",
      );
    } catch (err) {
      wasmModulePromise = null;
      reject(err);
    }
  });
  return wasmModulePromise;
}

async function fetchAndVerifyModelFile(db, spec) {
  const cacheKey = `${MODEL_VERSION}/${spec.name}`;
  const cached = await readCachedFile(db, cacheKey);
  if (cached && cached.byteLength === spec.expectedBytes) {
    const hash = await sha256Hex(cached);
    if (hash === spec.sha256) {
      return new Uint8Array(cached);
    }
    await deleteCachedFile(db, cacheKey);
  }

  const resp = await fetch(`${HF_BASE_URL}/${spec.name}`, {
    mode: "cors",
    credentials: "omit",
  });
  if (!resp.ok) {
    throw new Error(`Model fetch failed (${spec.name}): HTTP ${resp.status}`);
  }
  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength !== spec.expectedBytes) {
    throw new Error(
      `Model size mismatch (${spec.name}): got ${buffer.byteLength}, expected ${spec.expectedBytes}`,
    );
  }
  const actualSha = await sha256Hex(buffer);
  if (actualSha !== spec.sha256) {
    throw new Error(`Model SHA-256 mismatch for ${spec.name}`);
  }
  await writeCachedFile(db, cacheKey, buffer);
  return new Uint8Array(buffer);
}

async function ensureRecognizer() {
  if (recognizerInstance) return recognizerInstance;
  if (recognizerPromise) return recognizerPromise;

  recognizerPromise = (async () => {
    const [M, db] = await Promise.all([ensureWasmModule(), openModelsDb()]);
    try {
      for (let i = 0; i < MODEL_FILES.length; i += 1) {
        const spec = MODEL_FILES[i];
        self.postMessage({
          type: "progress",
          stage: "loading-model",
          file: spec.name,
          index: i,
          total: MODEL_FILES.length,
        });
        const bytes = await fetchAndVerifyModelFile(db, spec);
        try {
          M.FS_unlink(`/${spec.name}`);
        } catch {
          // File not yet mounted
        }
        M.FS_createDataFile("/", spec.name, bytes, true, true, false);
      }
    } finally {
      if (db && typeof db.close === "function") {
        try {
          db.close();
        } catch {
          // Ignore IDB close errors
        }
      }
    }

    const OfflineRecognizerCtor =
      typeof OfflineRecognizer === "function"
        ? OfflineRecognizer
        : self.OfflineRecognizer;
    if (typeof OfflineRecognizerCtor !== "function") {
      throw new Error(
        "OfflineRecognizer constructor unavailable in WASM runtime",
      );
    }

    const baseConfig = {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: "/encoder.int8.onnx",
          decoder: "/decoder.onnx",
          joiner: "/joiner.int8.onnx",
        },
        tokens: "/tokens.txt",
        numThreads: 1,
        provider: "cpu",
        modelType: "",
        debug: 0,
      },
      maxActivePaths: 4,
    };

    let recognizer = null;
    try {
      const beamRecognizer = new OfflineRecognizerCtor(
        {
          ...baseConfig,
          decodingMethod: "modified_beam_search",
          blankPenalty: 0,
        },
        M,
      );
      if (
        beamRecognizer &&
        (beamRecognizer.handle === undefined || beamRecognizer.handle !== 0)
      ) {
        recognizer = beamRecognizer;
      }
    } catch {
      recognizer = null;
    }

    if (!recognizer) {
      recognizer = new OfflineRecognizerCtor(
        {
          ...baseConfig,
          decodingMethod: "greedy_search",
        },
        M,
      );
    }

    recognizerInstance = recognizer;
    return recognizer;
  })().catch((err) => {
    recognizerPromise = null;
    throw err;
  });

  return recognizerPromise;
}

/**
 * Mirror server voice_worker.py child-voice acoustic preprocessing:
 * 1) DC offset removal
 * 2) 60Hz 1st-order high-pass filter (removes table rumble & breath thumps while preserving low huyền/nặng tones)
 * 3) Active-frame AGC up to 15x gain (lifts quiet child voices RMS 0.003-0.01)
 */
function preprocessChildVoice(input, sampleRate) {
  const n = input.length;
  const out = new Float32Array(n);
  if (!n) return out;

  // 1. DC offset removal
  let mean = 0;
  for (let i = 0; i < n; i += 1) {
    mean += input[i];
  }
  mean /= n;

  // 2. 60Hz 1st-order high-pass filter
  const sr = sampleRate > 0 ? sampleRate : SAMPLE_RATE;
  const rc = 1 / (2 * Math.PI * 60);
  const dt = 1 / sr;
  const alpha = rc / (rc + dt);
  let prevX = input[0] - mean;
  let prevY = 0;
  out[0] = prevX;
  for (let i = 1; i < n; i += 1) {
    const x = input[i] - mean;
    const y = alpha * (prevY + x - prevX);
    out[i] = y;
    prevX = x;
    prevY = y;
  }

  // 3. Active-frame child-voice AGC (<= 15x gain, clipped to [-0.98, 0.98])
  let peak = 0;
  let totalSq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = out[i];
    const abs = v < 0 ? -v : v;
    if (abs > peak) peak = abs;
    totalSq += v * v;
  }

  const frameLen = Math.max(1, Math.round(sr * 0.02));
  const numFrames = Math.floor(n / frameLen);
  let rms = Math.sqrt(totalSq / n);
  if (numFrames >= 2) {
    const frameRms = new Float32Array(numFrames);
    let maxFrameRms = 0;
    for (let f = 0; f < numFrames; f += 1) {
      let fSq = 0;
      const base = f * frameLen;
      for (let j = 0; j < frameLen; j += 1) {
        const v = out[base + j];
        fSq += v * v;
      }
      const r = Math.sqrt(fSq / frameLen);
      frameRms[f] = r;
      if (r > maxFrameRms) maxFrameRms = r;
    }
    const activeThresh = Math.max(0.002, maxFrameRms * 0.2);
    let activeSq = 0;
    let activeCount = 0;
    for (let f = 0; f < numFrames; f += 1) {
      if (frameRms[f] >= activeThresh) {
        activeSq += frameRms[f] * frameRms[f];
        activeCount += 1;
      }
    }
    if (activeCount > 0) {
      rms = Math.sqrt(activeSq / activeCount);
    }
  }

  if (rms > 0.0004 && peak > 0.0015) {
    const gainRms = 0.08 / rms;
    const gainPeak = 0.92 / peak;
    const gain = Math.min(15.0, gainRms, gainPeak);
    if (gain > 1.0) {
      for (let i = 0; i < n; i += 1) {
        const scaled = out[i] * gain;
        out[i] = scaled > 0.98 ? 0.98 : scaled < -0.98 ? -0.98 : scaled;
      }
    }
  }

  return out;
}

/**
 * Estimate voiced speech span, leading silence, and trailing silence in seconds
 * using 20ms frame energy so we never double-pad pre-roll silence or leave
 * excessive trailing silence on short isolated words.
 */
function analyzeSpeechWindowSeconds(samples, sampleRate) {
  const n = samples.length;
  if (!n) {
    return {
      voicedSeconds: 0,
      leadingSilenceSeconds: 0,
      trailingSilenceSeconds: 0,
    };
  }
  const sr = sampleRate > 0 ? sampleRate : SAMPLE_RATE;
  const frameLen = Math.max(1, Math.round(sr * 0.02));
  const numFrames = Math.floor(n / frameLen);
  if (numFrames <= 0) {
    return {
      voicedSeconds: n / sr,
      leadingSilenceSeconds: 0,
      trailingSilenceSeconds: 0,
    };
  }

  const frameRms = new Float32Array(numFrames);
  let maxFrameRms = 0;
  for (let f = 0; f < numFrames; f += 1) {
    let fSq = 0;
    const base = f * frameLen;
    for (let j = 0; j < frameLen; j += 1) {
      const v = samples[base + j];
      fSq += v * v;
    }
    const r = Math.sqrt(fSq / frameLen);
    frameRms[f] = r;
    if (r > maxFrameRms) maxFrameRms = r;
  }

  const thresh = Math.max(0.004, maxFrameRms * 0.14);
  if (maxFrameRms < thresh) {
    return {
      voicedSeconds: 0,
      leadingSilenceSeconds: n / sr,
      trailingSilenceSeconds: n / sr,
    };
  }

  let firstActive = -1;
  let lastActive = -1;
  for (let f = 0; f < numFrames; f += 1) {
    if (frameRms[f] >= thresh) {
      if (firstActive === -1) firstActive = f;
      lastActive = f;
    }
  }
  if (firstActive === -1) {
    return {
      voicedSeconds: 0,
      leadingSilenceSeconds: n / sr,
      trailingSilenceSeconds: n / sr,
    };
  }
  const trailingFrames = Math.max(0, numFrames - 1 - lastActive);
  return {
    voicedSeconds: ((lastActive - firstActive + 1) * frameLen) / sr,
    leadingSilenceSeconds: (firstActive * frameLen) / sr,
    trailingSilenceSeconds: (trailingFrames * frameLen) / sr,
  };
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "cancel") {
    trackCancel(msg.id);
    return;
  }

  if (msg.type === "dispose") {
    if (recognizerInstance) {
      try {
        recognizerInstance.free();
      } catch {
        // Ignore cleanup failure
      }
      recognizerInstance = null;
    }
    recognizerPromise = null;
    self.postMessage({ type: "disposed", id: msg.id });
    return;
  }

  if (msg.type === "init") {
    try {
      await ensureRecognizer();
      self.postMessage({ type: "ready", id: msg.id });
    } catch (err) {
      self.postMessage({
        type: "error",
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === "transcribe") {
    const id = msg.id;
    if (cancelledIds.has(id)) {
      cancelledIds.delete(id);
      return;
    }
    try {
      const recognizer = await ensureRecognizer();
      if (cancelledIds.has(id)) {
        cancelledIds.delete(id);
        return;
      }
      const input =
        msg.samples instanceof Float32Array
          ? msg.samples
          : new Float32Array(msg.samples || 0);
      if (!input.length) {
        self.postMessage({ type: "result", id, text: "", decodeMs: 0 });
        return;
      }

      // Early pre-decode silence guard: never feed digital silence or near-zero
      // noise into Sherpa modified_beam_search so silence always returns "".
      let rawPeak = 0;
      let rawSumSq = 0;
      for (let i = 0; i < input.length; i += 1) {
        const v = input[i];
        const a = v < 0 ? -v : v;
        if (a > rawPeak) rawPeak = a;
        rawSumSq += v * v;
      }
      const rawRms = Math.sqrt(rawSumSq / input.length);
      if (rawPeak <= 0.0015 || (msg.voicedDurationMs === 0 && rawRms < 0.003)) {
        self.postMessage({ type: "result", id, text: "", decodeMs: 0 });
        return;
      }

      // Maintain ~0.18s clean lead silence (never double-stacking existing pre-roll),
      // cap excess trailing silence on isolated short words to <= 0.20s, and append
      // 0.35s trailing silence ONLY when *voiced* speech duration >= 1.2s.
      const sr =
        typeof msg.sampleRate === "number" && msg.sampleRate > 0
          ? msg.sampleRate
          : SAMPLE_RATE;
      const preprocessed = preprocessChildVoice(input, sr);
      const {
        voicedSeconds: estimatedVoicedSeconds,
        leadingSilenceSeconds: existingLeadSeconds,
        trailingSilenceSeconds: existingTailSeconds,
      } = analyzeSpeechWindowSeconds(preprocessed, sr);
      if (
        estimatedVoicedSeconds <= 0 &&
        (msg.voicedDurationMs === undefined ||
          msg.voicedDurationMs === null ||
          msg.voicedDurationMs <= 0)
      ) {
        self.postMessage({ type: "result", id, text: "", decodeMs: 0 });
        return;
      }
      const voicedDurationSeconds =
        typeof msg.voicedDurationMs === "number" &&
        Number.isFinite(msg.voicedDurationMs) &&
        msg.voicedDurationMs >= 0
          ? msg.voicedDurationMs / 1000
          : estimatedVoicedSeconds;
      let audioForDecode = preprocessed;
      let leadPadSamples = 0;
      if (
        voicedDurationSeconds < MIN_PAD_DURATION_SECONDS &&
        existingLeadSeconds > LEAD_PAD_SECONDS
      ) {
        const trimSamples = Math.round(
          (existingLeadSeconds - LEAD_PAD_SECONDS) * sr,
        );
        if (trimSamples > 0 && trimSamples < preprocessed.length) {
          audioForDecode = preprocessed.subarray(trimSamples);
        }
      } else {
        const missingLeadSeconds = Math.max(
          0,
          LEAD_PAD_SECONDS - existingLeadSeconds,
        );
        leadPadSamples = Math.round(missingLeadSeconds * sr);
      }
      let trailPadSamples = 0;
      if (voicedDurationSeconds >= MIN_PAD_DURATION_SECONDS) {
        trailPadSamples = Math.round(TRAILING_PAD_SECONDS * sr);
      } else if (existingTailSeconds > SHORT_TRAIL_CAP_SECONDS) {
        const trimTailSamples = Math.round(
          (existingTailSeconds - SHORT_TRAIL_CAP_SECONDS) * sr,
        );
        if (trimTailSamples > 0 && trimTailSamples < audioForDecode.length) {
          audioForDecode = audioForDecode.subarray(
            0,
            audioForDecode.length - trimTailSamples,
          );
        }
      }
      const waveform = new Float32Array(
        leadPadSamples + audioForDecode.length + trailPadSamples,
      );
      waveform.set(audioForDecode, leadPadSamples);

      const t0 = self.performance ? self.performance.now() : Date.now();
      const stream = recognizer.createStream();
      let rawText = "";
      try {
        stream.acceptWaveform(sr, waveform);
        recognizer.decode(stream);
        const result = recognizer.getResult(stream);
        rawText = result && result.text ? String(result.text) : "";
      } finally {
        stream.free();
      }
      const decodeMs = Number(
        ((self.performance ? self.performance.now() : Date.now()) - t0).toFixed(
          2,
        ),
      );
      if (cancelledIds.has(id)) {
        cancelledIds.delete(id);
        return;
      }
      const text = rawText.normalize("NFC").toLowerCase().trim();
      self.postMessage({ type: "result", id, text, decodeMs });
    } catch (err) {
      if (cancelledIds.has(id)) {
        cancelledIds.delete(id);
        return;
      }
      self.postMessage({
        type: "error",
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
