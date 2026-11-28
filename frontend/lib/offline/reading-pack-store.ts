/**
 * Feature #8: Partitioned Offline Reading Pack Store (`reading-pack-store.ts`).
 *
 * Security & multi-user hygiene invariants (per `android/OFFLINE_POC_ARCHITECTURE.md`):
 * 1. Every offline book pack, page image, TTS audio clip, and active offline session
 *    descriptor is strictly partitioned by `(parentAccountId, childProfileId)`.
 * 2. `PARENT_PRIVATE` books may ONLY be stored in that owning parent's partition —
 *    cross-parent manifests are rejected on write and never placed in shared Cache Storage.
 * 3. `deleteOfflinePacksForAccount()` purges all IndexedDB + in-memory + partitioned
 *    Cache Storage entries for a signed-out or deactivated parent account.
 */

import { z, type ZodType } from "zod";

import { requestApi } from "@/lib/api/api-client";
import { getBrowserAccessToken } from "@/lib/api/browser-auth";
import { getApiBaseUrl } from "@/lib/supabase/config";
import type { BookDetailDTO, BookVisibilityScope } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type {
  ReadingPageDTO,
  ReadingPageWordDTO,
  ReadingPageWordTimingDTO,
} from "@/types/reading";

export const OFFLINE_PACK_IDB_NAME = "viread-offline-reading-packs-v1";
const OFFLINE_PACK_IDB_VERSION = 1;
const PACKS_STORE = "packs";
const BLOBS_STORE = "blobs";
const SESSIONS_STORE = "sessions";
const IDB_TIMEOUT_MS = 4_000;
export const OFFLINE_CACHE_STORAGE_PREFIX = "viread-offline-pack:";
export const MAX_WEEKLY_PLAN_OFFLINE_BOOKS = 3;
export const DEFAULT_ESTIMATED_BYTES_PER_PAGE = 145 * 1024;

export interface OfflinePackWordManifestItem {
  readonly word_id: string;
  readonly word_index: number;
  readonly line_index?: number;
  readonly text: string;
  readonly normalized_text?: string;
  readonly bbox: readonly [number, number, number, number];
}

export interface OfflinePackPageTtsManifest {
  readonly cached: boolean;
  readonly cache_scope: "CATALOG" | "PRIVATE";
  readonly voice_id: string;
  readonly model_version?: string | null;
  readonly speed: number;
  readonly audio_format?: string | null;
  readonly byte_size: number;
  readonly duration_seconds?: number | null;
  readonly audio_url?: string | null;
  readonly inline_audio_base64?: string | null;
  readonly word_timings?: readonly ReadingPageWordTimingDTO[] | null;
}

export interface OfflinePackPageManifest {
  readonly page_id: string;
  readonly page_number: number;
  readonly page_revision_id: string;
  readonly width: number;
  readonly height: number;
  readonly verified_text: string;
  readonly words: readonly OfflinePackWordManifestItem[];
  readonly phonics_keyterms: readonly string[];
  readonly image_url?: string | null;
  readonly tts_audio?: OfflinePackPageTtsManifest | null;
}

export interface OfflineReadingPackManifestDTO {
  readonly manifest_version: number;
  readonly parent_account_id: string;
  readonly child_profile_id: string;
  readonly book_id: string;
  readonly title: string;
  readonly author: string | null;
  readonly grade: number;
  readonly min_grade: number;
  readonly max_grade: number;
  readonly visibility_scope: BookVisibilityScope;
  readonly cover_url?: string | null;
  readonly voice_id: string;
  readonly estimated_bytes: number;
  readonly tts_budget_bytes: number;
  readonly generated_at: string;
  readonly pages: readonly OfflinePackPageManifest[];
}

export interface StoredOfflineBookPackSummary {
  readonly partitionKey: string;
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly bookId: string;
  readonly title: string;
  readonly author: string | null;
  readonly grade: number;
  readonly minGrade: number;
  readonly maxGrade: number;
  readonly visibilityScope: BookVisibilityScope;
  readonly pageCount: number;
  readonly storedBytes: number;
  readonly hasCachedTts: boolean;
  readonly downloadedAt: number;
}

interface StoredPackRecord {
  readonly partitionBookKey: string;
  readonly partitionKey: string;
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly bookId: string;
  readonly visibilityScope: BookVisibilityScope;
  readonly manifest: OfflineReadingPackManifestDTO;
  readonly storedBytes: number;
  readonly hasCachedTts: boolean;
  readonly downloadedAt: number;
}

interface StoredBlobRecord {
  readonly blobKey: string;
  readonly partitionKey: string;
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly bookId: string;
  readonly pageId: string;
  readonly kind: "image" | "tts";
  readonly contentType: string;
  readonly byteSize: number;
  readonly bytes: Uint8Array;
}

