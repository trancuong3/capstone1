/**
 * Persistent Browser TTS Audio Cache (IndexedDB LRU, max 50 MB).
 *
 * Security & privacy invariants:
 * - Caches ONLY explicitly scoped `CATALOG` and `COACHING` audio clips.
 * - NEVER persists `PRIVATE` parent-book clips or requests with `isPrivateBook: true`.
 * - Decoupled from HTTP `Cache-Control: no-store` (which backend sends uniformly
 *   to block shared HTTP proxy caching while allowing client IndexedDB storage
 *   for verified `X-TTS-Scope: CATALOG|COACHING` clips).
 */

import { setSynthesizedAudioMeta } from "@/lib/reading/synthesized-audio-meta";

export type TtsCacheScope = "CATALOG" | "PRIVATE" | "COACHING";

export const MAX_BROWSER_TTS_CACHE_BYTES = 50 * 1024 * 1024;
const IDB_NAME = "viread-tts-audio-v1";
const IDB_VERSION = 2;
const IDB_STORE = "entries";
const IDB_META_STORE = "meta";
const IDB_OP_TIMEOUT_MS = 4_000;

export interface CachedWordTimingRecord {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export interface CachedPhonicsStepTimingRecord {
  readonly id: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

interface StoredTtsEntry {
  readonly key: string;
  readonly scope: "CATALOG" | "COACHING";
  readonly contentType: string;
  readonly byteSize: number;
  readonly buffer: ArrayBuffer;
  readonly createdAt: number;
  readonly cachedSpeed?: number | null;
  readonly durationSeconds?: number;
  readonly words?: readonly CachedWordTimingRecord[];
  readonly stepTimings?: readonly CachedPhonicsStepTimingRecord[];
  readonly resolvedVoiceId?: string | null;
  readonly region?: string | null;
  readonly modelVersion?: string | null;
  readonly provider?: string | null;
  lastAccessedAt: number;
}

export interface CachedTimedTtsEntry {
  readonly audio: Blob;
  readonly durationSeconds: number;
  readonly words: readonly CachedWordTimingRecord[];
  readonly resolvedVoiceId: string | null;
  readonly region: string | null;
  readonly modelVersion: string | null;
  readonly provider: string;
  readonly cachedSpeed: number | null;
}

export interface CachedPhonicsTtsEntry {
  readonly audio: Blob;
  readonly durationSeconds: number;
  readonly stepTimings: readonly CachedPhonicsStepTimingRecord[];
  readonly resolvedVoiceId: string | null;
  readonly region: string | null;
  readonly modelVersion: string | null;
  readonly provider: string;
  readonly cachedSpeed: number | null;
}

interface StoredTtsMeta {
  readonly key: string;
  readonly scope: "CATALOG" | "COACHING";
  readonly byteSize: number;
  readonly createdAt: number;
  lastAccessedAt: number;
}

export interface BrowserTtsCacheStats {
  readonly supported: boolean;
  readonly entryCount: number;
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly error?: string | null;
}

let cacheHits = 0;
let cacheMisses = 0;
let cachedDbPromise: Promise<IDBDatabase | null> | null = null;
let cachedDbInstance: IDBDatabase | null = null;
let cachedIndexedDbRef: IDBFactory | null = null;
const pendingMetaTouches = new Map<string, StoredTtsMeta>();
let metaTouchTimer: ReturnType<typeof setTimeout> | null = null;

function sanitizeByteSize(
  byteSize: unknown,
  fallbackBuffer?: ArrayBuffer | null,
): number {
  if (byteSize !== undefined && byteSize !== null) {
    return typeof byteSize === "number" &&
      Number.isFinite(byteSize) &&
      byteSize > 0
      ? byteSize
      : 0;
  }
  const fallback = fallbackBuffer?.byteLength;
  return typeof fallback === "number" &&
    Number.isFinite(fallback) &&
    fallback > 0
    ? fallback
    : 0;
}

export function shouldPersistTtsCacheEntry(options: {
  scope?: TtsCacheScope | null;
  cacheControl?: string | null;
  isPrivateBook?: boolean;
}): boolean {
  if (options.isPrivateBook) return false;
  return options.scope === "CATALOG" || options.scope === "COACHING";
}

export function buildTtsBrowserCacheKey(input: {
  kind: "short" | "wordSample" | "timed" | "phonics";
  textOrTokens: string;
  voiceId: string;
  modelVersion: string;
  speed: number;
  format?: string | null;
  scope?: TtsCacheScope | null;
}): string {
  return JSON.stringify([
    input.kind,
    input.scope ?? "CATALOG",
    input.voiceId,
    input.modelVersion,
    Number(input.speed.toFixed(2)),
    input.format ?? "auto",
    input.textOrTokens.normalize("NFC"),
  ]);
}

interface TtsDbOpenResult {
  readonly db: IDBDatabase | null;
  readonly error: string | null;
}

function resetCachedDbHandle(): void {
  if (metaTouchTimer !== null) {
    clearTimeout(metaTouchTimer);
    metaTouchTimer = null;
  }
  pendingMetaTouches.clear();
  cachedDbPromise = null;
  cachedDbInstance = null;
  cachedIndexedDbRef = null;
}

function isReusableDbHandle(db: IDBDatabase): boolean {
  return (
    typeof (db as unknown as { addEventListener?: unknown }).addEventListener ===
    "function"
  );
}

function releaseDbHandle(db: IDBDatabase, forceClose = false): void {
  if (!forceClose && db === cachedDbInstance) {
    return;
  }
  if (db === cachedDbInstance) {
    resetCachedDbHandle();
  }
  safeCloseDb(db);
}

function openTtsDbWithReason(): Promise<TtsDbOpenResult> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve({ db: null, error: "INDEXEDDB_UNAVAILABLE" });
  }
  if (cachedIndexedDbRef !== indexedDB) {
    resetCachedDbHandle();
    cachedIndexedDbRef = indexedDB;
  }
  if (cachedDbInstance) {
    return Promise.resolve({ db: cachedDbInstance, error: null });
  }
  if (cachedDbPromise) {
    return cachedDbPromise.then((db) =>
      db
        ? { db, error: null }
        : { db: null, error: "INDEXEDDB_OPEN_ERROR" },
    );
  }
  let resolveDb: ((db: IDBDatabase | null) => void) | null = null;
  const openPromise = new Promise<IDBDatabase | null>((resolve) => {
    resolveDb = resolve;
  });
  cachedDbPromise = openPromise;

