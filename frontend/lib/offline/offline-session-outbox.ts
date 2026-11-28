/**
 * Feature #8: Partitioned Idempotent Offline Session Outbox (`offline-session-outbox.ts`).
 *
 * - Strictly partitioned by `(parentAccountId, childProfileId)`.
 * - Generates UUIDv4 `client_event_id`s and deterministic `Idempotency-Key` batch headers.
 * - Single-flight per partition drain on reconnect (`online` event) so flaky networks
 *   never double-score or drop child reading effort.
 */

import { z, type ZodType } from "zod";

import { getBrowserAccessToken } from "@/lib/api/browser-auth";
import { buildOfflinePartitionKey } from "@/lib/offline/reading-pack-store";
import { getApiBaseUrl } from "@/lib/supabase/config";

export const OFFLINE_OUTBOX_IDB_NAME = "viread-offline-session-outbox-v1";
const OFFLINE_OUTBOX_IDB_VERSION = 1;
const OUTBOX_STORE = "events";
const IDB_TIMEOUT_MS = 4_000;

export type OfflineOutboxEventKind =
  "SESSION_START" | "PAGE_READ" | "WORD_ATTEMPT" | "SESSION_FINISH";

export type OfflineOutboxSyncState =
  "idle" | "pending" | "syncing" | "synced" | "error";