export interface OfflineSessionDescriptor {
  readonly sessionKey: string;
  readonly sessionId: string;
  readonly clientSessionId: string;
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly bookId: string;
  readonly child: ChildProfileDTO;
  readonly startPageId: string | null;
  readonly endPageId: string | null;
  readonly currentPageId: string | null;
  readonly updatedAt: number;
}

export interface LoadedOfflineBookPack {
  readonly summary: StoredOfflineBookPackSummary;
  readonly manifest: OfflineReadingPackManifestDTO;
  readonly book: BookDetailDTO;
  readonly pages: readonly ReadingPageDTO[];
  readonly phonicsKeytermsByPageId: Readonly<Record<string, readonly string[]>>;
}

export interface SaveOfflineBookPackInput {
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly manifest: OfflineReadingPackManifestDTO;
  readonly pageImages?: Readonly<
    Record<string, Blob | Uint8Array | ArrayBuffer>
  >;
  readonly pageTtsClips?: Readonly<
    Record<string, Blob | Uint8Array | ArrayBuffer>
  >;
}

export interface DownloadOfflineBookPackOptions {
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly bookId: string;
  readonly signal?: AbortSignal;
  readonly fetchManifest?: (
    childId: string,
    bookId: string,
    signal?: AbortSignal,
  ) => Promise<OfflineReadingPackManifestDTO>;
  readonly fetchBinary?: (
    url: string,
    isPrivate: boolean,
    signal?: AbortSignal,
  ) => Promise<Blob | null>;
}

export interface DownloadWeeklyPlanPacksOptions {
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly bookIds: readonly string[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number, bookId: string) => void;
  readonly fetchManifest?: DownloadOfflineBookPackOptions["fetchManifest"];
  readonly fetchBinary?: DownloadOfflineBookPackOptions["fetchBinary"];
}

// In-memory mirror & fallback (strictly keyed by partitionBookKey / blobKey / sessionKey)
const memoryPacks = new Map<string, StoredPackRecord>();
const memoryBlobs = new Map<string, StoredBlobRecord>();
const memorySessions = new Map<string, OfflineSessionDescriptor>();
const storeListeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of storeListeners) {
    try {
      listener();
    } catch {
      // Ignore subscriber errors
    }
  }
}

export function subscribeOfflinePackStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