  return new Promise<TtsDbOpenResult>((resolve) => {
    let settled = false;
    const finish = (result: TtsDbOpenResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cachedDbPromise === openPromise && !result.db) {
        cachedDbPromise = null;
      }
      resolveDb?.(result.db);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ db: null, error: "INDEXEDDB_TIMEOUT" }),
      IDB_OP_TIMEOUT_MS,
    );
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(IDB_META_STORE)) {
          const metaStore = db.createObjectStore(IDB_META_STORE, {
            keyPath: "key",
          });
          // Backfill lightweight metadata store when upgrading from v1.
          try {
            const upgradeTx = req.transaction;
            if (upgradeTx && db.objectStoreNames.contains(IDB_STORE)) {
              const entriesStore = upgradeTx.objectStore(IDB_STORE);
              const cursorReq = entriesStore.openCursor?.();
              if (cursorReq) {
                cursorReq.onsuccess = () => {
                  const cursor = cursorReq.result;
                  if (!cursor) return;
                  const rec = cursor.value as StoredTtsEntry | undefined;
                  if (rec && typeof rec.key === "string") {
                    metaStore.put({
                      key: rec.key,
                      scope: rec.scope === "COACHING" ? "COACHING" : "CATALOG",
                      byteSize: sanitizeByteSize(rec.byteSize, rec.buffer),
                      createdAt: rec.createdAt ?? Date.now(),
                      lastAccessedAt: rec.lastAccessedAt ?? Date.now(),
                    } satisfies StoredTtsMeta);
                  }
                  cursor.continue();
                };
              }
            }
          } catch {
            // Best-effort backfill; fresh writes will populate metadata.
          }
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (settled) {
          safeCloseDb(db);
          return;
        }
        if (isReusableDbHandle(db)) {
          cachedDbInstance = db;
          try {
            db.onclose = () => {
              if (cachedDbInstance === db) {
                resetCachedDbHandle();
              }
            };
            db.onversionchange = () => {
              if (cachedDbInstance === db) {
                safeCloseDb(db);
                resetCachedDbHandle();
              }
            };
          } catch {
            // Ignore non-writable mock IDBDatabase properties in tests
          }
        } else if (cachedDbPromise === openPromise) {
          cachedDbPromise = null;
        }
        finish({ db, error: null });
      };
      req.onerror = () => finish({ db: null, error: "INDEXEDDB_OPEN_ERROR" });
      req.onblocked = () => finish({ db: null, error: "INDEXEDDB_BLOCKED" });
    } catch {
      finish({ db: null, error: "INDEXEDDB_OPEN_ERROR" });
    }
  });
}

