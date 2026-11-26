import type { DashboardSummaryDTO } from "@/types/profile";

export const DEFAULT_USER_CACHE_TTL_MS = 60_000;
export const PERSISTENT_USER_CACHE_MAX_STALE_MS = 15 * 60_000;
export const USER_CACHE_STORAGE_PREFIX = "viread_ucache:";

export type UserCachePersistence = "session" | "local";

export interface UserCacheWriteOptions {
  readonly persist?: UserCachePersistence;
}

interface UserCacheRecord<T> {
  readonly userId: string;
  readonly key: string;
  readonly updatedAt: number;
  readonly data: T;
}

export interface UserCacheReadResult<T> {
  readonly data: T;
  readonly updatedAt: number;
  readonly isStale: boolean;
}

const memoryCache = new Map<string, UserCacheRecord<unknown>>();

const FORBIDDEN_KEY_PATTERN =
  /(?:^|[:/._-])(token|access_token|refresh_token|authorization|secret|password|cookie|private[-_]?media)(?:$|[:/._-])/i;

function normalizeSegment(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildStorageKey(userId: string, key: string): string {
  return `${USER_CACHE_STORAGE_PREFIX}${userId}:${key}`;
}

function getSessionStorageSafe(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function getLocalStorageSafe(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function removeFromAllStorages(storageKey: string): void {
  for (const storage of [getSessionStorageSafe(), getLocalStorageSafe()]) {
    if (!storage) continue;
    try {
      storage.removeItem(storageKey);
    } catch {
      // Ignore storage cleanup errors.
    }
  }
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Fall through to JSON clone below.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function containsForbiddenPayload(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    return (
      value.startsWith("blob:") ||
      value.includes("/books/my-books/") ||
      value.includes("/books/admin/quality/user-books/") ||
      value.includes("viread-private-books") ||
      value.includes("/studio/assets/") ||
      /[?&]token=/i.test(value)
    );
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenPayload(item, depth + 1));
  }
  if (typeof value === "object") {
    for (const [prop, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (FORBIDDEN_KEY_PATTERN.test(prop)) {
        return true;
      }
      if (containsForbiddenPayload(nested, depth + 1)) {
        return true;
      }
    }
  }
  return false;
}

function stripForbiddenMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (containsForbiddenPayload(url)) return null;
  return url;
}

/**
 * Strips signed or private media URLs before caching child profile entries.
 */
export function sanitizeChildProfileForCache<
  T extends { readonly avatar_url?: string | null },
>(child: T): T {
  if (!("avatar_url" in child)) {
    return child;
  }
  return {
    ...child,
    avatar_url: stripForbiddenMediaUrl(child.avatar_url),
  };
}

/**
 * Strips parent PII (`contact_phone`) and signed/private avatar URLs before
 * writing dashboard summary data to browser storage.
 */
export function sanitizeDashboardSummaryForCache(
  summary: DashboardSummaryDTO,
): DashboardSummaryDTO {
  return {
    ...summary,
    profile: summary.profile
      ? {
          ...summary.profile,
          contact_phone: null,
          avatar_url: stripForbiddenMediaUrl(summary.profile.avatar_url),
          children: summary.profile.children.map((child) =>
            sanitizeChildProfileForCache(child),
          ),
        }
      : null,
    children: summary.children.map((child) =>
      sanitizeChildProfileForCache(child),
    ),
  };
}

function readRecordFromStorage<T>(
  storage: Storage | null,
  storageKey: string,
  userId: string,
  key: string,
): UserCacheRecord<T> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UserCacheRecord<T>> | null;
    if (
      !parsed ||
      parsed.userId !== userId ||
      parsed.key !== key ||
      typeof parsed.updatedAt !== "number" ||
      !("data" in parsed) ||
      containsForbiddenPayload(parsed.data)
    ) {
      storage.removeItem(storageKey);
      return null;
    }
    return {
      userId: parsed.userId,
      key: parsed.key,
      updatedAt: parsed.updatedAt,
      data: parsed.data as T,
    };
  } catch {
    try {
      storage.removeItem(storageKey);
    } catch {
      // Ignore storage cleanup errors.
    }
    return null;
  }
}

function readRawRecord<T>(
  userId: string,
  key: string,
): UserCacheRecord<T> | null {
  const storageKey = buildStorageKey(userId, key);
  const inMemory = memoryCache.get(storageKey);
  if (inMemory) {
    if (inMemory.userId !== userId || inMemory.key !== key) {
      memoryCache.delete(storageKey);
    } else {
      return inMemory as UserCacheRecord<T>;
    }
  }

  const fromSession = readRecordFromStorage<T>(
    getSessionStorageSafe(),
    storageKey,
    userId,
    key,
  );
  if (fromSession) {
    memoryCache.set(storageKey, fromSession);
    return fromSession;
  }

  const fromLocal = readRecordFromStorage<T>(
    getLocalStorageSafe(),
    storageKey,
    userId,
    key,
  );
  if (fromLocal) {
    memoryCache.set(storageKey, fromLocal);
    return fromLocal;
  }

  return null;
}

/**
 * Read a strictly per-user cached value if it has not exceeded `ttlMs`.
 * Returns `null` when missing, expired, or belonging to another user.
 */
