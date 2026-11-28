import {
  clearApiReadCache,
  registerCacheResetListener,
  setApiReadCacheActorScope,
  setApiReadCacheEnabled,
} from "@/lib/api/read-cache";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

const TOKEN_REFRESH_SAFETY_WINDOW_MS = 30_000;
const MAX_LOCAL_TOKEN_CACHE_MS = 15_000;

interface CachedTokenState {
  readonly accessToken: string;
  readonly userId: string | null;
  readonly expiresAtMs: number;
}

let inflightTokenLookup: Promise<string> | null = null;
let inflightTokenRefresh: Promise<string | null> | null = null;
let cachedTokenState: CachedTokenState | null = null;
let authListenerClient: object | null = null;
const initializedClients = new WeakSet<object>();

export function resetBrowserAuthCache(): void {
  inflightTokenLookup = null;
  inflightTokenRefresh = null;
  cachedTokenState = null;
  authListenerClient = null;
}

registerCacheResetListener(resetBrowserAuthCache, { onActorSwitch: false });

export function invalidateBrowserTokenCache(): void {
  cachedTokenState = null;
}

export interface BrowserAccessTokenOptions {
  readonly onUnauthorized: () => Error;
}

/**
 * Coalesces concurrent `supabase.auth.initialize()` + `getSession()` calls across
 * parallel API requests and short-caches tokens only when Supabase exposes
 * `onAuthStateChange` so test mocks stay isolated while real browsers skip
 * redundant session round-trips on fast clicks and tab switches.
 */
export async function getBrowserAccessToken({
  onUnauthorized,
}: BrowserAccessTokenOptions): Promise<string> {
  const now = Date.now();
  if (cachedTokenState && cachedTokenState.expiresAtMs > now) {
    return cachedTokenState.accessToken;
  }

  if (inflightTokenLookup) {
    try {
      return await inflightTokenLookup;
    } catch {
      throw onUnauthorized();
    }
  }

  const lookupPromise = (async (): Promise<string> => {
    const supabase = createBrowserSupabaseClient();
    const auth = supabase.auth as unknown as {
      initialize?: () => Promise<{ error: unknown | null }>;
      getSession: () => Promise<{
        data: {
          session: {
            access_token?: string | null;
            expires_at?: number | null;
            user?: { id?: string | null } | null;
          } | null;
        };
        error: unknown | null;
      }>;
      onAuthStateChange?: (
        callback: (
          event: string,
          session: {
            access_token?: string | null;
            expires_at?: number | null;
            user?: { id?: string | null } | null;
          } | null,
        ) => void,
      ) => { data?: { subscription?: { unsubscribe?: () => void } } };
    };

    const supportsReactiveAuthEvents =
      typeof auth.onAuthStateChange === "function";
    if (supportsReactiveAuthEvents) {
      setApiReadCacheEnabled(true);
    }
    if (supportsReactiveAuthEvents && authListenerClient !== auth) {
      authListenerClient = auth;
      auth.onAuthStateChange?.((event, session) => {
        if (event === "SIGNED_OUT" || !session?.access_token) {
          cachedTokenState = null;
          setApiReadCacheActorScope(null);
          clearApiReadCache();
          return;
        }

        const nextUserId = session.user?.id ?? null;
        setApiReadCacheActorScope(nextUserId);
        const sessionExpMs =
          typeof session.expires_at === "number"
            ? session.expires_at * 1000 - TOKEN_REFRESH_SAFETY_WINDOW_MS
            : Date.now() + MAX_LOCAL_TOKEN_CACHE_MS;
        cachedTokenState = {
          accessToken: session.access_token,
          userId: nextUserId,
          expiresAtMs: Math.min(
            Date.now() + MAX_LOCAL_TOKEN_CACHE_MS,
            sessionExpMs,
          ),
        };
      });
    }

    if (typeof auth.initialize === "function") {
      const shouldInitialize =
        !supportsReactiveAuthEvents || !initializedClients.has(auth);
      if (shouldInitialize) {
        const { error: initializationError } = await auth.initialize();
        if (initializationError) {
          throw onUnauthorized();
        }
        if (supportsReactiveAuthEvents) {
          initializedClients.add(auth);
        }
      }
    }

    const { data, error } = await auth.getSession();
    const token = data.session?.access_token;
    if (error || typeof token !== "string" || !token) {
      cachedTokenState = null;
      throw onUnauthorized();
    }

    if (supportsReactiveAuthEvents) {
      const userId = data.session?.user?.id ?? null;
      const sessionExpMs =
        typeof data.session?.expires_at === "number"
          ? data.session.expires_at * 1000 - TOKEN_REFRESH_SAFETY_WINDOW_MS
          : Date.now() + MAX_LOCAL_TOKEN_CACHE_MS;
      cachedTokenState = {
        accessToken: token,
        userId,
        expiresAtMs: Math.min(
          Date.now() + MAX_LOCAL_TOKEN_CACHE_MS,
          sessionExpMs,
        ),
      };
      if (userId) {
        setApiReadCacheActorScope(userId);
      }
    }

    return token;
  })();

  inflightTokenLookup = lookupPromise;
  try {
    return await lookupPromise;
  } finally {
    if (inflightTokenLookup === lookupPromise) {
      inflightTokenLookup = null;
    }
  }
}

