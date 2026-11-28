const DEFAULT_READ_CACHE_TTL_MS = 15_000;
const MAX_READ_CACHE_ENTRIES = 80;

interface CachedEntry {
  readonly value: unknown;
  readonly expiresAt: number;
  readonly actorScope: string;
}

interface InflightRead {
  promise: Promise<unknown>;
  readonly controller: AbortController;
  waiters: number;
  invalidated: boolean;
}

interface RegisteredResetListener {
  readonly listener: () => void;
  readonly onActorSwitch: boolean;
}

const readCache = new Map<string, CachedEntry>();
const inflightReads = new Map<string, InflightRead>();
const resetListeners = new Set<RegisteredResetListener>();
let activeActorScope = "anon";
let crossRequestCacheEnabled = false;
let cacheEpoch = 0;

const NON_CACHEABLE_PATH_PATTERNS = [
  // Draft revisions and signed playback can change externally.
  /^\/karaoke(?:\/|\?|$)/,
  /\/health(?:\?|$)/,
  /\/ocr(?:\/|\?|$)/,
  /\/ocr-jobs(?:\/|\?|$)/,
  /\/scan-page-ocr(?:\/|\?|$)/,
  /\/my-books(?:\/|\?|$)/,
  /\/global-tasks(?:\/|\?|$)/,
  /\/studio\/(?:(?:admin|parent)\/)?tasks(?:\/|\?|$)/,
  /\/workflows(?:\/|\?|$)/,
  /\/user-books(?:\/|\?|$)/,
  /\/processing(?:\/|\?|$)/,
  /\/image(?:\?|$)/,
  /\/sessions\/[^/]+\/reports(?:\?|$)/,
];

export function setApiReadCacheEnabled(enabled: boolean): void {
  crossRequestCacheEnabled = enabled;
}

export function registerCacheResetListener(
  listener: () => void,
  options?: { readonly onActorSwitch?: boolean },
): void {
  resetListeners.add({
    listener,
    onActorSwitch: options?.onActorSwitch ?? true,
  });
}

export function resetAllApiCachesForTests(): void {
  crossRequestCacheEnabled = false;
  resetApiReadCacheForActorSwitch();
  setApiReadCacheActorScope(null);
  for (const entry of resetListeners) {
    entry.listener();
  }
}

function cloneCachedValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      return value;
    }
  }
  return value;
}

function extractTokenScope(accessToken: string | null | undefined): string {
  if (!accessToken) {
    return "no-tok";
  }
  const parts = accessToken.split(".");
  if (parts.length === 3 && parts[1]) {
    try {
      const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const json =
        typeof atob === "function"
          ? atob(normalized)
          : Buffer.from(normalized, "base64").toString("utf8");
      const parsed = JSON.parse(json) as { sub?: unknown };
      if (typeof parsed.sub === "string" && parsed.sub) {
        return `sub:${parsed.sub}`;
      }
    } catch {
      // Fall back to bounded token fingerprint below.
    }
  }
  const suffix = accessToken.slice(-16);
  return `tok:${accessToken.length}:${suffix}`;
}

function normalizeCacheLocale(locale: string | undefined): string {
  const cleaned = (locale ?? "vi").replace(/\|/g, "").trim();
  return cleaned || "vi";
}

function buildCacheKey(
  path: string,
  accessToken?: string,
  locale: string = "vi",
): string {
  return `${activeActorScope}@${normalizeCacheLocale(locale)}|${extractTokenScope(accessToken)}|${path}`;
}