function requireValidScopeSegment(raw: string, fieldName: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${fieldName} is required for offline partition isolation`);
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("|") || trimmed.includes("\0")) {
    throw new Error(`Invalid ${fieldName} for offline partition isolation`);
  }
  return trimmed;
}

export function buildOfflinePartitionKey(
  parentAccountId: string,
  childProfileId: string,
): string {
  const pid = requireValidScopeSegment(parentAccountId, "parentAccountId");
  const cid = requireValidScopeSegment(childProfileId, "childProfileId");
  return `p:${encodeURIComponent(pid)}|c:${encodeURIComponent(cid)}`;
}

function buildPartitionBookKey(partitionKey: string, bookId: string): string {
  const bid = requireValidScopeSegment(bookId, "bookId");
  return `${partitionKey}|b:${encodeURIComponent(bid)}`;
}

function buildBlobKey(
  partitionKey: string,
  bookId: string,
  pageId: string,
  kind: "image" | "tts",
): string {
  const bid = requireValidScopeSegment(bookId, "bookId");
  const pgid = requireValidScopeSegment(pageId, "pageId");
  return `${partitionKey}|b:${encodeURIComponent(bid)}|p:${encodeURIComponent(pgid)}|${kind}`;
}

function buildCacheStorageName(
  parentAccountId: string,
  childProfileId: string,
): string {
  const pid = requireValidScopeSegment(parentAccountId, "parentAccountId");
  const cid = requireValidScopeSegment(childProfileId, "childProfileId");
  return `${OFFLINE_CACHE_STORAGE_PREFIX}${encodeURIComponent(pid)}:${encodeURIComponent(cid)}`;
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function normalizeBinaryInput(
  raw: Blob | Uint8Array | ArrayBuffer,
  fallbackType: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (raw instanceof Uint8Array) {
    return { bytes: new Uint8Array(raw), contentType: fallbackType };
  }
  if (raw instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(raw.slice(0)), contentType: fallbackType };
  }
  const contentType = raw.type || fallbackType;
  if (typeof raw.arrayBuffer === "function") {
    const buf = await raw.arrayBuffer();
    return { bytes: new Uint8Array(buf), contentType };
  }
  const res = new Response(raw);
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf), contentType };
}

function openOfflinePackDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), IDB_TIMEOUT_MS);
    try {
      const req = indexedDB.open(
        OFFLINE_PACK_IDB_NAME,
        OFFLINE_PACK_IDB_VERSION,
      );
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PACKS_STORE)) {
          db.createObjectStore(PACKS_STORE, { keyPath: "partitionBookKey" });
        }
        if (!db.objectStoreNames.contains(BLOBS_STORE)) {
          db.createObjectStore(BLOBS_STORE, { keyPath: "blobKey" });
        }
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          db.createObjectStore(SESSIONS_STORE, { keyPath: "sessionKey" });
        }
      };
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
      req.onsuccess = () => {
        if (settled) {
          try {
            req.result.close();
          } catch {
            // Ignore
          }
          return;
        }
        finish(req.result);
      };
    } catch {
      finish(null);
    }
  });
}

function safeCloseDb(db: IDBDatabase | null): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Ignore close errors
  }
}

function toSummary(record: StoredPackRecord): StoredOfflineBookPackSummary {
  return {
    partitionKey: record.partitionKey,
    parentAccountId: record.parentAccountId,
    childProfileId: record.childProfileId,
    bookId: record.bookId,
    title: record.manifest.title,
    author: record.manifest.author,
    grade: record.manifest.grade,
    minGrade: record.manifest.min_grade,
    maxGrade: record.manifest.max_grade,
    visibilityScope: record.visibilityScope,
    pageCount: record.manifest.pages.length,
    storedBytes: record.storedBytes,
    hasCachedTts: record.hasCachedTts,
    downloadedAt: record.downloadedAt,
  };
}

export function estimateOfflineBookPackBytes(pageCount = 4): number {
  const safePages = Math.max(1, Math.min(40, Math.round(pageCount)));
  return safePages * DEFAULT_ESTIMATED_BYTES_PER_PAGE;
}

export async function saveOfflineBookPack(
  input: SaveOfflineBookPackInput,
): Promise<StoredOfflineBookPackSummary> {
  const parentId = requireValidScopeSegment(
    input.parentAccountId,
    "parentAccountId",
  );
  const childId = requireValidScopeSegment(
    input.childProfileId,
    "childProfileId",
  );
  const manifest = input.manifest;
  const bookId = requireValidScopeSegment(manifest.book_id, "bookId");

  // Strict household isolation guard: manifest must match the target (parent, child) partition.
  if (
    manifest.parent_account_id &&
    manifest.parent_account_id.trim() !== parentId
  ) {
    throw new Error(
      "Cross-parent offline pack write blocked: manifest owner does not match active parent account.",
    );
  }
  if (
    manifest.child_profile_id &&
    manifest.child_profile_id.trim() !== childId
  ) {
    throw new Error(
      "Cross-child offline pack write blocked: manifest child does not match active child profile.",
    );
  }

  const partitionKey = buildOfflinePartitionKey(parentId, childId);
  const partitionBookKey = buildPartitionBookKey(partitionKey, bookId);
  const blobRecords: StoredBlobRecord[] = [];
  let totalBytes = new TextEncoder().encode(
    JSON.stringify(manifest),
  ).byteLength;
  let hasCachedTts = false;

  for (const page of manifest.pages) {
    const rawImg = input.pageImages?.[page.page_id];
    if (rawImg) {
      const normalized = await normalizeBinaryInput(rawImg, "image/webp");
      if (normalized.bytes.byteLength > 0) {
        totalBytes += normalized.bytes.byteLength;
        blobRecords.push({
          blobKey: buildBlobKey(partitionKey, bookId, page.page_id, "image"),
          partitionKey,
          parentAccountId: parentId,
          childProfileId: childId,
          bookId,
          pageId: page.page_id,
          kind: "image",
          contentType: normalized.contentType,
          byteSize: normalized.bytes.byteLength,
          bytes: normalized.bytes,
        });
      }
    }

    const explicitTts = input.pageTtsClips?.[page.page_id];
    if (explicitTts) {
      const normalized = await normalizeBinaryInput(
        explicitTts,
        page.tts_audio?.audio_format || "audio/mpeg",
      );
      if (normalized.bytes.byteLength > 0) {
        hasCachedTts = true;
        totalBytes += normalized.bytes.byteLength;
        blobRecords.push({
          blobKey: buildBlobKey(partitionKey, bookId, page.page_id, "tts"),
          partitionKey,
          parentAccountId: parentId,
          childProfileId: childId,
          bookId,
          pageId: page.page_id,
          kind: "tts",
          contentType: normalized.contentType,
          byteSize: normalized.bytes.byteLength,
          bytes: normalized.bytes,
        });
      }
    } else if (page.tts_audio?.inline_audio_base64) {
      const decoded = decodeBase64ToBytes(page.tts_audio.inline_audio_base64);
      if (decoded.byteLength > 0) {
        hasCachedTts = true;
        totalBytes += decoded.byteLength;
        blobRecords.push({
          blobKey: buildBlobKey(partitionKey, bookId, page.page_id, "tts"),
          partitionKey,
          parentAccountId: parentId,
          childProfileId: childId,
          bookId,
          pageId: page.page_id,
          kind: "tts",
          contentType: page.tts_audio.audio_format || "audio/mpeg",
          byteSize: decoded.byteLength,
          bytes: decoded,
        });
      }
    }
  }

  // Strip inline base64 from persisted manifest JSON once extracted to binary blob store
  const compactManifest: OfflineReadingPackManifestDTO = {
    ...manifest,
    parent_account_id: parentId,
    child_profile_id: childId,
    pages: manifest.pages.map((p) =>
      p.tts_audio?.inline_audio_base64
        ? {
            ...p,
            tts_audio: {
              ...p.tts_audio,
              inline_audio_base64: null,
            },
          }
        : p,
    ),
  };

  const packRecord: StoredPackRecord = {
    partitionBookKey,
    partitionKey,
    parentAccountId: parentId,
    childProfileId: childId,
    bookId,
    visibilityScope: compactManifest.visibility_scope,
    manifest: compactManifest,
    storedBytes: totalBytes,
    hasCachedTts,
    downloadedAt: Date.now(),
  };

  // Update memory store synchronously
  for (const key of Array.from(memoryBlobs.keys())) {
    if (key.startsWith(`${partitionBookKey}|`)) {
      memoryBlobs.delete(key);
    }
  }
  memoryPacks.set(partitionBookKey, packRecord);
  for (const blobRec of blobRecords) {
    memoryBlobs.set(blobRec.blobKey, blobRec);
  }

  // Mirror CATALOG media into strictly partitioned Cache Storage when available;
  // NEVER write PARENT_PRIVATE assets into Cache Storage (`no-store`IndexedDB only).
  if (
    compactManifest.visibility_scope === "CATALOG" &&
    typeof caches !== "undefined" &&
    blobRecords.length > 0
  ) {
    try {
      const cache = await caches.open(buildCacheStorageName(parentId, childId));
      for (const blobRec of blobRecords) {
        const syntheticUrl = `https://offline.viread.local/${encodeURIComponent(parentId)}/${encodeURIComponent(childId)}/${encodeURIComponent(bookId)}/${encodeURIComponent(blobRec.pageId)}/${blobRec.kind}`;
        await cache.put(
          syntheticUrl,
          new Response(blobRec.bytes.slice(0), {
            headers: { "Content-Type": blobRec.contentType },
          }),
        );
      }
    } catch {
      // Ignore Cache Storage errors in restricted contexts
    }
  }

  const db = await openOfflinePackDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction([PACKS_STORE, BLOBS_STORE], "readwrite");
        tx.oncomplete = () => {
          safeCloseDb(db);
          resolve();
        };
        tx.onerror = () => {
          safeCloseDb(db);
          resolve();
        };
        tx.onabort = () => {
          safeCloseDb(db);
          resolve();
        };
        tx.objectStore(PACKS_STORE).put(packRecord);
        const blobStore = tx.objectStore(BLOBS_STORE);
        for (const blobRec of blobRecords) {
          blobStore.put(blobRec);
        }
      } catch {
        safeCloseDb(db);
        resolve();
      }
    });
  }

  notifyListeners();
  return toSummary(packRecord);
}