export function readUserCache<T>(
  userId: string | null | undefined,
  key: string,
  ttlMs: number = DEFAULT_USER_CACHE_TTL_MS,
): T | null {
  const normalizedUserId = normalizeSegment(userId);
  const normalizedKey = normalizeSegment(key);
  if (!normalizedUserId || !normalizedKey || ttlMs <= 0) {
    return null;
  }
  if (FORBIDDEN_KEY_PATTERN.test(normalizedKey)) {
    return null;
  }

  const record = readRawRecord<T>(normalizedUserId, normalizedKey);
  if (!record) return null;

  if (Date.now() - record.updatedAt > ttlMs) {
    const storageKey = buildStorageKey(normalizedUserId, normalizedKey);
    memoryCache.delete(storageKey);
    removeFromAllStorages(storageKey);
    return null;
  }

  return cloneValue(record.data);
}

/**
 * Read a per-user cache entry along with staleness metadata for SWR views.
 * Entries older than `maxStaleMs` are discarded.
 */
export function readUserCacheWithStale<T>(
  userId: string | null | undefined,
  key: string,
  ttlMs: number = DEFAULT_USER_CACHE_TTL_MS,
  maxStaleMs: number = DEFAULT_USER_CACHE_TTL_MS * 5,
): UserCacheReadResult<T> | null {
  const normalizedUserId = normalizeSegment(userId);
  const normalizedKey = normalizeSegment(key);
  if (!normalizedUserId || !normalizedKey || maxStaleMs <= 0) {
    return null;
  }
  if (FORBIDDEN_KEY_PATTERN.test(normalizedKey)) {
    return null;
  }

  const record = readRawRecord<T>(normalizedUserId, normalizedKey);
  if (!record) return null;

  const ageMs = Date.now() - record.updatedAt;
  if (ageMs > maxStaleMs) {
    const storageKey = buildStorageKey(normalizedUserId, normalizedKey);
    memoryCache.delete(storageKey);
    removeFromAllStorages(storageKey);
    return null;
  }

  return {
    data: cloneValue(record.data),
    updatedAt: record.updatedAt,
    isStale: ageMs > ttlMs,
  };
}

/**
 * Persist non-sensitive UI query data strictly partitioned by `userId`.
 * Refuses auth tokens or private media URLs by design.
 */
export function writeUserCache<T>(
  userId: string | null | undefined,
  key: string,
  data: T,
  options?: UserCacheWriteOptions,
): void {
  const normalizedUserId = normalizeSegment(userId);
  const normalizedKey = normalizeSegment(key);
  if (!normalizedUserId || !normalizedKey) {
    return;
  }
  if (
    FORBIDDEN_KEY_PATTERN.test(normalizedKey) ||
    containsForbiddenPayload(data)
  ) {
    return;
  }

  const storageKey = buildStorageKey(normalizedUserId, normalizedKey);
  const record: UserCacheRecord<T> = {
    userId: normalizedUserId,
    key: normalizedKey,
    updatedAt: Date.now(),
    data: cloneValue(data),
  };

  memoryCache.set(storageKey, record);

  const serialized = JSON.stringify(record);
  const sessionStorageRef = getSessionStorageSafe();
  if (sessionStorageRef) {
    try {
      sessionStorageRef.setItem(storageKey, serialized);
    } catch {
      // Ignore sessionStorage quota or privacy mode errors; memory cache remains valid.
    }
  }
  if (options?.persist === "local") {
    const localStorageRef = getLocalStorageSafe();
    if (localStorageRef) {
      try {
        localStorageRef.setItem(storageKey, serialized);
      } catch {
        // Ignore localStorage quota or privacy mode errors.
      }
    }
  }
}

/**
 * Remove a single key for a specific user from memory, sessionStorage, and localStorage.
 */
export function invalidateUserCacheKey(
  userId: string | null | undefined,
  key: string,
): void {
  const normalizedUserId = normalizeSegment(userId);
  const normalizedKey = normalizeSegment(key);
  if (!normalizedUserId || !normalizedKey) return;

  const storageKey = buildStorageKey(normalizedUserId, normalizedKey);
  memoryCache.delete(storageKey);
  removeFromAllStorages(storageKey);
}

/**
 * Purge cached entries for one `userId` or ALL users when `userId` is omitted.
 * Must be called on logout and authenticated account switches.
 */
export function clearUserCache(userId?: string | null): void {
  const normalizedUserId = normalizeSegment(userId);
  const targetPrefix = normalizedUserId
    ? `${USER_CACHE_STORAGE_PREFIX}${normalizedUserId}:`
    : USER_CACHE_STORAGE_PREFIX;

  for (const key of Array.from(memoryCache.keys())) {
    if (key.startsWith(targetPrefix)) {
      memoryCache.delete(key);
    }
  }

  for (const storage of [getSessionStorageSafe(), getLocalStorageSafe()]) {
    if (!storage) continue;
    try {
      const keysToRemove: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const storageKey = storage.key(index);
        if (storageKey && storageKey.startsWith(targetPrefix)) {
          keysToRemove.push(storageKey);
        }
      }
      for (const storageKey of keysToRemove) {
        storage.removeItem(storageKey);
      }
    } catch {
      // Ignore storage cleanup errors.
    }
  }
}
