import { registerCacheResetListener } from "@/lib/api/read-cache";
import type {
  GlobalTaskActorRole,
  GlobalTaskItem,
  GlobalTaskStatus,
} from "@/types/global-tasks";

export const TASK_ALERT_ACK_STORAGE_PREFIX = "viread:tasks:ack:v1:";
export const LEGACY_PARENT_TASK_LAST_SEEN_PREFIX = "viread_tasks_last_seen:";

const MAX_ACK_ENTRIES_PER_SCOPE = 120;

export interface TaskAlertAckState {
  readonly seen: Readonly<Record<string, string>>;
  readonly legacySucceededSeenBeforeMs: number;
}

export interface UnreadTaskAlertCounts {
  readonly unreadWaitingReviewCount: number;
  readonly unreadFailedCount: number;
  readonly unreadCompletedCount: number;
  readonly unreadAlertCount: number;
}

export const EMPTY_TASK_ALERT_ACK_STATE: TaskAlertAckState = Object.freeze({
  seen: Object.freeze({}),
  legacySucceededSeenBeforeMs: 0,
});

interface ParsedCacheEntry {
  readonly raw: string | null;
  readonly legacyRaw: string | null;
  readonly state: TaskAlertAckState;
}

const parsedAckCache = new Map<string, ParsedCacheEntry>();
/** Fallback used ONLY when browser localStorage throws (e.g. strict privacy mode / quota). */
const inMemoryFallbackAckByScope = new Map<string, TaskAlertAckState>();
const ackChangeListenersByScope = new Map<string, Set<() => void>>();

export function buildTaskAlertAckStorageKey(scopeKey: string): string {
  return `${TASK_ALERT_ACK_STORAGE_PREFIX}${scopeKey}`;
}

export function buildLegacyParentLastSeenKey(actorId: string): string {
  return `${LEGACY_PARENT_TASK_LAST_SEEN_PREFIX}${actorId.trim()}`;
}

/**
 * Composite task key (`source:id`) prevents cross-source ID collisions and
 * guarantees a non-numeric JS object key so insertion/LRU order is preserved
 * even for numeric task IDs.
 */
export function buildTaskAlertKey(
  task: Pick<GlobalTaskItem, "id" | "source">,
): string {
  return `${task.source}:${task.id}`;
}

export function isAlertableTaskStatus(status: GlobalTaskStatus): boolean {
  return (
    status === "FAILED" ||
    status === "PARTIAL_SUCCESS" ||
    status === "WAITING_FOR_REVIEW" ||
    status === "SUCCEEDED"
  );
}

/**
 * Produces a stable alert state signature for a task so that:
 * - Already-read/handled alerts remain dismissed across navigations and reloads.
 * - Any status change, retry attempt, or newer server update re-triggers the alert
 *   even under client/server clock skew.
 */
export function buildTaskAlertSignature(task: GlobalTaskItem): string {
  const timestamp =
    task.updated_at || task.completed_at || task.created_at || "";
  return `${task.status}|${timestamp}|${task.attempt_count}`;
}

function safeReadLocalStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWriteLocalStorage(key: string, value: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function parseLegacyTimestamp(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseStoredSeenMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("seen" in parsed)
    ) {
      return {};
    }
    const rawSeen = (parsed as { seen?: unknown }).seen;
    if (!rawSeen || typeof rawSeen !== "object" || Array.isArray(rawSeen)) {
      return {};
    }
    const entries = Object.entries(rawSeen as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].length > 0,
    );
    const trimmed =
      entries.length > MAX_ACK_ENTRIES_PER_SCOPE
        ? entries.slice(-MAX_ACK_ENTRIES_PER_SCOPE)
        : entries;
    return Object.fromEntries(trimmed);
  } catch {
    return {};
  }
}

function notifyAckListeners(scopeKey?: string): void {
  if (scopeKey !== undefined) {
    const scopedListeners = ackChangeListenersByScope.get(scopeKey);
    if (!scopedListeners) return;
    for (const listener of scopedListeners) {
      listener();
    }
    return;
  }
  for (const scopedListeners of ackChangeListenersByScope.values()) {
    for (const listener of scopedListeners) {
      listener();
    }
  }
}