async function openTtsDb(): Promise<IDBDatabase | null> {
  const { db } = await openTtsDbWithReason();
  return db;
}

function safeCloseDb(db: IDBDatabase): void {
  try {
    db.close();
  } catch {
    // Ignore close errors
  }
}

function scheduleBackgroundMetaTouch(meta: StoredTtsMeta): void {
  pendingMetaTouches.set(meta.key, meta);
  if (metaTouchTimer !== null) return;
  metaTouchTimer = setTimeout(() => {
    metaTouchTimer = null;
    const batch = Array.from(pendingMetaTouches.values());
    pendingMetaTouches.clear();
    if (!batch.length) return;
    void openTtsDb().then((db) => {
      if (!db || !db.objectStoreNames.contains(IDB_META_STORE)) return;
      try {
        const tx = db.transaction([IDB_META_STORE], "readwrite");
        const metaStore = tx.objectStore(IDB_META_STORE);
        for (const item of batch) {
          metaStore.put(item);
        }
      } catch {
        // Best-effort LRU timestamp refresh
      }
    });
  }, 400);
}

function readAllMetaFromStore(
  store: IDBObjectStore,
  metaStore: IDBObjectStore | null,
  onSuccess: (items: StoredTtsMeta[]) => void,
  onError: () => void,
): void {
  if (metaStore) {
    const req = metaStore.getAll();
    req.onsuccess = () => {
      onSuccess(((req.result as StoredTtsMeta[]) ?? []).slice());
    };
    req.onerror = onError;
    return;
  }
  if (typeof store.openCursor === "function") {
    const collected: StoredTtsMeta[] = [];
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        onSuccess(collected);
        return;
      }
      const rec = cursor.value as Partial<StoredTtsEntry> | undefined;
      if (rec && typeof rec.key === "string") {
        collected.push({
          key: rec.key,
          scope: rec.scope === "COACHING" ? "COACHING" : "CATALOG",
          byteSize:
            typeof rec.byteSize === "number"
              ? rec.byteSize
              : (rec.buffer?.byteLength ?? 0),
          createdAt: typeof rec.createdAt === "number" ? rec.createdAt : 0,
          lastAccessedAt:
            typeof rec.lastAccessedAt === "number" ? rec.lastAccessedAt : 0,
        });
      }
      cursor.continue();
    };
    cursorReq.onerror = onError;
    return;
  }
  const fallbackReq = store.getAll();
  fallbackReq.onsuccess = () => {
    const raw = (fallbackReq.result as Partial<StoredTtsEntry>[]) ?? [];
    onSuccess(
      raw
        .filter((rec): rec is StoredTtsEntry => Boolean(rec && rec.key))
        .map((rec) => ({
          key: rec.key,
          scope: rec.scope === "COACHING" ? "COACHING" : "CATALOG",
          byteSize: rec.byteSize ?? rec.buffer?.byteLength ?? 0,
          createdAt: rec.createdAt ?? 0,
          lastAccessedAt: rec.lastAccessedAt ?? 0,
        })),
    );
  };
  fallbackReq.onerror = onError;
}

