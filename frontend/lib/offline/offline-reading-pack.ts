import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";
import { readingPageDtoSchema } from "@/lib/api/reading-service";
import {
  clearAndroidOfflinePacks,
  syncAndroidOfflinePackMeta,
} from "@/lib/reading/native-offline-bridge";

const DB_NAME = "viread-offline-packs-v1";
const DB_VERSION = 1;
const STORE_PACKS = "packs";
const STORE_OUTBOX = "outbox";
const OFFLINE_CHANGE_EVENT = "viread:offline-packs-changed";

export const offlinePackBookSchema = z.object({
  book_id: z.string(),
  title: z.string(),
  author: z.string().nullable().optional(),
  min_grade: z.number().int().min(1).max(5),
  max_grade: z.number().int().min(1).max(5),
  visibility_scope: z.enum(["CATALOG", "PARENT_PRIVATE"]).default("CATALOG"),
  page_count: z.number().int().min(1),
});

export const offlineReadingPackResponseSchema = z.object({
  pack_version: z.number().int().default(1),
  generated_at: z.string(),
  book: offlinePackBookSchema,
  pages: z.array(readingPageDtoSchema),
});

export const offlineReadingSyncResponseSchema = z.object({
  session_id: z.string(),
  idempotent_replay: z.boolean().default(false),
  synced_pages_count: z.number().int().nonnegative(),
  synced_reports_count: z.number().int().nonnegative().default(0),
  synced_events_count: z.number().int().nonnegative(),
  skipped_page_ids: z.array(z.string()).default([]),
});

export type OfflineReadingPackDTO = z.infer<
  typeof offlineReadingPackResponseSchema
>;

export interface StoredOfflineReadingPack {
  readonly key: string;
  readonly userId: string;
  readonly bookId: string;
  readonly savedAt: string;
  readonly cachedAudioByPageId: Readonly<Record<string, string>>;
  readonly pack: OfflineReadingPackDTO;
}

export interface OfflineSyncPageEntry {
  readonly page_id: string;
  readonly page_revision_id: string;
  readonly completed: boolean;
  readonly transcript?: string | null;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
}

export interface OfflineSyncEventEntry {
  readonly page_id: string;
  readonly page_revision_id: string;
  readonly word_id?: string | null;
  readonly type:
    | "OMISSION"
    | "REPETITION"
    | "LONG_PAUSE"
    | "MISPRONUNCIATION"
    | "SUBSTITUTION"
    | "SELF_CORRECTION"
    | "READ_EXAMPLE"
    | "WORD_RETRY";
  readonly status:
    | "DETECTED"
    | "IGNORED_BY_GATE"
    | "FEEDBACK_GIVEN"
    | "CANDIDATE"
    | "CONFIRMED"
    | "FAILED"
    | "UNCERTAIN"
    | "DISMISSED";
  readonly start_ms: number;
  readonly end_ms?: number | null;
  readonly confidence?: number | null;
  readonly metadata?: Record<string, unknown>;
}

export interface OfflineOutboxRecord {
  readonly client_sync_id: string;
  readonly userId: string;
  readonly child_id: string;
  readonly book_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly pages: readonly OfflineSyncPageEntry[];
  readonly events: readonly OfflineSyncEventEntry[];
  readonly created_at: string;
}

// Deterministic fallback map for environments without IndexedDB (e.g. JSDOM tests)
const memoryPacks = new Map<string, StoredOfflineReadingPack>();
const memoryOutbox = new Map<string, OfflineOutboxRecord>();

function emitOfflineChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OFFLINE_CHANGE_EVENT));
  }
}

export function subscribeOfflinePackChanges(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  window.addEventListener(OFFLINE_CHANGE_EVENT, listener);
  return () => window.removeEventListener(OFFLINE_CHANGE_EVENT, listener);
}

function makePackKey(userId: string, bookId: string): string {
  return `${userId.trim()}:${bookId.trim()}`;
}