export function getTaskAlertAckState(
  scopeKey: string | null | undefined,
  actorId?: string | null,
  actorRole?: GlobalTaskActorRole | null,
): TaskAlertAckState {
  if (!scopeKey || typeof window === "undefined") {
    return EMPTY_TASK_ALERT_ACK_STATE;
  }

  const fallback = inMemoryFallbackAckByScope.get(scopeKey);
  if (fallback) {
    return fallback;
  }

  const storageKey = buildTaskAlertAckStorageKey(scopeKey);
  const raw = safeReadLocalStorage(storageKey);
  const legacyRaw =
    actorRole === "parent" && actorId?.trim()
      ? safeReadLocalStorage(buildLegacyParentLastSeenKey(actorId))
      : null;

  if (raw === null && legacyRaw === null) {
    parsedAckCache.delete(scopeKey);
    return EMPTY_TASK_ALERT_ACK_STATE;
  }

  const cached = parsedAckCache.get(scopeKey);
  if (cached && cached.raw === raw && cached.legacyRaw === legacyRaw) {
    return cached.state;
  }

  const state: TaskAlertAckState = Object.freeze({
    seen: Object.freeze(parseStoredSeenMap(raw)),
    legacySucceededSeenBeforeMs: parseLegacyTimestamp(legacyRaw),
  });
  parsedAckCache.set(scopeKey, { raw, legacyRaw, state });
  return state;
}

export function subscribeTaskAlertAck(
  scopeKey: string | null | undefined,
  actorId: string | null | undefined,
  actorRole: GlobalTaskActorRole | null | undefined,
  onStoreChange: () => void,
): () => void {
  if (!scopeKey || typeof window === "undefined") {
    return () => {};
  }

  const storageKey = buildTaskAlertAckStorageKey(scopeKey);
  const legacyKey =
    actorRole === "parent" && actorId?.trim()
      ? buildLegacyParentLastSeenKey(actorId)
      : null;

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === storageKey ||
      (legacyKey !== null && event.key === legacyKey)
    ) {
      parsedAckCache.delete(scopeKey);
      inMemoryFallbackAckByScope.delete(scopeKey);
      onStoreChange();
    }
  };

  let scopedListeners = ackChangeListenersByScope.get(scopeKey);
  if (!scopedListeners) {
    scopedListeners = new Set();
    ackChangeListenersByScope.set(scopeKey, scopedListeners);
  }
  scopedListeners.add(onStoreChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    const listeners = ackChangeListenersByScope.get(scopeKey);
    if (listeners) {
      listeners.delete(onStoreChange);
      if (listeners.size === 0) {
        ackChangeListenersByScope.delete(scopeKey);
      }
    }
    window.removeEventListener("storage", handleStorage);
  };
}

/**
 * Records that the user has read or interacted with the given task alerts.
 * Strictly a no-op (zero localStorage writes, zero re-renders) if there are no
 * alertable tasks or if all given alert signatures are already acknowledged.
 */
