/**
 * Dedicated Web Worker for On-Device Vietnamese Neural TTS using sherpa-onnx WASM
 * + piper-phonemize (eSpeak-NG Vietnamese phonemizer, 22,050 Hz, 6 tones preserved).
 *
 * Security & correctness invariants:
 * - Self-hosted WASM runtimes loaded from `/wasm/sherpa-tts/` (Apache-2.0, zero eval).
 * - Model weights downloaded on-demand per requested gender ("female" | "male") from
 *   CORS-safe Hugging Face Hub, SHA-256 verified, and cached in IndexedDB (`0` Vercel/Supabase egress).
 * - Strict gender isolation: Female and Male are separate physical ONNX models
 *   (vais1000-medium F0 ~235 Hz vs diemdam-medium F0 ~143 Hz), switching models explicitly
 *   when the requested gender changes.
 */

const IDB_NAME = "viread-wasm-tts-v1";
const IDB_STORE = "files";
const FETCH_TIMEOUT_MS = 60_000;
const ESPEAK_HF_BASE_URL =
  "https://huggingface.co/csukuangfj/vits-piper-vi_VN-vivos-x_low/resolve/main/espeak-ng-data";

const ESPEAK_FILES = [
  {
    rel: "phontab",
    expectedBytes: 55796,
    sha256: "886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6",
  },
  {
    rel: "phonindex",
    expectedBytes: 39074,
    sha256: "3ca7b8fa3b42624e4b0f152707e7a39245fce569aa99ea47c055d9e622fcf0c4",
  },
  {
    rel: "phondata",
    expectedBytes: 550424,
    sha256: "4e0288957874029a8c3c9f41a8f517ad4bf18127046decbdd4b9d1d6807ce3a3",
  },
  {
    rel: "intonations",
    expectedBytes: 2040,
    sha256: "3f8af65fd3eda9759a10f021d61361c120871f463515229c925995c7f90918cc",
  },
  {
    rel: "vi_dict",
    expectedBytes: 52608,
    sha256: "bbf7cab4ba733b2f5d9d3b61eb1194ef745232fa3adebb4bc92456e948cb3722",
  },
  {
    rel: "en_dict",
    expectedBytes: 166944,
    sha256: "71bd330ba8a2e3e8076e631508208ef49449d6147c17b7bd2b4b1e1468292e35",
  },
  {
    rel: "lang/aav/vi",
    expectedBytes: 111,
    sha256: "3199c980f9e23a88a2aa693cd631bf4fcb0f3408c4272bc01b7ac0ff8e79d778",
  },
  {
    rel: "lang/aav/vi-VN-x-central",
    expectedBytes: 143,
    sha256: "b351f13c6ed0da37561df25f45579872ff9863920ad66b94e27327a2c611755b",
  },
  {
    rel: "lang/aav/vi-VN-x-south",
    expectedBytes: 142,
    sha256: "c0a0a2c894cd57b0bbacf9ef4efb8d89bfaf9feb164830e1539f599e7cc4e021",
  },
];

const VOICE_MODEL_CONFIGS = {
  female: {
    version: "vits-piper-vi_VN-vais1000-medium",
    baseUrl:
      "https://huggingface.co/csukuangfj/vits-piper-vi_VN-vais1000-medium/resolve/main",
    noiseScale: 0.5,
    noiseScaleW: 0.35,
    files: [
      {
        remoteName: "vi_VN-vais1000-medium.onnx",
        localName: "model.onnx",
        expectedBytes: 63201425,
        sha256:
          "7264e130a2f2e62c2dd586e3790ba054b669f9f72a2bdb2c0d60207136611576",
      },
      {
        remoteName: "tokens.txt",
        localName: "tokens.txt",
        expectedBytes: 921,
        sha256:
          "87c8ef66eae5473ed0cc0366b3964c736ca6c5f676c979522ea31234e47430b9",
      },
    ],
  },
  male: {
    version: "vits-piper-vi_VN-diemdam-medium",
    baseUrl:
      "https://huggingface.co/vnhellboy/vietnamese-piper-voices/resolve/main/vits-piper-vi_VN-diemdam-medium",
    noiseScale: 0.55,
    noiseScaleW: 0.45,
    files: [
      {
        remoteName: "vi_VN-diemdam-medium.onnx",
        localName: "model.onnx",
        expectedBytes: 63516182,
        sha256:
          "821096ee1f6d424fd9d1a0ff83fd851637e5ff880e8aaf3c5b53be87269a6e26",
      },
      {
        remoteName: "tokens.txt",
        localName: "tokens.txt",
        expectedBytes: 968,
        sha256:
          "e8a50ae0c75612d18cfcf3f90800dca79f961e3ed97f9574f3535194469187fd",
      },
    ],
  },
};