async function readStoredTtsEntry(key: string): Promise<StoredTtsEntry | null> {
  const db = await openTtsDb();
  if (!db) {
    cacheMisses += 1;
    return null;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: StoredTtsEntry | null) => {
      if (settled) return;
      settled = true;
      releaseDbHandle(db);
      resolve(result);
    };
    try {
      const tx = db.transaction([IDB_STORE], "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        const rec = req.result as StoredTtsEntry | undefined;
        if (
          !rec ||
          !rec.buffer ||
          (rec.scope !== "CATALOG" && rec.scope !== "COACHING")
        ) {
          cacheMisses += 1;
          finish(null);
          return;
        }
        cacheHits += 1;
        if (isReusableDbHandle(db)) {
          const now = Date.now();
          scheduleBackgroundMetaTouch({
            key: rec.key,
            scope: rec.scope,
            byteSize: rec.byteSize ?? rec.buffer.byteLength,
            createdAt: rec.createdAt ?? now,
            lastAccessedAt: now,
          });
        }
        finish(rec);
      };
      req.onerror = () => {
        cacheMisses += 1;
        finish(null);
      };
      tx.onerror = () => {
        cacheMisses += 1;
        finish(null);
      };
      tx.onabort = () => {
        cacheMisses += 1;
        finish(null);
      };
    } catch {
      cacheMisses += 1;
      finish(null);
    }
  });
}

