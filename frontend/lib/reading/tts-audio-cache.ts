/**
 * Persistent Browser TTS Audio Cache (IndexedDB LRU, max 50 MB).
 *
 * Security & privacy invariants:
 * - Caches ONLY `CATALOG` and `COACHING` audio clips.
 * - NEVER persists `PRIVATE` parent-book clips or responses carrying
 *   `Cache-Control: no-store` / `X-TTS-Scope: PRIVATE`.
 */

import { setSynthesizedAudioMeta } from "@/lib/reading/synthesized-audio-meta";

export type TtsCacheScope = "CATALOG" | "PRIVATE" | "COACHING";

export const MAX_BROWSER_TTS_CACHE_BYTES = 50 * 1024 * 1024;
const IDB_NAME = "viread-tts-audio-v1";
const IDB_VERSION = 2;
const IDB_STORE = "entries";
const IDB_META_STORE = "meta";

interface StoredTtsEntry {
  readonly key: string;
  readonly scope: "CATALOG" | "COACHING";
  readonly contentType: string;
  readonly byteSize: number;
  readonly buffer: ArrayBuffer;
  readonly createdAt: number;
  readonly cachedSpeed?: number | null;
  lastAccessedAt: number;
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
}

let cacheHits = 0;
let cacheMisses = 0;

export function shouldPersistTtsCacheEntry(options: {
  scope?: TtsCacheScope | null;
  cacheControl?: string | null;
  isPrivateBook?: boolean;
}): boolean {
  if (options.isPrivateBook) return false;
  if (options.scope === "PRIVATE") return false;
  if ((options.cacheControl ?? "").toLowerCase().includes("no-store")) {
    return false;
  }
  return true;
}

export function buildTtsBrowserCacheKey(input: {
  kind: "short" | "timed" | "phonics";
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

function openTtsDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
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
                      byteSize: rec.byteSize ?? rec.buffer?.byteLength ?? 0,
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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function safeCloseDb(db: IDBDatabase): void {
  try {
    db.close();
  } catch {
    // Ignore close errors
  }
}

export async function getCachedTtsAudio(key: string): Promise<Blob | null> {
  const db = await openTtsDb();
  if (!db) {
    cacheMisses += 1;
    return null;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Blob | null) => {
      if (settled) return;
      settled = true;
      safeCloseDb(db);
      resolve(result);
    };
    try {
      const hasMetaStore = db.objectStoreNames.contains(IDB_META_STORE);
      const stores = hasMetaStore ? [IDB_STORE, IDB_META_STORE] : [IDB_STORE];
      const tx = db.transaction(stores, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const metaStore = hasMetaStore ? tx.objectStore(IDB_META_STORE) : null;
      let hitBlob: Blob | null = null;
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
        const now = Date.now();
        if (metaStore) {
          metaStore.put({
            key: rec.key,
            scope: rec.scope,
            byteSize: rec.byteSize ?? rec.buffer.byteLength,
            createdAt: rec.createdAt ?? now,
            lastAccessedAt: now,
          } satisfies StoredTtsMeta);
        } else {
          rec.lastAccessedAt = now;
          store.put(rec);
        }
        cacheHits += 1;
        const blob = new Blob([rec.buffer], {
          type: rec.contentType || "audio/mpeg",
        });
        if (
          typeof rec.cachedSpeed === "number" &&
          Number.isFinite(rec.cachedSpeed) &&
          rec.cachedSpeed > 0
        ) {
          setSynthesizedAudioMeta(blob, {
            resolvedVoiceId: null,
            usedFallbackVoice: false,
            cachedSpeed: rec.cachedSpeed,
          });
        }
        hitBlob = blob;
      };
      req.onerror = () => {
        cacheMisses += 1;
        finish(null);
      };
      tx.oncomplete = () => {
        finish(hitBlob);
      };
      tx.onerror = () => {
        finish(hitBlob);
      };
      tx.onabort = () => {
        finish(hitBlob);
      };
    } catch {
      cacheMisses += 1;
      finish(null);
    }
  });
}