function createSyncId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `offline-${crypto.randomUUID()}`;
  }
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function openOfflineDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_PACKS)) {
          db.createObjectStore(STORE_PACKS, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          db.createObjectStore(STORE_OUTBOX, { keyPath: "client_sync_id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function putPackRecord(record: StoredOfflineReadingPack): Promise<void> {
  memoryPacks.set(record.key, record);
  const db = await openOfflineDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_PACKS, "readwrite");
      tx.objectStore(STORE_PACKS).put(record);
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

export async function getStoredOfflineReadingPack(
  userId: string,
  bookId: string,
): Promise<StoredOfflineReadingPack | null> {
  const cleanUser = userId.trim();
  const cleanBook = bookId.trim();
  if (!cleanUser || !cleanBook) return null;
  const key = makePackKey(cleanUser, cleanBook);

  const db = await openOfflineDb();
  if (db) {
    const found = await new Promise<StoredOfflineReadingPack | null>(
      (resolve) => {
        try {
          const tx = db.transaction(STORE_PACKS, "readonly");
          const req = tx.objectStore(STORE_PACKS).get(key);
          req.onsuccess = () => {
            db.close();
            const val = req.result as StoredOfflineReadingPack | undefined;
            resolve(val && val.userId === cleanUser ? val : null);
          };
          req.onerror = () => {
            db.close();
            resolve(null);
          };
        } catch {
          db.close();
          resolve(null);
        }
      },
    );
    if (found) {
      memoryPacks.set(key, found);
      return found;
    }
  }

  const mem = memoryPacks.get(key) ?? null;
  return mem && mem.userId === cleanUser ? mem : null;
}

export async function listStoredOfflinePacksForUser(
  userId: string,
): Promise<StoredOfflineReadingPack[]> {
  const cleanUser = userId.trim();
  if (!cleanUser) return [];

  const db = await openOfflineDb();
  if (db) {
    const all = await new Promise<StoredOfflineReadingPack[]>((resolve) => {
      try {
        const tx = db.transaction(STORE_PACKS, "readonly");
        const req = tx.objectStore(STORE_PACKS).getAll();
        req.onsuccess = () => {
          db.close();
          const rows = Array.isArray(req.result)
            ? (req.result as StoredOfflineReadingPack[])
            : [];
          resolve(rows.filter((r) => r && r.userId === cleanUser));
        };
        req.onerror = () => {
          db.close();
          resolve([]);
        };
      } catch {
        db.close();
        resolve([]);
      }
    });
    if (all.length > 0) return all;
  }

  return Array.from(memoryPacks.values()).filter(
    (item) => item.userId === cleanUser,
  );
}

async function syncNativeMetaForUser(userId: string): Promise<void> {
  const packs = await listStoredOfflinePacksForUser(userId);
  await syncAndroidOfflinePackMeta(
    userId,
    packs.map((p) => ({
      bookId: p.bookId,
      title: p.pack.book.title,
      pageCount: p.pack.pages.length,
      savedAt: p.savedAt,
    })),
  );
}

async function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onloadend = () =>
        resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

export async function fetchAndSaveOfflineReadingPack(
  userId: string,
  bookId: string,
  options?: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (percent: number) => void;
  },
): Promise<StoredOfflineReadingPack> {
  const cleanUser = userId.trim();
  const cleanBook = bookId.trim();
  if (!cleanUser || !cleanBook) {
    throw new Error("Missing userId or bookId for offline reading pack.");
  }

  options?.onProgress?.(12);
  const pack = await requestApi(
    `/reading/books/${encodeURIComponent(cleanBook)}/offline-pack`,
    offlineReadingPackResponseSchema,
    options?.signal,
    { method: "GET", bypassCache: true },
  );
  options?.onProgress?.(45);

  const cachedAudioByPageId: Record<string, string> = {};
  const pagesWithAudio = pack.pages.filter(
    (p) =>
      typeof p.tts_audio_url === "string" && p.tts_audio_url.trim().length > 0,
  );

  if (pagesWithAudio.length > 0 && typeof fetch === "function") {
    let completed = 0;
    const concurrency = 2;
    const queue = [...pagesWithAudio];
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        if (options?.signal?.aborted) return;
        const page = queue.shift();
        if (!page) break;
        const audioUrl = page.tts_audio_url;
        if (!audioUrl) continue;
        try {
          const resp = await fetch(audioUrl, {
            method: "GET",
            credentials: "omit",
            signal: options?.signal,
          });
          if (resp.ok) {
            const blob = await resp.blob();
            if (blob.size > 0 && blob.size <= 3 * 1024 * 1024) {
              const dataUrl = await blobToDataUrl(blob);
              if (dataUrl) {
                cachedAudioByPageId[page.page_id] = dataUrl;
              }
            }
          }
        } catch {
          // Audio prefetch is best-effort; verified text & word timings remain offline-ready.
        } finally {
          completed += 1;
          const pct = 45 + Math.round((completed / pagesWithAudio.length) * 45);
          options?.onProgress?.(Math.min(92, pct));
        }
      }
    });
    await Promise.all(workers);
  }

  const stored: StoredOfflineReadingPack = {
    key: makePackKey(cleanUser, cleanBook),
    userId: cleanUser,
    bookId: cleanBook,
    savedAt: new Date().toISOString(),
    cachedAudioByPageId,
    pack,
  };

  await putPackRecord(stored);
  await syncNativeMetaForUser(cleanUser);
  options?.onProgress?.(100);
  emitOfflineChange();
  return stored;
}

export async function removeStoredOfflineReadingPack(
  userId: string,
  bookId: string,
): Promise<void> {
  const cleanUser = userId.trim();
  const cleanBook = bookId.trim();
  if (!cleanUser || !cleanBook) return;
  const key = makePackKey(cleanUser, cleanBook);
  memoryPacks.delete(key);

  const db = await openOfflineDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_PACKS, "readwrite");
        tx.objectStore(STORE_PACKS).delete(key);
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
  await syncNativeMetaForUser(cleanUser);
  emitOfflineChange();
}