async function readPackRecord(
  parentAccountId: string,
  childProfileId: string,
  bookId: string,
): Promise<StoredPackRecord | null> {
  const parentId = requireValidScopeSegment(parentAccountId, "parentAccountId");
  const childId = requireValidScopeSegment(childProfileId, "childProfileId");
  const partitionKey = buildOfflinePartitionKey(parentId, childId);
  const partitionBookKey = buildPartitionBookKey(partitionKey, bookId);

  const mem = memoryPacks.get(partitionBookKey);
  if (
    mem &&
    mem.parentAccountId === parentId &&
    mem.childProfileId === childId
  ) {
    return mem;
  }

  const db = await openOfflinePackDb();
  if (!db) return null;
  return new Promise<StoredPackRecord | null>((resolve) => {
    try {
      const tx = db.transaction(PACKS_STORE, "readonly");
      const req = tx.objectStore(PACKS_STORE).get(partitionBookKey);
      req.onsuccess = () => {
        const rec = req.result as StoredPackRecord | undefined;
        safeCloseDb(db);
        if (
          rec &&
          rec.parentAccountId === parentId &&
          rec.childProfileId === childId
        ) {
          memoryPacks.set(partitionBookKey, rec);
          resolve(rec);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        safeCloseDb(db);
        resolve(null);
      };
    } catch {
      safeCloseDb(db);
      resolve(null);
    }
  });
}

export async function getOfflinePageMediaBlob(
  parentAccountId: string,
  childProfileId: string,
  bookId: string,
  pageId: string,
  kind: "image" | "tts",
): Promise<Blob | null> {
  const parentId = requireValidScopeSegment(parentAccountId, "parentAccountId");
  const childId = requireValidScopeSegment(childProfileId, "childProfileId");
  const partitionKey = buildOfflinePartitionKey(parentId, childId);
  const blobKey = buildBlobKey(partitionKey, bookId, pageId, kind);

  const mem = memoryBlobs.get(blobKey);
  if (
    mem &&
    mem.parentAccountId === parentId &&
    mem.childProfileId === childId
  ) {
    return new Blob([mem.bytes.slice(0)], { type: mem.contentType });
  }

  const db = await openOfflinePackDb();
  if (!db) return null;
  return new Promise<Blob | null>((resolve) => {
    try {
      const tx = db.transaction(BLOBS_STORE, "readonly");
      const req = tx.objectStore(BLOBS_STORE).get(blobKey);
      req.onsuccess = () => {
        const rec = req.result as StoredBlobRecord | undefined;
        safeCloseDb(db);
        if (
          rec &&
          rec.parentAccountId === parentId &&
          rec.childProfileId === childId &&
          rec.bytes
        ) {
          const bytes =
            rec.bytes instanceof Uint8Array
              ? rec.bytes
              : new Uint8Array(rec.bytes as ArrayBuffer);
          const normalizedRec: StoredBlobRecord = { ...rec, bytes };
          memoryBlobs.set(blobKey, normalizedRec);
          resolve(new Blob([bytes.slice(0)], { type: rec.contentType }));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        safeCloseDb(db);
        resolve(null);
      };
    } catch {
      safeCloseDb(db);
      resolve(null);
    }
  });
}

export async function getOfflineBookPack(
  parentAccountId: string,
  childProfileId: string,
  bookId: string,
): Promise<LoadedOfflineBookPack | null> {
  const record = await readPackRecord(parentAccountId, childProfileId, bookId);
  if (!record) return null;

  const { manifest } = record;
  const book: BookDetailDTO = {
    id: manifest.book_id,
    title: manifest.title,
    author: manifest.author,
    min_grade: manifest.min_grade,
    max_grade: manifest.max_grade,
    lifecycle_status: "ACTIVE",
    visibility_scope: manifest.visibility_scope,
    cover_url: manifest.cover_url ?? null,
  };

  const phonicsKeytermsByPageId: Record<string, readonly string[]> = {};
  const pages: ReadingPageDTO[] = [];

  for (const page of manifest.pages) {
    phonicsKeytermsByPageId[page.page_id] = page.phonics_keyterms;
    const words: ReadingPageWordDTO[] = page.words.map((w) => ({
      word_id: w.word_id,
      word_index: w.word_index,
      line_index: w.line_index ?? 0,
      text: w.text,
      bbox: [w.bbox[0], w.bbox[1], w.bbox[2], w.bbox[3]],
    }));

    const cachedImageBlob = await getOfflinePageMediaBlob(
      record.parentAccountId,
      record.childProfileId,
      manifest.book_id,
      page.page_id,
      "image",
    );
    let imageUrl = page.image_url ?? null;
    if (
      cachedImageBlob &&
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function"
    ) {
      try {
        imageUrl = URL.createObjectURL(cachedImageBlob);
      } catch {
        // Keep manifest fallback URL if createObjectURL is unavailable
      }
    }

    pages.push({
      page_id: page.page_id,
      page_revision_id: page.page_revision_id,
      page_number: page.page_number,
      confidence: null,
      width: page.width,
      height: page.height,
      image_url: imageUrl,
      tts_audio_url: null,
      tts_word_timings: page.tts_audio?.word_timings
        ? [...page.tts_audio.word_timings]
        : null,
      tts_voice_id: page.tts_audio?.voice_id ?? manifest.voice_id,
      tts_cached_speed: page.tts_audio?.speed ?? 1.0,
      image_overlay_safe: false,
      illustration_url: null,
      illustration_text_free: false,
      text: page.verified_text,
      words,
      paragraph_start_line_indices: [],
      indented_line_indices: [],
    });
  }

  pages.sort((a, b) => a.page_number - b.page_number);

  return {
    summary: toSummary(record),
    manifest,
    book,
    pages,
    phonicsKeytermsByPageId,
  };
}

export async function listOfflineBookPacks(
  parentAccountId: string,
  childProfileId: string,
): Promise<StoredOfflineBookPackSummary[]> {
  let parentId: string;
  let childId: string;
  try {
    parentId = requireValidScopeSegment(parentAccountId, "parentAccountId");
    childId = requireValidScopeSegment(childProfileId, "childProfileId");
  } catch {
    return [];
  }
  const partitionKey = buildOfflinePartitionKey(parentId, childId);
  const byBookKey = new Map<string, StoredPackRecord>();

  for (const [k, rec] of memoryPacks.entries()) {
    if (
      rec.partitionKey === partitionKey &&
      rec.parentAccountId === parentId &&
      rec.childProfileId === childId
    ) {
      byBookKey.set(k, rec);
    }
  }

  const db = await openOfflinePackDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(PACKS_STORE, "readonly");
        const req = tx.objectStore(PACKS_STORE).getAll();
        req.onsuccess = () => {
          const rows = (req.result as StoredPackRecord[] | undefined) ?? [];
          for (const rec of rows) {
            if (
              rec &&
              rec.partitionKey === partitionKey &&
              rec.parentAccountId === parentId &&
              rec.childProfileId === childId
            ) {
              memoryPacks.set(rec.partitionBookKey, rec);
              byBookKey.set(rec.partitionBookKey, rec);
            }
          }
          safeCloseDb(db);
          resolve();
        };
        req.onerror = () => {
          safeCloseDb(db);
          resolve();
        };
      } catch {
        safeCloseDb(db);
        resolve();
      }
    });
  }

  return Array.from(byBookKey.values())
    .sort((a, b) => b.downloadedAt - a.downloadedAt)
    .map(toSummary);
}