async function putStoredTtsEntry(input: {
  key: string;
  audio: Blob;
  scope?: TtsCacheScope | null;
  cacheControl?: string | null;
  isPrivateBook?: boolean;
  cachedSpeed?: number | null;
  durationSeconds?: number;
  words?: readonly CachedWordTimingRecord[];
  stepTimings?: readonly CachedPhonicsStepTimingRecord[];
  resolvedVoiceId?: string | null;
  region?: string | null;
  modelVersion?: string | null;
  provider?: string | null;
}): Promise<boolean> {
  if (
    !shouldPersistTtsCacheEntry({
      scope: input.scope,
      cacheControl: input.cacheControl,
      isPrivateBook: input.isPrivateBook,
    })
  ) {
    return false;
  }
  if (!input.audio.size || input.audio.size > MAX_BROWSER_TTS_CACHE_BYTES) {
    return false;
  }
  const db = await openTtsDb();
  if (!db) return false;
  let buffer: ArrayBuffer;
  try {
    buffer = await input.audio.arrayBuffer();
  } catch {
    return false;
  }
  if (!buffer.byteLength || buffer.byteLength > MAX_BROWSER_TTS_CACHE_BYTES) {
    return false;
  }
  const safeScope: "CATALOG" | "COACHING" =
    input.scope === "COACHING" ? "COACHING" : "CATALOG";

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, forceClose = false) => {
      if (settled) return;
      settled = true;
      releaseDbHandle(db, forceClose);
      resolve(ok);
    };
    try {
      const hasMetaStore = db.objectStoreNames.contains(IDB_META_STORE);
      const stores = hasMetaStore ? [IDB_STORE, IDB_META_STORE] : [IDB_STORE];
      const tx = db.transaction(stores, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const metaStore = hasMetaStore ? tx.objectStore(IDB_META_STORE) : null;
      readAllMetaFromStore(
        store,
        metaStore,
        (existing) => {
          const now = Date.now();
          let totalBytes = 0;
          const retained: StoredTtsMeta[] = [];
          for (const item of existing) {
            if (item.key === input.key) continue;
            totalBytes += sanitizeByteSize(item.byteSize);
            retained.push(item);
          }
          retained.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
          while (
            retained.length > 0 &&
            totalBytes + buffer.byteLength > MAX_BROWSER_TTS_CACHE_BYTES
          ) {
            const evicted = retained.shift();
            if (evicted) {
              totalBytes = Math.max(
                0,
                totalBytes - sanitizeByteSize(evicted.byteSize),
              );
              store.delete(evicted.key);
              metaStore?.delete(evicted.key);
            }
          }
          const entry: StoredTtsEntry = {
            key: input.key,
            scope: safeScope,
            contentType: input.audio.type || "audio/mpeg",
            byteSize: buffer.byteLength,
            buffer,
            createdAt: now,
            ...(typeof input.cachedSpeed === "number" &&
            Number.isFinite(input.cachedSpeed) &&
            input.cachedSpeed > 0
              ? { cachedSpeed: input.cachedSpeed }
              : {}),
            ...(typeof input.durationSeconds === "number" &&
            Number.isFinite(input.durationSeconds) &&
            input.durationSeconds > 0
              ? { durationSeconds: input.durationSeconds }
              : {}),
            ...(input.words ? { words: input.words } : {}),
            ...(input.stepTimings ? { stepTimings: input.stepTimings } : {}),
            ...(input.resolvedVoiceId !== undefined
              ? { resolvedVoiceId: input.resolvedVoiceId }
              : {}),
            ...(input.region !== undefined ? { region: input.region } : {}),
            ...(input.modelVersion !== undefined
              ? { modelVersion: input.modelVersion }
              : {}),
            ...(input.provider !== undefined
              ? { provider: input.provider }
              : {}),
            lastAccessedAt: now,
          };
          store.put(entry);
          metaStore?.put({
            key: input.key,
            scope: safeScope,
            byteSize: buffer.byteLength,
            createdAt: now,
            lastAccessedAt: now,
          } satisfies StoredTtsMeta);
        },
        () => finish(false),
      );
      tx.oncomplete = () => {
        finish(true);
      };
      tx.onerror = () => {
        finish(false, true);
      };
      tx.onabort = () => {
        finish(false, true);
      };
    } catch {
      finish(false);
    }
  });
}

export async function getCachedTtsAudio(key: string): Promise<Blob | null> {
  const rec = await readStoredTtsEntry(key);
  if (!rec) return null;
  const blob = new Blob([rec.buffer], {
    type: rec.contentType || "audio/mpeg",
  });
  if (
    typeof rec.cachedSpeed === "number" &&
    Number.isFinite(rec.cachedSpeed) &&
    rec.cachedSpeed > 0
  ) {
    setSynthesizedAudioMeta(blob, {
      resolvedVoiceId: rec.resolvedVoiceId ?? null,
      usedFallbackVoice: false,
      cachedSpeed: rec.cachedSpeed,
    });
  }
  return blob;
}

export async function putCachedTtsAudio(input: {
  key: string;
  audio: Blob;
  scope?: TtsCacheScope | null;
  cacheControl?: string | null;
  isPrivateBook?: boolean;
  cachedSpeed?: number | null;
}): Promise<boolean> {
  return putStoredTtsEntry(input);
}

export async function getCachedTimedTts(
  key: string,
): Promise<CachedTimedTtsEntry | null> {
  const rec = await readStoredTtsEntry(key);
  if (
    !rec ||
    !Array.isArray(rec.words) ||
    !rec.words.length ||
    typeof rec.durationSeconds !== "number" ||
    !Number.isFinite(rec.durationSeconds) ||
    rec.durationSeconds <= 0
  ) {
    return null;
  }
  const blob = new Blob([rec.buffer], {
    type: rec.contentType || "audio/mpeg",
  });
  const cachedSpeed =
    typeof rec.cachedSpeed === "number" &&
    Number.isFinite(rec.cachedSpeed) &&
    rec.cachedSpeed > 0
      ? rec.cachedSpeed
      : null;
  setSynthesizedAudioMeta(blob, {
    resolvedVoiceId: rec.resolvedVoiceId ?? null,
    usedFallbackVoice: false,
    provider: rec.provider ?? "precomputed_cache",
    region: rec.region ?? null,
    modelVersion: rec.modelVersion ?? null,
    cachedSpeed,
  });
  return {
    audio: blob,
    durationSeconds: rec.durationSeconds,
    words: rec.words,
    resolvedVoiceId: rec.resolvedVoiceId ?? null,
    region: rec.region ?? null,
    modelVersion: rec.modelVersion ?? null,
    provider: rec.provider ?? "precomputed_cache",
    cachedSpeed,
  };
}