export function isCacheableApiGetPath(path: string): boolean {
  return !NON_CACHEABLE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export function setApiReadCacheActorScope(
  userId: string | null | undefined,
): void {
  const nextScope = userId ? `usr:${userId}` : "anon";
  if (nextScope !== activeActorScope) {
    activeActorScope = nextScope;
    resetApiReadCacheForActorSwitch();
  }
}

/**
 * Invalidates cached GET responses after a mutation or refresh without aborting
 * unrelated in-flight reads. In-flight reads started before this epoch will not
 * repopulate the cache when they settle.
 */
export function invalidateApiReadCache(): void {
  cacheEpoch += 1;
  readCache.clear();
  for (const entry of inflightReads.values()) {
    entry.invalidated = true;
  }
  inflightReads.clear();
}

/**
 * Clears cached reads AND aborts all in-flight reads. Call ONLY on logout,
 * actor switch, or test teardown.
 */
export function resetApiReadCacheForActorSwitch(): void {
  cacheEpoch += 1;
  readCache.clear();
  for (const entry of inflightReads.values()) {
    entry.invalidated = true;
    entry.controller.abort();
  }
  inflightReads.clear();
  for (const entry of resetListeners) {
    if (entry.onActorSwitch) {
      entry.listener();
    }
  }
}

export function clearApiReadCache(): void {
  invalidateApiReadCache();
}

export function invalidateApiReadCacheByPrefix(
  prefixOrPrefixes: string | readonly string[],
): void {
  const prefixes =
    typeof prefixOrPrefixes === "string"
      ? [prefixOrPrefixes]
      : prefixOrPrefixes;
  if (prefixes.length === 0) return;

  for (const key of readCache.keys()) {
    const separator = key.indexOf("|", key.indexOf("|") + 1);
    const path = separator >= 0 ? key.slice(separator + 1) : key;
    if (prefixes.some((prefix) => path.startsWith(prefix))) {
      readCache.delete(key);
    }
  }
  for (const [key, entry] of inflightReads.entries()) {
    const separator = key.indexOf("|", key.indexOf("|") + 1);
    const path = separator >= 0 ? key.slice(separator + 1) : key;
    if (prefixes.some((prefix) => path.startsWith(prefix))) {
      entry.invalidated = true;
      inflightReads.delete(key);
    }
  }
}

export function getCachedApiRead<T>(
  path: string,
  accessToken: string,
  now: number = Date.now(),
  locale: string = "vi",
): T | undefined {
  if (!crossRequestCacheEnabled || !isCacheableApiGetPath(path)) {
    return undefined;
  }

  const key = buildCacheKey(path, accessToken, locale);
  const entry = readCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now || entry.actorScope !== activeActorScope) {
    readCache.delete(key);
    return undefined;
  }

  // Refresh LRU insertion order.
  readCache.delete(key);
  readCache.set(key, entry);
  return cloneCachedValue(entry.value as T);
}

export function setCachedApiRead<T>(
  path: string,
  accessToken: string,
  value: T,
  ttlMs: number = DEFAULT_READ_CACHE_TTL_MS,
  now: number = Date.now(),
  locale: string = "vi",
): void {
  if (!crossRequestCacheEnabled || ttlMs <= 0 || !isCacheableApiGetPath(path)) {
    return;
  }

  const key = buildCacheKey(path, accessToken, locale);
  if (readCache.has(key)) {
    readCache.delete(key);
  }
  while (readCache.size >= MAX_READ_CACHE_ENTRIES) {
    const oldestKey = readCache.keys().next().value;
    if (oldestKey === undefined) break;
    readCache.delete(oldestKey);
  }

  readCache.set(key, {
    value: cloneCachedValue(value),
    expiresAt: now + ttlMs,
    actorScope: activeActorScope,
  });
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Coalesces concurrent identical GET requests and preserves per-caller AbortSignal
 * cleanup without poisoning sibling callers.
 */
export async function runCoalescedApiGet<T>(
  path: string,
  accessToken: string,
  signal: AbortSignal | undefined,
  loader: (sharedSignal: AbortSignal) => Promise<T>,
  options: {
    readonly cacheTtlMs?: number;
    readonly bypassCache?: boolean;
    readonly locale?: string;
  } = {},
): Promise<T> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  const locale = normalizeCacheLocale(options.locale);

  if (!options.bypassCache) {
    const cached = getCachedApiRead<T>(path, accessToken, Date.now(), locale);
    if (cached !== undefined) {
      return cached;
    }
  }

  const capturedScope = activeActorScope;
  const capturedEpoch = cacheEpoch;
  const key = buildCacheKey(path, accessToken, locale);
  let entry = inflightReads.get(key);
  if (!entry) {
    const controller = new AbortController();
    const inflightEntry: InflightRead = {
      promise: Promise.resolve(),
      controller,
      waiters: 0,
      invalidated: false,
    };
    const promise = loader(controller.signal)
      .then((result) => {
        if (
          !options.bypassCache &&
          !inflightEntry.invalidated &&
          capturedEpoch === cacheEpoch &&
          capturedScope === activeActorScope
        ) {
          setCachedApiRead(
            path,
            accessToken,
            result,
            options.cacheTtlMs ?? DEFAULT_READ_CACHE_TTL_MS,
            Date.now(),
            locale,
          );
        }
        return result;
      })
      .finally(() => {
        if (inflightReads.get(key) === inflightEntry) {
          inflightReads.delete(key);
        }
      });

    inflightEntry.promise = promise;
    entry = inflightEntry;
    inflightReads.set(key, entry);
  }

  entry.waiters += 1;
  let settled = false;

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (entry) {
        entry.waiters = Math.max(0, entry.waiters - 1);
        if (entry.waiters === 0) {
          if (inflightReads.get(key) === entry) {
            inflightReads.delete(key);
          }
          entry.controller.abort();
        }
      }
      reject(createAbortError());
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    entry!.promise.then(
      (result) => {
        if (settled) return;
        settled = true;
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve(cloneCachedValue(result as T));
      },
      (error) => {
        if (settled) return;
        settled = true;
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(error);
      },
    );
  });
}