export async function deleteOfflineBookPack(
  parentAccountId: string,
  childProfileId: string,
  bookId: string,
): Promise<boolean> {
  const parentId = requireValidScopeSegment(parentAccountId, "parentAccountId");
  const childId = requireValidScopeSegment(childProfileId, "childProfileId");
  const partitionKey = buildOfflinePartitionKey(parentId, childId);
  const partitionBookKey = buildPartitionBookKey(partitionKey, bookId);

  let existed = memoryPacks.delete(partitionBookKey);
  for (const key of Array.from(memoryBlobs.keys())) {
    if (key.startsWith(`${partitionBookKey}|`)) {
      memoryBlobs.delete(key);
    }
  }

  if (typeof caches !== "undefined") {
    try {
      const cacheName = buildCacheStorageName(parentId, childId);
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      const bookSegment = `/${encodeURIComponent(parentId)}/${encodeURIComponent(childId)}/${encodeURIComponent(bookId)}/`;
      await Promise.all(
        requests
          .filter((req) => req.url.includes(bookSegment))
          .map((req) => cache.delete(req)),
      );
    } catch {
      // Ignore Cache Storage delete errors
    }
  }

  const db = await openOfflinePackDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction([PACKS_STORE, BLOBS_STORE], "readwrite");
        tx.oncomplete = () => {
          safeCloseDb(db);
          resolve();
        };
        tx.onerror = () => {
          safeCloseDb(db);
          resolve();
        };
        const packsStore = tx.objectStore(PACKS_STORE);
        const getReq = packsStore.get(partitionBookKey);
        getReq.onsuccess = () => {
          if (getReq.result) existed = true;
          packsStore.delete(partitionBookKey);
        };
        const blobsStore = tx.objectStore(BLOBS_STORE);
        const allBlobsReq = blobsStore.getAllKeys();
        allBlobsReq.onsuccess = () => {
          const keys = (allBlobsReq.result as IDBValidKey[] | undefined) ?? [];
          for (const k of keys) {
            if (typeof k === "string" && k.startsWith(`${partitionBookKey}|`)) {
              blobsStore.delete(k);
            }
          }
        };
      } catch {
        safeCloseDb(db);
        resolve();
      }
    });
  }

  notifyListeners();
  return existed;
}