export async function putCachedTimedTts(input: {
  key: string;
  audio: Blob;
  durationSeconds: number;
  words: readonly CachedWordTimingRecord[];
  scope?: TtsCacheScope | null;
  cacheControl?: string | null;
  isPrivateBook?: boolean;
  resolvedVoiceId?: string | null;
  region?: string | null;
  modelVersion?: string | null;
  provider?: string | null;
  cachedSpeed?: number | null;
}): Promise<boolean> {
  return putStoredTtsEntry(input);
}

export async function getCachedPhonicsTts(
  key: string,
): Promise<CachedPhonicsTtsEntry | null> {
  const rec = await readStoredTtsEntry(key);
  if (
    !rec ||
    !Array.isArray(rec.stepTimings) ||
    !rec.stepTimings.length ||
    typeof rec.durationSeconds !== "number" ||
    !Number.isFinite(rec.durationSeconds) ||
    rec.durationSeconds <= 0
  ) {
    return null;
  }
  const blob = new Blob([rec.buffer], {
    type: rec.contentType || "audio/mpeg",
  });
  const cachedSpeed =
    typeof rec.cachedSpeed === "number" &&
    Number.isFinite(rec.cachedSpeed) &&
    rec.cachedSpeed > 0
      ? rec.cachedSpeed
      : null;
  setSynthesizedAudioMeta(blob, {
    resolvedVoiceId: rec.resolvedVoiceId ?? null,
    usedFallbackVoice: false,
    provider: rec.provider ?? "precomputed_cache",
    region: rec.region ?? null,
    modelVersion: rec.modelVersion ?? null,
    cachedSpeed,
  });
  return {
    audio: blob,
    durationSeconds: rec.durationSeconds,
    stepTimings: rec.stepTimings,
    resolvedVoiceId: rec.resolvedVoiceId ?? null,
    region: rec.region ?? null,
    modelVersion: rec.modelVersion ?? null,
    provider: rec.provider ?? "precomputed_cache",
    cachedSpeed,
  };
}

export async function putCachedPhonicsTts(input: {
  key: string;
  audio: Blob;
  durationSeconds: number;
  stepTimings: readonly CachedPhonicsStepTimingRecord[];
  scope?: TtsCacheScope | null;
  cacheControl?: string | null;
  isPrivateBook?: boolean;
  resolvedVoiceId?: string | null;
  region?: string | null;
  modelVersion?: string | null;
  provider?: string | null;
  cachedSpeed?: number | null;
}): Promise<boolean> {
  return putStoredTtsEntry(input);
}

