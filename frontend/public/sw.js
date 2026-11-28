/* ViRead Offline App Shell Service Worker (CSP-safe, strict privacy guardrails).
 *
 * Security & privacy invariants:
 * - Zero external scripts, zero eval, same-origin GET only.
 * - NEVER caches `/admin`, `/auth`, `/api`, `/offline`, `/books/my-books`,
 *   `viread-private-books`, authenticated requests, or `Cache-Control: private|no-store`
 *   responses in shared shell caches.
 * - Immediately purges partitioned `viread-offline-pack:*` caches on
 *   `VIREAD_PURGE_ACCOUNT_CACHE` message (logout / auth clear).
 */

const SHELL_CACHE_NAME = "viread-app-shell-v1";
const OFFLINE_PACK_CACHE_PREFIX = "viread-offline-pack:";

const PRECACHE_SHELL_URLS = [
  "/icon.svg",
  "/favicon.ico",
  "/workers/sherpa-stt-worker.js",
];

const DENYLIST_PATH_PREFIXES = [
  "/admin",
  "/auth",
  "/api/",
  "/offline/",
  "/books/my-books",
  "/studio/",
  "/voice/",
  "/reading/sessions",
];

function isPublicStaticAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/wasm/") ||
    pathname.startsWith("/workers/") ||
    pathname.startsWith("/images/") ||
    pathname.startsWith("/audio/word-samples/") ||
    pathname === "/icon.svg" ||
    pathname === "/favicon.ico"
  );
}

function isSafeAppShellNavigation(request, url) {
  if (request.mode !== "navigate") return false;
  const p = url.pathname;
  if (DENYLIST_PATH_PREFIXES.some((prefix) => p.startsWith(prefix))) {
    return false;
  }
  return (
    p === "/books" ||
    p.startsWith("/books/") ||
    p.startsWith("/reading/") ||
    p === "/reading-preparation" ||
    p === "/dashboard"
  );
}

function canCacheShellResponse(response) {
  if (!response || response.status !== 200 || response.type !== "basic") {
    return false;
  }
  const cc = (response.headers.get("Cache-Control") || "").toLowerCase();
  if (cc.includes("private") || cc.includes("no-store")) {
    return false;
  }
  return true;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_SHELL_URLS.map((url) =>
            fetch(url, { credentials: "same-origin" }).then((res) => {
              if (res.ok) return cache.put(url, res);
              return undefined;
            }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("viread-app-shell-") && key !== SHELL_CACHE_NAME,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "VIREAD_PURGE_ACCOUNT_CACHE") {
    const parentId =
      typeof data.parentAccountId === "string" && data.parentAccountId.trim()
        ? data.parentAccountId.trim()
        : null;
    const prefix = parentId
      ? `${OFFLINE_PACK_CACHE_PREFIX}${encodeURIComponent(parentId)}:`
      : OFFLINE_PACK_CACHE_PREFIX;
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((name) => name.startsWith(prefix))
            .map((name) => caches.delete(name)),
        ),
      ),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("Authorization")) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (DENYLIST_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    return;
  }

  if (isPublicStaticAsset(url.pathname)) {
    event.respondWith(
      caches.open(SHELL_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const networkResponse = await fetch(request);
        if (canCacheShellResponse(networkResponse)) {
          void cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      }),
    );
    return;
  }

  if (isSafeAppShellNavigation(request, url)) {
    event.respondWith(
      fetch(request)
        .then(async (networkResponse) => {
          if (canCacheShellResponse(networkResponse)) {
            const cache = await caches.open(SHELL_CACHE_NAME);
            void cache.put(url.pathname, networkResponse.clone());
          }
          return networkResponse;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE_NAME);
          const exact = await cache.match(url.pathname);
          if (exact) return exact;
          if (url.pathname.startsWith("/reading/")) {
            const fallbackReading = await cache.match("/books");
            if (fallbackReading) return fallbackReading;
          }
          const fallbackDashboard = await cache.match("/dashboard");
          if (fallbackDashboard) return fallbackDashboard;
          throw new Error("OFFLINE_SHELL_UNAVAILABLE");
        }),
    );
  }
});