export function acknowledgeTaskAlerts(
  scopeKey: string | null | undefined,
  tasks: readonly GlobalTaskItem[],
  actorId?: string | null,
  actorRole?: GlobalTaskActorRole | null,
): boolean {
  if (!scopeKey || tasks.length === 0 || typeof window === "undefined") {
    return false;
  }

  const alertableTasks = tasks.filter((task) =>
    isAlertableTaskStatus(task.status),
  );
  if (alertableTasks.length === 0) {
    return false;
  }

  const currentState = getTaskAlertAckState(scopeKey, actorId, actorRole);
  let hasChanges = false;
  for (const task of alertableTasks) {
    const compositeKey = buildTaskAlertKey(task);
    const signature = buildTaskAlertSignature(task);
    if (
      currentState.seen[compositeKey] !== signature &&
      currentState.seen[task.id] !== signature
    ) {
      hasChanges = true;
      break;
    }
  }

  if (!hasChanges) {
    return false;
  }

  const nextSeen: Record<string, string> = { ...currentState.seen };
  const protectedKeys = new Set<string>();

  for (const task of alertableTasks) {
    const compositeKey = buildTaskAlertKey(task);
    const signature = buildTaskAlertSignature(task);
    protectedKeys.add(compositeKey);
    // Clean up any legacy bare-id key and refresh recency for ALL currently
    // present alert tasks so active feed items are never evicted by LRU trim.
    delete nextSeen[task.id];
    delete nextSeen[compositeKey];
    nextSeen[compositeKey] = signature;
  }

  const keys = Object.keys(nextSeen);
  if (keys.length > MAX_ACK_ENTRIES_PER_SCOPE) {
    let remainingToEvict = keys.length - MAX_ACK_ENTRIES_PER_SCOPE;
    for (const key of keys) {
      if (remainingToEvict <= 0) break;
      if (!protectedKeys.has(key)) {
        delete nextSeen[key];
        remainingToEvict -= 1;
      }
    }
    if (remainingToEvict > 0) {
      for (const key of Object.keys(nextSeen)) {
        if (remainingToEvict <= 0) break;
        delete nextSeen[key];
        remainingToEvict -= 1;
      }
    }
  }

  const serialized = JSON.stringify({ v: 1, seen: nextSeen });
  const storageKey = buildTaskAlertAckStorageKey(scopeKey);
  const legacyRaw =
    actorRole === "parent" && actorId?.trim()
      ? safeReadLocalStorage(buildLegacyParentLastSeenKey(actorId))
      : null;
  const nextState: TaskAlertAckState = Object.freeze({
    seen: Object.freeze(nextSeen),
    legacySucceededSeenBeforeMs: parseLegacyTimestamp(legacyRaw),
  });

  if (safeWriteLocalStorage(storageKey, serialized)) {
    inMemoryFallbackAckByScope.delete(scopeKey);
    parsedAckCache.set(scopeKey, {
      raw: serialized,
      legacyRaw,
      state: nextState,
    });
  } else {
    inMemoryFallbackAckByScope.set(scopeKey, nextState);
  }

  notifyAckListeners(scopeKey);
  return true;
}

export function isTaskAlertAcknowledged(
  task: GlobalTaskItem,
  ackState: TaskAlertAckState,
): boolean {
  if (!isAlertableTaskStatus(task.status)) {
    return true;
  }

  const signature = buildTaskAlertSignature(task);
  const compositeKey = buildTaskAlertKey(task);
  if (
    ackState.seen[compositeKey] === signature ||
    ackState.seen[task.id] === signature
  ) {
    return true;
  }

  // Backward compatibility for existing parent sessions that only persisted
  // `viread_tasks_last_seen:<userId>` before per-task alert signatures existed.
  if (task.status === "SUCCEEDED" && ackState.legacySucceededSeenBeforeMs > 0) {
    const ts = Date.parse(
      task.updated_at || task.completed_at || task.created_at,
    );
    if (Number.isFinite(ts) && ts <= ackState.legacySucceededSeenBeforeMs) {
      return true;
    }
  }

  return false;
}

export function computeUnreadTaskAlertCounts(
  tasks: readonly GlobalTaskItem[],
  ackState: TaskAlertAckState,
): UnreadTaskAlertCounts {
  let unreadWaitingReviewCount = 0;
  let unreadFailedCount = 0;
  let unreadCompletedCount = 0;

  for (const task of tasks) {
    if (isTaskAlertAcknowledged(task, ackState)) {
      continue;
    }
    if (task.status === "WAITING_FOR_REVIEW") {
      unreadWaitingReviewCount += 1;
    } else if (task.status === "FAILED" || task.status === "PARTIAL_SUCCESS") {
      unreadFailedCount += 1;
    } else if (task.status === "SUCCEEDED") {
      unreadCompletedCount += 1;
    }
  }

  return {
    unreadWaitingReviewCount,
    unreadFailedCount,
    unreadCompletedCount,
    unreadAlertCount:
      unreadWaitingReviewCount + unreadFailedCount + unreadCompletedCount,
  };
}

export function resetTaskAlertAckMemoryCache(): void {
  parsedAckCache.clear();
  inMemoryFallbackAckByScope.clear();
  notifyAckListeners();
}

registerCacheResetListener(resetTaskAlertAckMemoryCache);