export async function saveOfflineSessionDescriptor(
  input: Omit<OfflineSessionDescriptor, "sessionKey" | "updatedAt">,
): Promise<OfflineSessionDescriptor> {
  const parentId = requireValidScopeSegment(
    input.parentAccountId,
    "parentAccountId",
  );
  const childId = requireValidScopeSegment(
    input.childProfileId,
    "childProfileId",
  );
  const sid = requireValidScopeSegment(input.sessionId, "sessionId");
  const partitionKey = buildOfflinePartitionKey(parentId, childId);
  const sessionKey = `${partitionKey}|s:${encodeURIComponent(sid)}`;
  const record: OfflineSessionDescriptor = {
    ...input,
    parentAccountId: parentId,
    childProfileId: childId,
    sessionId: sid,
    sessionKey,
    updatedAt: Date.now(),
  };
  memorySessions.set(sessionKey, record);

  const db = await openOfflinePackDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(SESSIONS_STORE, "readwrite");
        tx.oncomplete = () => {
          safeCloseDb(db);
          resolve();
        };
        tx.onerror = () => {
          safeCloseDb(db);
          resolve();
        };
        tx.objectStore(SESSIONS_STORE).put(record);
      } catch {
        safeCloseDb(db);
        resolve();
      }
    });
  }
  return record;
}