export async function putCachedTtsAudio(input: {
  key: string;
  audio: Blob;
  scope?: TtsCacheScope | null;
  cacheControl?: string | null;
  isPrivateBook?: boolean;
  cachedSpeed?: number | null;
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
  const buffer = await input.audio.arrayBuffer();
  const safeScope: "CATALOG" | "COACHING" =
    input.scope === "COACHING" ? "COACHING" : "CATALOG";

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      safeCloseDb(db);
      resolve(ok);
    };
    try {
      const hasMetaStore = db.objectStoreNames.contains(IDB_META_STORE);
      const stores = hasMetaStore ? [IDB_STORE, IDB_META_STORE] : [IDB_STORE];
      const tx = db.transaction(stores, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const metaStore = hasMetaStore ? tx.objectStore(IDB_META_STORE) : null;
      // Read ONLY lightweight metadata (no ArrayBuffer blobs) for LRU accounting.
      const metaReq = (metaStore ?? store).getAll();
      metaReq.onsuccess = () => {
        const existing = (metaReq.result as StoredTtsMeta[]) ?? [];
        const now = Date.now();
        let totalBytes = 0;
        const retained: StoredTtsMeta[] = [];
        for (const item of existing) {
          if (item.key === input.key) continue;
          totalBytes += item.byteSize;
          retained.push(item);
        }
        retained.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
        while (
          retained.length > 0 &&
          totalBytes + buffer.byteLength > MAX_BROWSER_TTS_CACHE_BYTES
        ) {
          const evicted = retained.shift();
          if (evicted) {
            totalBytes = Math.max(0, totalBytes - evicted.byteSize);
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
      };
      metaReq.onerror = () => {
        finish(false);
      };
      tx.oncomplete = () => {
        finish(true);
      };
      tx.onerror = () => {
        finish(false);
      };
      tx.onabort = () => {
        finish(false);
      };
    } catch {
      finish(false);
    }
  });
}

export async function getBrowserTtsCacheStats(): Promise<BrowserTtsCacheStats> {
  if (typeof indexedDB === "undefined") {
    return {
      supported: false,
      entryCount: 0,
      usedBytes: 0,
      quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
      hits: cacheHits,
      misses: cacheMisses,
    };
  }
  const db = await openTtsDb();
  if (!db) {
    return {
      supported: false,
      entryCount: 0,
      usedBytes: 0,
      quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
      hits: cacheHits,
      misses: cacheMisses,
    };
  }
  return new Promise((resolve) => {
    let settled = false;
    const emptyStats = (): BrowserTtsCacheStats => ({
      supported: true,
      entryCount: 0,
      usedBytes: 0,
      quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
      hits: cacheHits,
      misses: cacheMisses,
    });
    const finish = (stats: BrowserTtsCacheStats) => {
      if (settled) return;
      settled = true;
      safeCloseDb(db);
      resolve(stats);
    };
    try {
      const targetStore = db.objectStoreNames.contains(IDB_META_STORE)
        ? IDB_META_STORE
        : IDB_STORE;
      const tx = db.transaction(targetStore, "readonly");
      const req = tx.objectStore(targetStore).getAll();
      req.onsuccess = () => {
        const items = (req.result as StoredTtsMeta[]) ?? [];
        const usedBytes = items.reduce((sum, item) => sum + item.byteSize, 0);
        finish({
          supported: true,
          entryCount: items.length,
          usedBytes,
          quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
          hits: cacheHits,
          misses: cacheMisses,
        });
      };
      req.onerror = () => finish(emptyStats());
      tx.onerror = () => finish(emptyStats());
      tx.onabort = () => finish(emptyStats());
    } catch {
      finish(emptyStats());
    }
  });
}

export async function clearBrowserTtsCacheForTests(): Promise<void> {
  cacheHits = 0;
  cacheMisses = 0;
  const db = await openTtsDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      safeCloseDb(db);
      resolve();
    };
    try {
      const hasMetaStore = db.objectStoreNames.contains(IDB_META_STORE);
      const stores = hasMetaStore ? [IDB_STORE, IDB_META_STORE] : [IDB_STORE];
      const tx = db.transaction(stores, "readwrite");
      tx.objectStore(IDB_STORE).clear();
      if (hasMetaStore) {
        tx.objectStore(IDB_META_STORE).clear();
      }
      tx.oncomplete = finish;
      tx.onerror = finish;
      tx.onabort = finish;
    } catch {
      finish();
    }
  });
}