export async function enqueueOfflineReadingSession(
  userId: string,
  input: {
    readonly clientSyncId?: string;
    readonly childId: string;
    readonly bookId: string;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly pages: readonly OfflineSyncPageEntry[];
    readonly events?: readonly OfflineSyncEventEntry[];
  },
): Promise<OfflineOutboxRecord> {
  const cleanUser = userId.trim();
  const record: OfflineOutboxRecord = {
    client_sync_id: input.clientSyncId?.trim() || createSyncId(),
    userId: cleanUser,
    child_id: input.childId,
    book_id: input.bookId,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    pages: input.pages,
    events: input.events ?? [],
    created_at: new Date().toISOString(),
  };
  memoryOutbox.set(record.client_sync_id, record);

  const db = await openOfflineDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_OUTBOX, "readwrite");
        tx.objectStore(STORE_OUTBOX).put(record);
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
  emitOfflineChange();
  return record;
}

export async function listPendingOfflineSessions(
  userId: string,
): Promise<OfflineOutboxRecord[]> {
  const cleanUser = userId.trim();
  if (!cleanUser) return [];

  const db = await openOfflineDb();
  if (db) {
    const rows = await new Promise<OfflineOutboxRecord[]>((resolve) => {
      try {
        const tx = db.transaction(STORE_OUTBOX, "readonly");
        const req = tx.objectStore(STORE_OUTBOX).getAll();
        req.onsuccess = () => {
          db.close();
          const all = Array.isArray(req.result)
            ? (req.result as OfflineOutboxRecord[])
            : [];
          resolve(all.filter((r) => r && r.userId === cleanUser));
        };
        req.onerror = () => {
          db.close();
          resolve([]);
        };
      } catch {
        db.close();
        resolve([]);
      }
    });
    if (rows.length > 0) return rows;
  }

  return Array.from(memoryOutbox.values()).filter(
    (item) => item.userId === cleanUser,
  );
}

async function deleteOutboxItem(clientSyncId: string): Promise<void> {
  memoryOutbox.delete(clientSyncId);
  const db = await openOfflineDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_OUTBOX, "readwrite");
      tx.objectStore(STORE_OUTBOX).delete(clientSyncId);
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

export async function syncPendingOfflineSessions(
  userId: string,
): Promise<{ syncedCount: number; failedCount: number }> {
  const pending = await listPendingOfflineSessions(userId);
  if (pending.length === 0) {
    return { syncedCount: 0, failedCount: 0 };
  }

  let syncedCount = 0;
  let failedCount = 0;
  for (const entry of pending) {
    try {
      await requestApi(
        "/reading/offline-sync",
        offlineReadingSyncResponseSchema,
        undefined,
        {
          method: "POST",
          body: {
            client_sync_id: entry.client_sync_id,
            child_id: entry.child_id,
            book_id: entry.book_id,
            started_at: entry.started_at,
            ended_at: entry.ended_at,
            pages: entry.pages,
            events: entry.events,
          },
        },
      );
      await deleteOutboxItem(entry.client_sync_id);
      syncedCount += 1;
    } catch {
      failedCount += 1;
    }
  }
  emitOfflineChange();
  return { syncedCount, failedCount };
}

export async function clearOfflineReadingPacksForUser(
  userId?: string | null,
): Promise<void> {
  if (!userId || !userId.trim()) {
    await clearAllOfflineReadingPacks();
    return;
  }
  const cleanUser = userId.trim();
  for (const [k, v] of memoryPacks.entries()) {
    if (v.userId === cleanUser) memoryPacks.delete(k);
  }
  for (const [k, v] of memoryOutbox.entries()) {
    if (v.userId === cleanUser) memoryOutbox.delete(k);
  }

  const db = await openOfflineDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction([STORE_PACKS, STORE_OUTBOX], "readwrite");
        const pStore = tx.objectStore(STORE_PACKS);
        const oStore = tx.objectStore(STORE_OUTBOX);
        const pReq = pStore.getAll();
        pReq.onsuccess = () => {
          const rows = Array.isArray(pReq.result)
            ? (pReq.result as StoredOfflineReadingPack[])
            : [];
          for (const row of rows) {
            if (row?.userId === cleanUser) pStore.delete(row.key);
          }
        };
        const oReq = oStore.getAll();
        oReq.onsuccess = () => {
          const rows = Array.isArray(oReq.result)
            ? (oReq.result as OfflineOutboxRecord[])
            : [];
          for (const row of rows) {
            if (row?.userId === cleanUser) oStore.delete(row.client_sync_id);
          }
        };
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
  await clearAndroidOfflinePacks();
  emitOfflineChange();
}

export async function clearAllOfflineReadingPacks(): Promise<void> {
  memoryPacks.clear();
  memoryOutbox.clear();
  const db = await openOfflineDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction([STORE_PACKS, STORE_OUTBOX], "readwrite");
        tx.objectStore(STORE_PACKS).clear();
        tx.objectStore(STORE_OUTBOX).clear();
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
  await clearAndroidOfflinePacks();
  emitOfflineChange();
}