let scriptsLoaded = false;
let piperPromise = null;
let piperModule = null;
let ttsRuntimePromise = null;
let ttsRuntimeModule = null;
const ttsInstancesByGender = { female: null, male: null };
let loadPromise = null;
let loadingGender = null;
let loadEpoch = 0;
const activeFetchControllers = new Set();
const cancelledIds = new Set();

function trackCancel(id) {
  if (!id) return;
  cancelledIds.add(id);
  if (cancelledIds.size > 256) {
    const first = cancelledIds.values().next().value;
    if (first !== undefined) cancelledIds.delete(first);
  }
}

function normalizeGender(gender) {
  return String(gender || "").toLowerCase() === "male" ? "male" : "female";
}

function resolveEspeakVoiceForRegion(region) {
  const norm = String(region || "").toLowerCase();
  if (norm === "central" || norm === "trung") return "vi-vn-x-central";
  if (norm === "south" || norm === "nam") return "vi-vn-x-south";
  return "vi";
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

async function readCachedRecord(db, key) {
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
      tx.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeCachedFile(db, key, modelVersion, buffer, verifiedSha256) {
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put({
        key,
        modelVersion,
        byteLength: buffer.byteLength,
        verifiedSha256: verifiedSha256 || null,
        updatedAt: Date.now(),
        buffer,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function writeVerifiedManifest(db, version, specs) {
  if (!db) return;
  const files = {};
  for (const spec of specs) {
    files[spec.name] = {
      byteLength: spec.expectedBytes,
      sha256: spec.sha256,
      verified: true,
    };
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put({
        key: `${version}/__manifest__`,
        modelVersion: version,
        updatedAt: Date.now(),
        files,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
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
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function loadOrFetchVerifiedFile(
  db,
  cacheKey,
  modelVersion,
  fetchUrl,
  expectedBytes,
  expectedSha256,
  epoch,
) {
  if (epoch !== loadEpoch) {
    throw new Error("WASM TTS init disposed");
  }
  const cachedRec = await readCachedRecord(db, cacheKey);
  if (epoch !== loadEpoch) {
    throw new Error("WASM TTS init disposed");
  }
  const cached = cachedRec && cachedRec.buffer ? cachedRec.buffer : null;
  if (cached && cached.byteLength === expectedBytes) {
    if (cachedRec.verifiedSha256 === expectedSha256) {
      return new Uint8Array(cached);
    }
    const hash = await sha256Hex(cached);
    if (hash === expectedSha256) {
      await writeCachedFile(db, cacheKey, modelVersion, cached, expectedSha256);
      return new Uint8Array(cached);
    }
    await deleteCachedFile(db, cacheKey);
  }

  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  let timeoutId = null;
  let timedOut = false;
  if (controller) {
    activeFetchControllers.add(controller);
    if (typeof setTimeout === "function") {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, FETCH_TIMEOUT_MS);
    }
  }
  let buffer;
  try {
    const fetchOpts = { mode: "cors", credentials: "omit" };
    if (controller) fetchOpts.signal = controller.signal;
    const resp = await fetch(fetchUrl, fetchOpts);
    if (!resp.ok) {
      throw new Error(
        `TTS asset fetch failed (${cacheKey}): HTTP ${resp.status}`,
      );
    }
    buffer = await resp.arrayBuffer();
  } catch (err) {
    if (timedOut) {
      throw new Error(`TTS asset fetch timed out (${cacheKey})`);
    }
    throw err;
  } finally {
    if (timeoutId !== null && typeof clearTimeout === "function") {
      clearTimeout(timeoutId);
    }
    if (controller) {
      activeFetchControllers.delete(controller);
    }
  }
  if (epoch !== loadEpoch) {
    throw new Error("WASM TTS init disposed");
  }
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `TTS asset size mismatch (${cacheKey}): got ${buffer.byteLength}, expected ${expectedBytes}`,
    );
  }
  const actualSha = await sha256Hex(buffer);
  if (actualSha !== expectedSha256) {
    throw new Error(`TTS asset SHA-256 mismatch for ${cacheKey}`);
  }
  await writeCachedFile(db, cacheKey, modelVersion, buffer, actualSha);
  return new Uint8Array(buffer);
}

function ensureRuntimeScriptsLoaded() {
  if (scriptsLoaded) return;
  importScripts(
    "/wasm/sherpa-tts/piper-phonemize-wasm-main-clean.js",
    "/wasm/sherpa-tts/sherpa-onnx-wasm-main-tts-clean.js",
    "/wasm/sherpa-tts/sherpa-onnx-tts.js",
  );
  scriptsLoaded = true;
}

async function ensurePiperReady(espeakAssets, epoch) {
  if (piperModule) return piperModule;
  if (piperPromise) return piperPromise;

  ensureRuntimeScriptsLoaded();
  piperPromise = new Promise((resolve, reject) => {
    try {
      let mod = null;
      mod = self.initPiperPhonemizeRuntime({
        locateFile: (file) => `/wasm/sherpa-tts/${file}`,
        preRun: [
          () => {
            const FS = mod.__exposeFS || mod.FS;
            FS.mkdirTree("/usr/share/espeak-ng-data/lang/aav");
            for (const { rel, bytes } of espeakAssets) {
              FS.writeFile(`/usr/share/espeak-ng-data/${rel}`, bytes);
            }
          },
        ],
        onRuntimeInitialized: () => {
          if (epoch !== loadEpoch) {
            reject(new Error("WASM TTS init disposed"));
            return;
          }
          try {
            const ret = mod.initialize();
            if (ret < 0) {
              reject(new Error(`espeak-ng init failed: ${ret}`));
              return;
            }
            piperModule = mod;
            resolve(mod);
          } catch (err) {
            reject(err);
          }
        },
        onAbort: (reason) =>
          reject(new Error(`Piper WASM aborted: ${String(reason || "")}`)),
      });
    } catch (err) {
      piperPromise = null;
      reject(err);
    }
  }).catch((err) => {
    piperPromise = null;
    throw err;
  });

  return piperPromise;
}

async function ensureTtsRuntimeReady(epoch) {
  if (ttsRuntimeModule) return ttsRuntimeModule;
  if (ttsRuntimePromise) return ttsRuntimePromise;

  ensureRuntimeScriptsLoaded();
  ttsRuntimePromise = new Promise((resolve, reject) => {
    try {
      const mod = self.initSherpaOnnxTtsRuntime({
        locateFile: (file) => `/wasm/sherpa-tts/${file}`,
        onRuntimeInitialized: () => {
          if (epoch !== loadEpoch) {
            reject(new Error("WASM TTS init disposed"));
            return;
          }
          ttsRuntimeModule = mod;
          resolve(mod);
        },
        onAbort: (reason) =>
          reject(new Error(`Sherpa TTS WASM aborted: ${String(reason || "")}`)),
      });
    } catch (err) {
      ttsRuntimePromise = null;
      reject(err);
    }
  }).catch((err) => {
    ttsRuntimePromise = null;
    throw err;
  });

  return ttsRuntimePromise;
}

async function ensureTtsReadyForGender(rawGender) {
  const gender = normalizeGender(rawGender);
  if (ttsInstancesByGender[gender] && piperModule) {
    return { piper: piperModule, tts: ttsInstancesByGender[gender], gender };
  }
  if (loadPromise && loadingGender === gender) {
    return loadPromise;
  }
  if (loadPromise && loadingGender !== gender) {
    // Wait for in-flight model load to settle before loading the other gender.
    await loadPromise.catch(() => undefined);
    if (ttsInstancesByGender[gender] && piperModule) {
      return { piper: piperModule, tts: ttsInstancesByGender[gender], gender };
    }
  }

  const epoch = loadEpoch;
  loadingGender = gender;
  const spec = VOICE_MODEL_CONFIGS[gender];

  const pending = (async () => {
    const db = await openModelsDb();
    let espeakAssets = [];
    let modelAssets = [];
    try {
      const needsEspeak = !piperModule;
      const totalSteps =
        (needsEspeak ? ESPEAK_FILES.length : 0) + spec.files.length;
      let progressIndex = 0;

      const espeakPromise = needsEspeak
        ? Promise.all(
            ESPEAK_FILES.map(async (ef) => {
              const bytes = await loadOrFetchVerifiedFile(
                db,
                `espeak-ng-data/${ef.rel}`,
                "espeak-ng-data-vi-v1",
                `${ESPEAK_HF_BASE_URL}/${ef.rel}`,
                ef.expectedBytes,
                ef.sha256,
                epoch,
              );
              self.postMessage({
                type: "progress",
                stage: "loading-tts-model",
                gender,
                file: ef.rel,
                index: Math.min(progressIndex++, totalSteps),
                total: totalSteps,
              });
              return { rel: ef.rel, bytes };
            }),
          )
        : Promise.resolve([]);

      const modelPromise = Promise.all(
        spec.files.map(async (mf) => {
          self.postMessage({
            type: "progress",
            stage: "loading-tts-model",
            gender,
            file: mf.remoteName,
            index: Math.min(progressIndex++, totalSteps),
            total: totalSteps,
          });
          const bytes = await loadOrFetchVerifiedFile(
            db,
            `${spec.version}/${mf.localName}`,
            spec.version,
            `${spec.baseUrl}/${mf.remoteName}`,
            mf.expectedBytes,
            mf.sha256,
            epoch,
          );
          return { spec: mf, bytes };
        }),
      );

      [espeakAssets, modelAssets] = await Promise.all([
        espeakPromise,
        modelPromise,
      ]);

      if (epoch !== loadEpoch) {
        throw new Error("WASM TTS init disposed");
      }

      if (needsEspeak) {
        await writeVerifiedManifest(
          db,
          "espeak-ng-data-vi-v1",
          ESPEAK_FILES.map((f) => ({
            name: f.rel,
            expectedBytes: f.expectedBytes,
            sha256: f.sha256,
          })),
        );
      }
      await writeVerifiedManifest(
        db,
        spec.version,
        spec.files.map((f) => ({
          name: f.localName,
          expectedBytes: f.expectedBytes,
          sha256: f.sha256,
        })),
      );
    } finally {
      if (db && typeof db.close === "function") {
        try {
          db.close();
        } catch {
          // Ignore close error
        }
      }
    }

    if (epoch !== loadEpoch) {
      throw new Error("WASM TTS init disposed");
    }

    const [piper, M] = await Promise.all([
      ensurePiperReady(espeakAssets, epoch),
      ensureTtsRuntimeReady(epoch),
    ]);

    if (epoch !== loadEpoch) {
      throw new Error("WASM TTS init disposed");
    }

    const FS = M.__exposeFS || M.FS;
    const modelMemPath = `./model-${gender}.onnx`;
    const tokensMemPath = `./tokens-${gender}.txt`;
    for (const { spec: mf, bytes } of modelAssets) {
      const targetMemPath = mf.localName.endsWith(".onnx")
        ? modelMemPath
        : tokensMemPath;
      try {
        FS.unlink(targetMemPath);
      } catch {
        // Ignore if missing
      }
      FS.writeFile(targetMemPath, bytes);
    }

    const emptyModelPart = {
      model: "",
      voices: "",
      tokens: "",
      dataDir: "",
      lexicon: "",
      acousticModel: "",
      vocoder: "",
      encoder: "",
      decoder: "",
      lmFlow: "",
      lmMain: "",
      textConditioner: "",
      vocabJson: "",
      tokenScoresJson: "",
      durationPredictor: "",
      textEncoder: "",
      vectorEstimator: "",
      ttsJson: "",
      unicodeIndexer: "",
      voiceStyle: "",
      noiseScale: 0.667,
      noiseScaleW: 0.8,
      lengthScale: 1.0,
      featScale: 0.1,
      tShift: 0.5,
      targetRMS: 0.1,
      guidanceScale: 1.0,
      lang: "",
      voiceEmbeddingCacheCapacity: 50,
    };

    const customConfig = {
      offlineTtsModelConfig: {
        offlineTtsVitsModelConfig: {
          model: modelMemPath,
          lexicon: "",
          tokens: tokensMemPath,
          dataDir: "",
          noiseScale: spec.noiseScale,
          noiseScaleW: spec.noiseScaleW,
          lengthScale: 1.0,
        },
        offlineTtsMatchaModelConfig: emptyModelPart,
        offlineTtsKokoroModelConfig: emptyModelPart,
        offlineTtsKittenModelConfig: emptyModelPart,
        offlineTtsZipVoiceModelConfig: emptyModelPart,
        offlineTtsPocketModelConfig: emptyModelPart,
        offlineTtsSupertonicModelConfig: emptyModelPart,
        numThreads: 1,
        debug: 0,
        provider: "cpu",
      },
      ruleFsts: "",
      ruleFars: "",
      maxNumSentences: 1,
    };

    let instance = null;
    try {
      instance = self.createOfflineTts(M, customConfig);
    } catch (allocErr) {
      // Low-memory fallback: evict opposite gender ONNX session if resident and retry once.
      const otherGender = gender === "male" ? "female" : "male";
      if (ttsInstancesByGender[otherGender]) {
        try {
          ttsInstancesByGender[otherGender].free();
        } catch {
          // Ignore free error
        }
        ttsInstancesByGender[otherGender] = null;
        instance = self.createOfflineTts(M, customConfig);
      } else {
        throw allocErr;
      }
    } finally {
      // Free ~63 MB weights copy from MEMFS immediately after ONNX Runtime session loads them.
      for (const memPath of [modelMemPath, tokensMemPath]) {
        try {
          FS.unlink(memPath);
        } catch {
          // Ignore cleanup failure
        }
      }
    }

    if (epoch !== loadEpoch) {
      try {
        instance.free();
      } catch {
        // Ignore cleanup failure
      }
      throw new Error("WASM TTS init disposed");
    }

    ttsInstancesByGender[gender] = instance;
    return { piper, tts: instance, gender };
  })().finally(() => {
    if (loadPromise === pending) {
      loadPromise = null;
      loadingGender = null;
    }
  });

  loadPromise = pending;
  return pending;
}

function encodeWavFromFloat32(rawSamples, sampleRate) {
  const sr = sampleRate > 0 ? sampleRate : 22050;
  // Trim excess leading/trailing dead digital silence while retaining ~45ms lead + ~65ms tail
  // so WebAudio never pops or truncates isolated single syllables.
  let firstActive = 0;
  while (
    firstActive < rawSamples.length &&
    Math.abs(rawSamples[firstActive]) < 0.002
  ) {
    firstActive += 1;
  }
  let lastActive = rawSamples.length - 1;
  while (lastActive > firstActive && Math.abs(rawSamples[lastActive]) < 0.002) {
    lastActive -= 1;
  }

  const startIdx = firstActive < lastActive ? firstActive : 0;
  const endIdx = firstActive < lastActive ? lastActive + 1 : rawSamples.length;
  const activeLen = Math.max(0, endIdx - startIdx);
  const leadSamples = Math.round(sr * 0.045);
  const tailSamples = Math.round(sr * 0.065);
  const totalSamples = leadSamples + activeLen + tailSamples;
  const pcm = new Int16Array(totalSamples);
  const fadeSamples = Math.min(
    Math.round(sr * 0.005),
    Math.floor(activeLen / 4),
  );

  for (let i = 0; i < activeLen; i += 1) {
    let s = rawSamples[startIdx + i];
    if (fadeSamples > 0) {
      if (i < fadeSamples) {
        s *= (i + 1) / fadeSamples;
      } else if (i >= activeLen - fadeSamples) {
        s *= (activeLen - i) / fadeSamples;
      }
    }
    if (s >= 1) s = 1;
    else if (s <= -1) s = -1;
    pcm[leadSamples + i] = Math.round(s * 32767);
  }

  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46464952, true); // RIFF
  view.setUint32(4, 36 + totalSamples * 2, true);
  view.setUint32(8, 0x45564157, true); // WAVE
  view.setUint32(12, 0x20746d66, true); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x61746164, true); // data
  view.setUint32(40, totalSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < totalSamples; i += 1) {
    view.setInt16(offset, pcm[i], true);
    offset += 2;
  }
  return {
    wavBuffer: buffer,
    durationSeconds: Number((totalSamples / sr).toFixed(3)),
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
    loadEpoch += 1;
    for (const controller of activeFetchControllers) {
      try {
        controller.abort();
      } catch {
        // Ignore
      }
    }
    activeFetchControllers.clear();
    for (const gKey of ["female", "male"]) {
      if (ttsInstancesByGender[gKey]) {
        try {
          ttsInstancesByGender[gKey].free();
        } catch {
          // Ignore
        }
        ttsInstancesByGender[gKey] = null;
      }
    }
    loadPromise = null;
    loadingGender = null;
    self.postMessage({ type: "disposed", id: msg.id });
    return;
  }

  if (msg.type === "init") {
    const id = msg.id;
    try {
      const { gender } = await ensureTtsReadyForGender(msg.gender);
      self.postMessage({ type: "ready", id, gender });
    } catch (err) {
      self.postMessage({
        type: "error",
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === "synthesize") {
    const id = msg.id;
    if (cancelledIds.has(id)) {
      cancelledIds.delete(id);
      return;
    }
    try {
      const rawText = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!rawText) {
        throw new Error("TTS text is empty");
      }
      const speedRaw = Number(msg.speed);
      const speed =
        Number.isFinite(speedRaw) && speedRaw >= 0.65 && speedRaw <= 1.5
          ? speedRaw
          : 1.0;

      const { piper, tts, gender } = await ensureTtsReadyForGender(msg.gender);
      if (cancelledIds.has(id)) {
        cancelledIds.delete(id);
        return;
      }

      const espeakVoice = resolveEspeakVoiceForRegion(msg.region);
      const sentences = piper.phonemize(rawText, espeakVoice) || [];
      const phonemeCodepoints = sentences.filter(
        (s) => Array.isArray(s) && s.length > 0,
      );
      if (phonemeCodepoints.length === 0) {
        throw new Error("Vietnamese phonemization produced no phonemes");
      }

      const t0 = self.performance ? self.performance.now() : Date.now();
      const generated = tts.generateWithConfig("", {
        phonemeCodepoints,
        sid: 0,
        speed,
      });
      if (cancelledIds.has(id)) {
        cancelledIds.delete(id);
        return;
      }
      const { wavBuffer, durationSeconds } = encodeWavFromFloat32(
        generated.samples,
        generated.sampleRate || tts.sampleRate || 22050,
      );
      const synthMs = Number(
        ((self.performance ? self.performance.now() : Date.now()) - t0).toFixed(
          2,
        ),
      );
      self.postMessage(
        {
          type: "result",
          id,
          gender,
          sampleRate: generated.sampleRate || tts.sampleRate || 22050,
          durationSeconds,
          synthMs,
          wavBuffer,
        },
        [wavBuffer],
      );
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