export async function getBrowserTtsCacheStats(): Promise<BrowserTtsCacheStats> {
  const unavailableStats = (error: string): BrowserTtsCacheStats => ({
    supported: false,
    entryCount: 0,
    usedBytes: 0,
    quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
    hits: cacheHits,
    misses: cacheMisses,
    error,
  });

  if (typeof indexedDB === "undefined") {
    return unavailableStats("INDEXEDDB_UNAVAILABLE");
  }
  const { db, error: openError } = await openTtsDbWithReason();
  if (!db) {
    return unavailableStats(openError ?? "INDEXEDDB_OPEN_ERROR");
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (stats: BrowserTtsCacheStats) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseDbHandle(db);
      resolve(stats);
    };
    const timer = setTimeout(
      () => finish(unavailableStats("INDEXEDDB_TIMEOUT")),
      IDB_OP_TIMEOUT_MS,
    );
    try {
      const targetStore = db.objectStoreNames.contains(IDB_META_STORE)
        ? IDB_META_STORE
        : IDB_STORE;
      if (!db.objectStoreNames.contains(targetStore)) {
        finish({
          supported: true,
          entryCount: 0,
          usedBytes: 0,
          quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
          hits: cacheHits,
          misses: cacheMisses,
          error: null,
        });
        return;
      }
      const tx = db.transaction(targetStore, "readonly");
      tx.onerror = () => finish(unavailableStats("INDEXEDDB_TRANSACTION_ERROR"));
      tx.onabort = () =>
        finish(unavailableStats("INDEXEDDB_TRANSACTION_ABORTED"));
      const objectStore = tx.objectStore(targetStore);
      if (typeof objectStore.openCursor === "function") {
        let entryCount = 0;
        let usedBytes = 0;
        const cursorReq = objectStore.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            finish({
              supported: true,
              entryCount,
              usedBytes,
              quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
              hits: cacheHits,
              misses: cacheMisses,
              error: null,
            });
            return;
          }
          const rec = cursor.value as
            | { byteSize?: unknown; buffer?: ArrayBuffer | null }
            | undefined;
          entryCount += 1;
          usedBytes += sanitizeByteSize(rec?.byteSize, rec?.buffer);
          cursor.continue();
        };
        cursorReq.onerror = () =>
          finish(unavailableStats("INDEXEDDB_CURSOR_ERROR"));
      } else {
        const req = objectStore.getAll();
        req.onsuccess = () => {
          const items =
            (req.result as Array<{
              byteSize?: unknown;
              buffer?: ArrayBuffer | null;
            }>) ?? [];
          let usedBytes = 0;
          for (const item of items) {
            usedBytes += sanitizeByteSize(item?.byteSize, item?.buffer);
          }
          finish({
            supported: true,
            entryCount: items.length,
            usedBytes,
            quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
            hits: cacheHits,
            misses: cacheMisses,
            error: null,
          });
        };
        req.onerror = () => finish(unavailableStats("INDEXEDDB_READ_ERROR"));
      }
    } catch {
      finish(unavailableStats("INDEXEDDB_TRANSACTION_ERROR"));
    }
  });
}

export async function clearBrowserTtsCache(): Promise<boolean> {
  cacheHits = 0;
  cacheMisses = 0;
  if (metaTouchTimer !== null) {
    clearTimeout(metaTouchTimer);
    metaTouchTimer = null;
  }
  pendingMetaTouches.clear();
  if (typeof indexedDB === "undefined") {
    resetCachedDbHandle();
    return false;
  }
  const { db } = await openTtsDbWithReason();
  if (!db) {
    resetCachedDbHandle();
    return false;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      safeCloseDb(db);
      resetCachedDbHandle();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), IDB_OP_TIMEOUT_MS);
    try {
      const hasMetaStore = db.objectStoreNames.contains(IDB_META_STORE);
      const stores = hasMetaStore ? [IDB_STORE, IDB_META_STORE] : [IDB_STORE];
      const tx = db.transaction(stores, "readwrite");
      tx.oncomplete = () => finish(true);
      tx.onerror = () => finish(false);
      tx.onabort = () => finish(false);
      const clearEntriesReq = tx.objectStore(IDB_STORE).clear();
      clearEntriesReq.onerror = () => finish(false);
      if (hasMetaStore) {
        const clearMetaReq = tx.objectStore(IDB_META_STORE).clear();
        clearMetaReq.onerror = () => finish(false);
      }
    } catch {
      finish(false);
    }
  });
}

export async function clearBrowserTtsCacheForTests(): Promise<void> {
  await clearBrowserTtsCache();
}