export interface OfflineOutboxEventPayload {
  readonly client_event_id: string;
  readonly client_session_id: string;
  readonly book_id: string;
  readonly page_id: string;
  readonly page_revision_id: string;
  readonly event_kind: OfflineOutboxEventKind;
  readonly occurred_at: string;
  readonly word_id?: string | null;
  readonly word_text?: string | null;
  readonly transcript?: string | null;
  readonly reading_event_type?:
    | "OMISSION"
    | "REPETITION"
    | "LONG_PAUSE"
    | "MISPRONUNCIATION"
    | "SUBSTITUTION"
    | "SELF_CORRECTION"
    | "READ_EXAMPLE"
    | "WORD_RETRY"
    | null;
  readonly reading_event_status?:
    | "DETECTED"
    | "IGNORED_BY_GATE"
    | "FEEDBACK_GIVEN"
    | "CANDIDATE"
    | "CONFIRMED"
    | "FAILED"
    | "UNCERTAIN"
    | "DISMISSED"
    | null;
  readonly is_correct?: boolean | null;
  readonly score?: number | null;
  readonly start_ms?: number;
  readonly end_ms?: number | null;
  readonly duration_ms?: number | null;
  readonly confidence?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StoredOutboxRecord {
  readonly storageKey: string;
  readonly partitionKey: string;
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly createdAt: number;
  readonly attempts: number;
  readonly payload: OfflineOutboxEventPayload;
}

export interface EnqueueOfflineEventInput {
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly clientEventId?: string;
  readonly clientSessionId: string;
  readonly bookId: string;
  readonly pageId: string;
  readonly pageRevisionId: string;
  readonly eventKind?: OfflineOutboxEventKind;
  readonly occurredAt?: string;
  readonly wordId?: string | null;
  readonly wordText?: string | null;
  readonly transcript?: string | null;
  readonly readingEventType?: OfflineOutboxEventPayload["reading_event_type"];
  readonly readingEventStatus?: OfflineOutboxEventPayload["reading_event_status"];
  readonly isCorrect?: boolean | null;
  readonly score?: number | null;
  readonly startMs?: number;
  readonly endMs?: number | null;
  readonly durationMs?: number | null;
  readonly confidence?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OfflineSyncOutboxApiResultItem {
  readonly client_event_id: string;
  readonly client_session_id: string;
  readonly server_session_id: string;
  readonly applied: boolean;
  readonly deduplicated: boolean;
  readonly stale_revision_reconciled: boolean;
}

export interface OfflineSyncOutboxApiResponse {
  readonly child_id: string;
  readonly batch_idempotency_key?: string | null;
  readonly total_received: number;
  readonly applied_count: number;
  readonly deduplicated_count: number;
  readonly reconciled_stale_count: number;
  readonly session_ids: readonly string[];
  readonly results: readonly OfflineSyncOutboxApiResultItem[];
}

export type OfflineOutboxTransport = (
  childProfileId: string,
  events: readonly OfflineOutboxEventPayload[],
  idempotencyKey: string,
) => Promise<OfflineSyncOutboxApiResponse>;

export interface OfflineOutboxStatusSnapshot {
  readonly state: OfflineOutboxSyncState;
  readonly pendingCount: number;
  readonly lastSyncedAt: number | null;
  readonly lastError: string | null;
}

const memoryOutbox = new Map<string, StoredOutboxRecord>();
const partitionSyncMeta = new Map<
  string,
  {
    syncing: boolean;
    lastSyncedAt: number | null;
    lastError: string | null;
  }
>();
const inflightDrains = new Map<
  string,
  Promise<OfflineSyncOutboxApiResponse | null>
>();
const outboxListeners = new Set<() => void>();

function emitOutboxChange(): void {
  for (const listener of outboxListeners) {
    try {
      listener();
    } catch {
      // Ignore subscriber error
    }
  }
}

export function subscribeOfflineSessionOutbox(
  listener: () => void,
): () => void {
  outboxListeners.add(listener);
  return () => {
    outboxListeners.delete(listener);
  };
}

export function generateUuidV4(): string {
  const nativeUuid = globalThis.crypto?.randomUUID?.();
  if (typeof nativeUuid === "string" && nativeUuid.length === 36) {
    return nativeUuid;
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function openOutboxDb(): Promise<IDBDatabase | null> {
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
        OFFLINE_OUTBOX_IDB_NAME,
        OFFLINE_OUTBOX_IDB_VERSION,
      );
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          db.createObjectStore(OUTBOX_STORE, { keyPath: "storageKey" });
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

function safeCloseOutboxDb(db: IDBDatabase | null): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Ignore
  }
}

export async function enqueueOfflineSessionEvent(
  input: EnqueueOfflineEventInput,
): Promise<StoredOutboxRecord> {
  const parentId = input.parentAccountId.trim();
  const childId = input.childProfileId.trim();
  const partitionKey = buildOfflinePartitionKey(parentId, childId);
  const clientEventId = input.clientEventId?.trim() || generateUuidV4();
  const storageKey = `${partitionKey}|ev:${clientEventId}`;

  const existing = memoryOutbox.get(storageKey);
  if (existing) {
    return existing;
  }

  const payload: OfflineOutboxEventPayload = {
    client_event_id: clientEventId,
    client_session_id: input.clientSessionId.trim(),
    book_id: input.bookId.trim(),
    page_id: input.pageId.trim(),
    page_revision_id: input.pageRevisionId.trim(),
    event_kind: input.eventKind ?? "WORD_ATTEMPT",
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    ...(input.wordId ? { word_id: input.wordId } : {}),
    ...(input.wordText ? { word_text: input.wordText } : {}),
    ...(input.transcript ? { transcript: input.transcript } : {}),
    ...(input.readingEventType
      ? { reading_event_type: input.readingEventType }
      : {}),
    ...(input.readingEventStatus
      ? { reading_event_status: input.readingEventStatus }
      : {}),
    ...(input.isCorrect !== undefined ? { is_correct: input.isCorrect } : {}),
    ...(typeof input.score === "number" ? { score: input.score } : {}),
    start_ms: input.startMs ?? 0,
    ...(typeof input.endMs === "number" ? { end_ms: input.endMs } : {}),
    ...(typeof input.durationMs === "number"
      ? { duration_ms: input.durationMs }
      : {}),
    ...(typeof input.confidence === "number"
      ? { confidence: input.confidence }
      : {}),
    metadata: input.metadata ?? {},
  };

  const record: StoredOutboxRecord = {
    storageKey,
    partitionKey,
    parentAccountId: parentId,
    childProfileId: childId,
    createdAt: Date.now(),
    attempts: 0,
    payload,
  };

  memoryOutbox.set(storageKey, record);
  const meta = partitionSyncMeta.get(partitionKey);
  if (meta) {
    partitionSyncMeta.set(partitionKey, { ...meta, lastError: null });
  }

  const db = await openOutboxDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(OUTBOX_STORE, "readwrite");
        tx.oncomplete = () => {
          safeCloseOutboxDb(db);
          resolve();
        };
        tx.onerror = () => {
          safeCloseOutboxDb(db);
          resolve();
        };
        tx.objectStore(OUTBOX_STORE).put(record);
      } catch {
        safeCloseOutboxDb(db);
        resolve();
      }
    });
  }

  emitOutboxChange();
  return record;
}

