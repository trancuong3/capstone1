/**
 * Persistent Browser TTS Audio Cache (IndexedDB LRU, max 50 MB).
 *
 * Security & privacy invariants:
 * - Caches ONLY `CATALOG` and `COACHING` audio clips.
 * - NEVER persists `PRIVATE` parent-book clips or responses carrying
 *   `Cache-Control: no-store` / `X-TTS-Scope: PRIVATE`.
 */

export type TtsCacheScope = "CATALOG" | "PRIVATE" | "COACHING";

export const MAX_BROWSER_TTS_CACHE_BYTES = 50 * 1024 * 1024;
const IDB_NAME = "viread-tts-audio-v1";
const IDB_STORE = "entries";

interface StoredTtsEntry {
  readonly key: string;
  readonly scope: "CATALOG" | "COACHING";
  readonly contentType: string;
  readonly byteSize: number;
  readonly buffer: ArrayBuffer;
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
      const req = indexedDB.open(IDB_NAME, 1);
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

export async function getCachedTtsAudio(key: string): Promise<Blob | null> {
  const db = await openTtsDb();
  if (!db) {
    cacheMisses += 1;
    return null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
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
          db.close();
          resolve(null);
          return;
        }
        rec.lastAccessedAt = Date.now();
        store.put(rec);
        cacheHits += 1;
        const blob = new Blob([rec.buffer], {
          type: rec.contentType || "audio/mpeg",
        });
        tx.oncomplete = () => {
          db.close();
          resolve(blob);
        };
        tx.onerror = () => {
          db.close();
          resolve(blob);
        };
      };
      req.onerror = () => {
        cacheMisses += 1;
        db.close();
        resolve(null);
      };
    } catch {
      cacheMisses += 1;
      db.close();
      resolve(null);
    }
  });
}

export async function putCachedTtsAudio(input: {
  key: string;
  audio: Blob;
  scope?: TtsCacheScope | null;
  cacheControl?: string | null;
  isPrivateBook?: boolean;
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
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const getAllReq = store.getAll();
      getAllReq.onsuccess = () => {
        const existing = (getAllReq.result as StoredTtsEntry[]) ?? [];
        const now = Date.now();
        let totalBytes = 0;
        const retained: StoredTtsEntry[] = [];
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
            totalBytes -= evicted.byteSize;
            store.delete(evicted.key);
          }
        }
        const entry: StoredTtsEntry = {
          key: input.key,
          scope: safeScope,
          contentType: input.audio.type || "audio/mpeg",
          byteSize: buffer.byteLength,
          buffer,
          createdAt: now,
          lastAccessedAt: now,
        };
        store.put(entry);
      };
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
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
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => {
        const items = (req.result as StoredTtsEntry[]) ?? [];
        const usedBytes = items.reduce((sum, item) => sum + item.byteSize, 0);
        db.close();
        resolve({
          supported: true,
          entryCount: items.length,
          usedBytes,
          quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
          hits: cacheHits,
          misses: cacheMisses,
        });
      };
      req.onerror = () => {
        db.close();
        resolve({
          supported: true,
          entryCount: 0,
          usedBytes: 0,
          quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
          hits: cacheHits,
          misses: cacheMisses,
        });
      };
    } catch {
      db.close();
      resolve({
        supported: true,
        entryCount: 0,
        usedBytes: 0,
        quotaBytes: MAX_BROWSER_TTS_CACHE_BYTES,
        hits: cacheHits,
        misses: cacheMisses,
      });
    }
  });
}

export async function clearBrowserTtsCacheForTests(): Promise<void> {
  cacheHits = 0;
  cacheMisses = 0;
  const db = await openTtsDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