/**
 * Coalesces concurrent 401-triggered `supabase.auth.refreshSession()` calls so
 * parallel API failures perform at most one token refresh round-trip.
 */
export async function refreshBrowserAccessToken(
  failedToken?: string,
): Promise<string | null> {
  const now = Date.now();
  if (
    cachedTokenState &&
    cachedTokenState.expiresAtMs > now &&
    (!failedToken || cachedTokenState.accessToken !== failedToken)
  ) {
    return cachedTokenState.accessToken;
  }

  if (inflightTokenRefresh) {
    return await inflightTokenRefresh;
  }

  const refreshPromise = (async (): Promise<string | null> => {
    const supabase = createBrowserSupabaseClient();
    const auth = supabase.auth as unknown as {
      refreshSession?: () => Promise<{
        data: {
          session: {
            access_token?: string | null;
            expires_at?: number | null;
            user?: { id?: string | null } | null;
          } | null;
        };
        error: unknown | null;
      }>;
      onAuthStateChange?: unknown;
    };

    if (typeof auth.refreshSession !== "function") {
      cachedTokenState = null;
      return null;
    }

    let result: Awaited<ReturnType<NonNullable<typeof auth.refreshSession>>>;
    try {
      result = await auth.refreshSession();
    } catch {
      cachedTokenState = null;
      return null;
    }

    const refreshedToken = result.data?.session?.access_token;
    if (
      result.error ||
      typeof refreshedToken !== "string" ||
      !refreshedToken ||
      (failedToken && refreshedToken === failedToken)
    ) {
      cachedTokenState = null;
      return null;
    }

    const supportsReactiveAuthEvents =
      typeof auth.onAuthStateChange === "function";
    if (supportsReactiveAuthEvents) {
      const userId = result.data.session?.user?.id ?? null;
      const sessionExpMs =
        typeof result.data.session?.expires_at === "number"
          ? result.data.session.expires_at * 1000 -
            TOKEN_REFRESH_SAFETY_WINDOW_MS
          : Date.now() + MAX_LOCAL_TOKEN_CACHE_MS;
      cachedTokenState = {
        accessToken: refreshedToken,
        userId,
        expiresAtMs: Math.min(
          Date.now() + MAX_LOCAL_TOKEN_CACHE_MS,
          sessionExpMs,
        ),
      };
      if (userId) {
        setApiReadCacheActorScope(userId);
      }
    }

    return refreshedToken;
  })();

  inflightTokenRefresh = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (inflightTokenRefresh === refreshPromise) {
      inflightTokenRefresh = null;
    }
  }
}