export async function listPendingOutboxEvents(
  parentAccountId: string,
  childProfileId: string,
): Promise<StoredOutboxRecord[]> {
  let partitionKey: string;
  const parentId = parentAccountId.trim();
  const childId = childProfileId.trim();
  try {
    partitionKey = buildOfflinePartitionKey(parentId, childId);
  } catch {
    return [];
  }

  const merged = new Map<string, StoredOutboxRecord>();
  for (const [k, rec] of memoryOutbox.entries()) {
    if (
      rec.partitionKey === partitionKey &&
      rec.parentAccountId === parentId &&
      rec.childProfileId === childId
    ) {
      merged.set(k, rec);
    }
  }

  const db = await openOutboxDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(OUTBOX_STORE, "readonly");
        const req = tx.objectStore(OUTBOX_STORE).getAll();
        req.onsuccess = () => {
          const rows = (req.result as StoredOutboxRecord[] | undefined) ?? [];
          for (const rec of rows) {
            if (
              rec &&
              rec.partitionKey === partitionKey &&
              rec.parentAccountId === parentId &&
              rec.childProfileId === childId
            ) {
              memoryOutbox.set(rec.storageKey, rec);
              merged.set(rec.storageKey, rec);
            }
          }
          safeCloseOutboxDb(db);
          resolve();
        };
        req.onerror = () => {
          safeCloseOutboxDb(db);
          resolve();
        };
      } catch {
        safeCloseOutboxDb(db);
        resolve();
      }
    });
  }

  return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
}

export function getOfflineOutboxStatusSnapshot(
  parentAccountId: string | null | undefined,
  childProfileId: string | null | undefined,
): OfflineOutboxStatusSnapshot {
  if (!parentAccountId?.trim() || !childProfileId?.trim()) {
    return {
      state: "idle",
      pendingCount: 0,
      lastSyncedAt: null,
      lastError: null,
    };
  }
  let partitionKey: string;
  try {
    partitionKey = buildOfflinePartitionKey(parentAccountId, childProfileId);
  } catch {
    return {
      state: "idle",
      pendingCount: 0,
      lastSyncedAt: null,
      lastError: null,
    };
  }

  let pendingCount = 0;
  for (const rec of memoryOutbox.values()) {
    if (rec.partitionKey === partitionKey) {
      pendingCount += 1;
    }
  }
  const meta = partitionSyncMeta.get(partitionKey);
  if (meta?.syncing) {
    return {
      state: "syncing",
      pendingCount,
      lastSyncedAt: meta.lastSyncedAt,
      lastError: meta.lastError,
    };
  }
  if (pendingCount > 0) {
    return {
      state: meta?.lastError ? "error" : "pending",
      pendingCount,
      lastSyncedAt: meta?.lastSyncedAt ?? null,
      lastError: meta?.lastError ?? null,
    };
  }
  if (meta?.lastSyncedAt) {
    return {
      state: "synced",
      pendingCount: 0,
      lastSyncedAt: meta.lastSyncedAt,
      lastError: null,
    };
  }
  return {
    state: "idle",
    pendingCount: 0,
    lastSyncedAt: null,
    lastError: null,
  };
}