export async function getOfflineSessionDescriptor(
  parentAccountId: string,
  childProfileId: string,
  sessionId: string,
): Promise<OfflineSessionDescriptor | null> {
  let parentId: string;
  let childId: string;
  let sid: string;
  try {
    parentId = requireValidScopeSegment(parentAccountId, "parentAccountId");
    childId = requireValidScopeSegment(childProfileId, "childProfileId");
    sid = requireValidScopeSegment(sessionId, "sessionId");
  } catch {
    return null;
  }
  const partitionKey = buildOfflinePartitionKey(parentId, childId);
  const sessionKey = `${partitionKey}|s:${encodeURIComponent(sid)}`;
  const mem = memorySessions.get(sessionKey);
  if (mem) return mem;

  const db = await openOfflinePackDb();
  if (!db) return null;
  return new Promise<OfflineSessionDescriptor | null>((resolve) => {
    try {
      const tx = db.transaction(SESSIONS_STORE, "readonly");
      const req = tx.objectStore(SESSIONS_STORE).get(sessionKey);
      req.onsuccess = () => {
        const rec = req.result as OfflineSessionDescriptor | undefined;
        safeCloseDb(db);
        if (
          rec &&
          rec.parentAccountId === parentId &&
          rec.childProfileId === childId
        ) {
          memorySessions.set(sessionKey, rec);
          resolve(rec);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        safeCloseDb(db);
        resolve(null);
      };
    } catch {
      safeCloseDb(db);
      resolve(null);
    }
  });
}

export const offlineReadingPackManifestSchema = z
  .object({
    manifest_version: z.number(),
    parent_account_id: z.string(),
    child_profile_id: z.string(),
    book_id: z.string(),
    title: z.string(),
    author: z.string().nullable(),
    grade: z.number(),
    min_grade: z.number(),
    max_grade: z.number(),
    visibility_scope: z.enum(["CATALOG", "PARENT_PRIVATE"]),
    cover_url: z.string().nullable().optional(),
    voice_id: z.string(),
    estimated_bytes: z.number(),
    tts_budget_bytes: z.number(),
    generated_at: z.string(),
    pages: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough() as unknown as ZodType<OfflineReadingPackManifestDTO>;

async function defaultFetchManifest(
  childId: string,
  bookId: string,
  signal?: AbortSignal,
): Promise<OfflineReadingPackManifestDTO> {
  return requestApi<OfflineReadingPackManifestDTO>(
    `/offline/children/${encodeURIComponent(childId)}/books/${encodeURIComponent(bookId)}/pack-manifest?include_inline_tts=true`,
    offlineReadingPackManifestSchema,
    signal,
    { bypassCache: true },
  );
}

async function defaultFetchBinary(
  url: string,
  requiresAuth: boolean,
  signal?: AbortSignal,
): Promise<Blob | null> {
  try {
    const resolvedUrl = url.startsWith("/")
      ? `${getApiBaseUrl().replace(/\/+$/, "")}${url}`
      : url;
    const headers: Record<string, string> = {};
    if (
      requiresAuth ||
      url.includes("/offline/") ||
      url.includes("/books/my-books/")
    ) {
      const token = await getBrowserAccessToken({
        onUnauthorized: () => new Error("AUTH_REQUIRED"),
      });
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(resolvedUrl, {
      method: "GET",
      headers,
      cache: "no-store",
      signal,
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

export async function downloadAndSaveOfflineBookPack(
  options: DownloadOfflineBookPackOptions,
): Promise<StoredOfflineBookPackSummary> {
  const parentId = requireValidScopeSegment(
    options.parentAccountId,
    "parentAccountId",
  );
  const childId = requireValidScopeSegment(
    options.childProfileId,
    "childProfileId",
  );
  const bookId = requireValidScopeSegment(options.bookId, "bookId");
  const fetchManifestFn = options.fetchManifest ?? defaultFetchManifest;
  const fetchBinaryFn = options.fetchBinary ?? defaultFetchBinary;

  const manifest = await fetchManifestFn(childId, bookId, options.signal);
  const isPrivate = manifest.visibility_scope === "PARENT_PRIVATE";

  const pageImages: Record<string, Blob> = {};
  const pageTtsClips: Record<string, Blob> = {};

  await Promise.all(
    manifest.pages.map(async (page) => {
      if (page.image_url) {
        const imgBlob = await fetchBinaryFn(
          page.image_url,
          isPrivate,
          options.signal,
        );
        if (imgBlob && imgBlob.size > 0) {
          pageImages[page.page_id] = imgBlob;
        }
      }
      if (
        page.tts_audio?.cached &&
        !page.tts_audio.inline_audio_base64 &&
        page.tts_audio.audio_url
      ) {
        const ttsBlob = await fetchBinaryFn(
          page.tts_audio.audio_url,
          isPrivate || page.tts_audio.audio_url.includes("/offline/"),
          options.signal,
        );
        if (ttsBlob && ttsBlob.size > 0) {
          pageTtsClips[page.page_id] = ttsBlob;
        }
      }
    }),
  );

  return saveOfflineBookPack({
    parentAccountId: parentId,
    childProfileId: childId,
    manifest,
    pageImages,
    pageTtsClips,
  });
}

export async function downloadWeeklyReadingPlanPacks(
  options: DownloadWeeklyPlanPacksOptions,
): Promise<StoredOfflineBookPackSummary[]> {
  const uniqueBookIds = Array.from(
    new Set(options.bookIds.map((id) => id.trim()).filter(Boolean)),
  ).slice(0, MAX_WEEKLY_PLAN_OFFLINE_BOOKS);

  const summaries: StoredOfflineBookPackSummary[] = [];
  for (let idx = 0; idx < uniqueBookIds.length; idx += 1) {
    const bookId = uniqueBookIds[idx];
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const summary = await downloadAndSaveOfflineBookPack({
      parentAccountId: options.parentAccountId,
      childProfileId: options.childProfileId,
      bookId,
      signal: options.signal,
      fetchManifest: options.fetchManifest,
      fetchBinary: options.fetchBinary,
    });
    summaries.push(summary);
    options.onProgress?.(idx + 1, uniqueBookIds.length, bookId);
  }
  return summaries;
}

export async function deleteOfflinePacksForAccount(
  parentAccountId?: string | null,
  childProfileId?: string | null,
): Promise<number> {
  const targetParent = parentAccountId?.trim() || null;
  const targetChild = childProfileId?.trim() || null;
  const matchesKey = (key: string): boolean => {
    if (!targetParent) return true;
    const parentPrefix = `p:${encodeURIComponent(targetParent)}|`;
    if (!key.startsWith(parentPrefix)) return false;
    if (!targetChild) return true;
    return key.startsWith(
      `${parentPrefix}c:${encodeURIComponent(targetChild)}|`,
    );
  };

  let removedPacks = 0;
  for (const key of Array.from(memoryPacks.keys())) {
    if (matchesKey(key)) {
      memoryPacks.delete(key);
      removedPacks += 1;
    }
  }
  for (const key of Array.from(memoryBlobs.keys())) {
    if (matchesKey(key)) {
      memoryBlobs.delete(key);
    }
  }
  for (const key of Array.from(memorySessions.keys())) {
    if (matchesKey(key)) {
      memorySessions.delete(key);
    }
  }

  if (typeof caches !== "undefined") {
    try {
      const cacheNames = await caches.keys();
      const expectedCachePrefix = targetParent
        ? targetChild
          ? `${OFFLINE_CACHE_STORAGE_PREFIX}${encodeURIComponent(targetParent)}:${encodeURIComponent(targetChild)}`
          : `${OFFLINE_CACHE_STORAGE_PREFIX}${encodeURIComponent(targetParent)}:`
        : OFFLINE_CACHE_STORAGE_PREFIX;
      await Promise.all(
        cacheNames
          .filter(
            (name) =>
              name === expectedCachePrefix ||
              name.startsWith(expectedCachePrefix),
          )
          .map((name) => caches.delete(name)),
      );
    } catch {
      // Ignore Cache Storage purge errors
    }
  }

  const db = await openOfflinePackDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(
          [PACKS_STORE, BLOBS_STORE, SESSIONS_STORE],
          "readwrite",
        );
        tx.oncomplete = () => {
          safeCloseDb(db);
          resolve();
        };
        tx.onerror = () => {
          safeCloseDb(db);
          resolve();
        };
        if (!targetParent) {
          tx.objectStore(PACKS_STORE).clear();
          tx.objectStore(BLOBS_STORE).clear();
          tx.objectStore(SESSIONS_STORE).clear();
        } else {
          for (const storeName of [
            PACKS_STORE,
            BLOBS_STORE,
            SESSIONS_STORE,
          ] as const) {
            const store = tx.objectStore(storeName);
            const keysReq = store.getAllKeys();
            keysReq.onsuccess = () => {
              const keys = (keysReq.result as IDBValidKey[] | undefined) ?? [];
              for (const k of keys) {
                if (typeof k === "string" && matchesKey(k)) {
                  if (storeName === PACKS_STORE) removedPacks += 1;
                  store.delete(k);
                }
              }
            };
          }
        }
      } catch {
        safeCloseDb(db);
        resolve();
      }
    });
  }

  notifyListeners();
  return removedPacks;
}

export function resetOfflinePackStoreForTests(): void {
  memoryPacks.clear();
  memoryBlobs.clear();
  memorySessions.clear();
  notifyListeners();
}