const offlineSyncOutboxApiResponseSchema = z
  .object({
    child_id: z.string(),
    batch_idempotency_key: z.string().nullable().optional(),
    total_received: z.number(),
    applied_count: z.number(),
    deduplicated_count: z.number(),
    reconciled_stale_count: z.number(),
    session_ids: z.array(z.string()),
    results: z.array(
      z.object({
        client_event_id: z.string(),
        client_session_id: z.string(),
        server_session_id: z.string(),
        applied: z.boolean(),
        deduplicated: z.boolean(),
        stale_revision_reconciled: z.boolean(),
      }),
    ),
  })
  .passthrough() as unknown as ZodType<OfflineSyncOutboxApiResponse>;

const defaultOutboxTransport: OfflineOutboxTransport = async (
  childProfileId,
  events,
  idempotencyKey,
) => {
  const token = await getBrowserAccessToken({
    onUnauthorized: () => new Error("AUTH_REQUIRED"),
  });
  const baseUrl = getApiBaseUrl().replace(/\/+$/, "");
  const response = await fetch(
    `${baseUrl}/offline/children/${encodeURIComponent(childProfileId)}/sync-outbox`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ events }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    },
  );
  if (!response.ok) {
    throw new Error(`OUTBOX_SYNC_HTTP_${response.status}`);
  }
  const raw: unknown = await response.json();
  return offlineSyncOutboxApiResponseSchema.parse(raw);
};

async function removeAckedOutboxRecords(storageKeys: string[]): Promise<void> {
  if (storageKeys.length === 0) return;
  for (const k of storageKeys) {
    memoryOutbox.delete(k);
  }
  const db = await openOutboxDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(OUTBOX_STORE, "readwrite");
        tx.oncomplete = () => {
          safeCloseOutboxDb(db);
          resolve();
        };
        tx.onerror = () => {
          safeCloseOutboxDb(db);
          resolve();
        };
        const store = tx.objectStore(OUTBOX_STORE);
        for (const k of storageKeys) {
          store.delete(k);
        }
      } catch {
        safeCloseOutboxDb(db);
        resolve();
      }
    });
  }
}

export async function drainOfflineSessionOutbox(options: {
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly transport?: OfflineOutboxTransport;
  readonly batchSize?: number;
}): Promise<OfflineSyncOutboxApiResponse | null> {
  const parentId = options.parentAccountId.trim();
  const childId = options.childProfileId.trim();
  const partitionKey = buildOfflinePartitionKey(parentId, childId);

  const existingInflight = inflightDrains.get(partitionKey);
  if (existingInflight) {
    return existingInflight;
  }

  const runDrain = async (): Promise<OfflineSyncOutboxApiResponse | null> => {
    if (
      typeof navigator !== "undefined" &&
      navigator.onLine === false &&
      !options.transport
    ) {
      return null;
    }

    const pending = await listPendingOutboxEvents(parentId, childId);
    if (pending.length === 0) {
      return null;
    }

    const prevMeta = partitionSyncMeta.get(partitionKey);
    partitionSyncMeta.set(partitionKey, {
      syncing: true,
      lastSyncedAt: prevMeta?.lastSyncedAt ?? null,
      lastError: null,
    });
    emitOutboxChange();

    const transport = options.transport ?? defaultOutboxTransport;
    const chunkSize = Math.max(1, Math.min(200, options.batchSize ?? 50));
    let lastResponse: OfflineSyncOutboxApiResponse | null = null;

    try {
      for (let offset = 0; offset < pending.length; offset += chunkSize) {
        const slice = pending.slice(offset, offset + chunkSize);
        const firstId = slice[0]?.payload.client_event_id ?? "0";
        const lastId = slice[slice.length - 1]?.payload.client_event_id ?? "0";
        const idempotencyKey =
          `outbox:${childId.slice(0, 18)}:${firstId}:${lastId}:${slice.length}`.slice(
            0,
            160,
          );

        const response = await transport(
          childId,
          slice.map((r) => r.payload),
          idempotencyKey,
        );
        lastResponse = response;

        const ackedIds = new Set(
          response.results
            .filter((item) => item.applied || item.deduplicated)
            .map((item) => item.client_event_id),
        );
        const keysToDelete = slice
          .filter((rec) =>
            ackedIds.size > 0
              ? ackedIds.has(rec.payload.client_event_id)
              : true,
          )
          .map((rec) => rec.storageKey);
        await removeAckedOutboxRecords(keysToDelete);
      }

      partitionSyncMeta.set(partitionKey, {
        syncing: false,
        lastSyncedAt: Date.now(),
        lastError: null,
      });
      emitOutboxChange();
      return lastResponse;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "OUTBOX_SYNC_FAILED";
      partitionSyncMeta.set(partitionKey, {
        syncing: false,
        lastSyncedAt: prevMeta?.lastSyncedAt ?? null,
        lastError: msg,
      });
      emitOutboxChange();
      throw error;
    }
  };

  const drainPromise = runDrain().finally(() => {
    if (inflightDrains.get(partitionKey) === drainPromise) {
      inflightDrains.delete(partitionKey);
    }
  });
  inflightDrains.set(partitionKey, drainPromise);
  return drainPromise;
}

export function installOfflineOutboxReconnectAutoDrain(
  getScope: () => {
    readonly parentAccountId: string | null | undefined;
    readonly childProfileId: string | null | undefined;
  },
  transport?: OfflineOutboxTransport,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const triggerDrain = () => {
    const scope = getScope();
    if (!scope.parentAccountId?.trim() || !scope.childProfileId?.trim()) {
      return;
    }
    void drainOfflineSessionOutbox({
      parentAccountId: scope.parentAccountId,
      childProfileId: scope.childProfileId,
      transport,
    }).catch(() => undefined);
  };

  window.addEventListener("online", triggerDrain);
  if (typeof navigator === "undefined" || navigator.onLine !== false) {
    // Hydrate & drain any leftover queued attempts from an earlier offline run.
    triggerDrain();
  }

  return () => {
    window.removeEventListener("online", triggerDrain);
  };
}

export async function purgeOfflineOutboxForAccount(
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
      `${parentPrefix}c:${encodeURIComponent(targetChild)}`,
    );
  };

  let removed = 0;
  for (const key of Array.from(memoryOutbox.keys())) {
    if (matchesKey(key)) {
      memoryOutbox.delete(key);
      removed += 1;
    }
  }
  for (const partKey of Array.from(partitionSyncMeta.keys())) {
    if (matchesKey(`${partKey}|`)) {
      partitionSyncMeta.delete(partKey);
    }
  }

  const db = await openOutboxDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(OUTBOX_STORE, "readwrite");
        tx.oncomplete = () => {
          safeCloseOutboxDb(db);
          resolve();
        };
        tx.onerror = () => {
          safeCloseOutboxDb(db);
          resolve();
        };
        const store = tx.objectStore(OUTBOX_STORE);
        if (!targetParent) {
          store.clear();
        } else {
          const keysReq = store.getAllKeys();
          keysReq.onsuccess = () => {
            const keys = (keysReq.result as IDBValidKey[] | undefined) ?? [];
            for (const k of keys) {
              if (typeof k === "string" && matchesKey(k)) {
                removed += 1;
                store.delete(k);
              }
            }
          };
        }
      } catch {
        safeCloseOutboxDb(db);
        resolve();
      }
    });
  }

  emitOutboxChange();
  return removed;
}

export function resetOfflineOutboxForTests(): void {
  memoryOutbox.clear();
  partitionSyncMeta.clear();
  inflightDrains.clear();
  emitOutboxChange();
}
