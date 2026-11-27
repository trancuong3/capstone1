import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getProtectedRouteArea } from "@/lib/auth/route-policy";
import {
  computeSupabaseAuthCookieFingerprint,
  readProfileRole,
  ROLE_CACHE_MAX_AGE_SECONDS,
  signSsrAuthHeader,
  signSsrRoleCacheCookie,
  stripUntrustedSsrAuthHeaders,
  verifySsrRoleCacheCookie,
  VIREAD_ROLE_CACHE_COOKIE,
  VIREAD_SSR_AUTH_HEADER,
} from "@/lib/auth/ssr-auth-cache";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import type { ParentRole } from "@/types/profile";

const refreshResponseHeaders = ["cache-control", "expires", "pragma"] as const;

export interface SupabaseProxyAuthResult {
  readonly response: NextResponse;
  readonly userId: string | null;
  readonly role: ParentRole | null;
}

function isHttpsRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto) {
    return forwardedProto === "https";
  }
  return request.nextUrl.protocol === "https:";
}

function clearRoleCacheCookie(response: NextResponse, request: NextRequest) {
  response.cookies.set(VIREAD_ROLE_CACHE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(request),
    path: "/",
    maxAge: 0,
  });
}

function rebuildNextResponseWithHeaders(
  previous: NextResponse,
  forwardedHeaders: Headers,
): NextResponse {
  const rebuilt = NextResponse.next({
    request: { headers: forwardedHeaders },
  });
  previous.cookies.getAll().forEach((cookie) => {
    rebuilt.cookies.set(cookie);
  });
  previous.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      lower === "set-cookie" ||
      lower === "x-middleware-override-headers" ||
      lower.startsWith("x-middleware-request-")
    ) {
      return;
    }
    rebuilt.headers.set(name, value);
  });
  return rebuilt;
}

export async function refreshSupabaseAuth(
  request: NextRequest,
): Promise<SupabaseProxyAuthResult> {
  const currentPathWithQuery = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  // Never trust any client-supplied internal auth header.
  const forwardedHeaders = stripUntrustedSsrAuthHeaders(request.headers);
  forwardedHeaders.set("x-viread-next", currentPathWithQuery);
  let response = NextResponse.next({ request: { headers: forwardedHeaders } });
  const incomingCookies = request.cookies.getAll();
  const hasIncomingRoleCache = Boolean(
    request.cookies.get(VIREAD_ROLE_CACHE_COOKIE)?.value,
  );
  const incomingCookieHash =
    computeSupabaseAuthCookieFingerprint(incomingCookies);

  // Fast-path: when no Supabase auth cookie is present in production/dev,
  // avoid instantiating @supabase/ssr and calling getClaims() on every guest hit.
  if (
    process.env.NODE_ENV !== "test" &&
    !incomingCookieHash
  ) {
    if (hasIncomingRoleCache) {
      clearRoleCacheCookie(response, request);
    }
    return { response, userId: null, role: null };
  }

  const { publishableKey, url } = getSupabasePublicConfig();
  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, responseHeaders) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        const refreshedCookies = request.cookies.toString();
        if (refreshedCookies) {
          forwardedHeaders.set("cookie", refreshedCookies);
        } else {
          forwardedHeaders.delete("cookie");
        }

        response = NextResponse.next({
          request: { headers: forwardedHeaders },
        });
        cookiesToSet.forEach(({ name, options, value }) => {
          response.cookies.set(name, value, options);
        });
        Object.entries(responseHeaders).forEach(([name, value]) => {
          response.headers.set(name, value);
        });
      },
    },
  });

  // Keep this call immediately after client creation. It validates the JWT and
  // lets @supabase/ssr refresh request/response cookies before Server Components.
  const { data, error } = await supabase.auth.getClaims();
  const subject = data?.claims.sub;
  const userId =
    !error && typeof subject === "string" && subject ? subject : null;

  if (!userId) {
    if (hasIncomingRoleCache) {
      clearRoleCacheCookie(response, request);
    }
    return { response, userId: null, role: null };
  }

  const cookieHash = computeSupabaseAuthCookieFingerprint(
    request.cookies.getAll(),
  );
  const cachedRole = verifySsrRoleCacheCookie(
    request.cookies.get(VIREAD_ROLE_CACHE_COOKIE)?.value,
    userId,
    cookieHash,
  );

  let resolvedRole: ParentRole | undefined = cachedRole ?? undefined;
  const pathname = request.nextUrl.pathname;
  const shouldResolveRole =
    getProtectedRouteArea(pathname) !== null || pathname === "/";

  if (
    !resolvedRole &&
    shouldResolveRole &&
    typeof supabase.from === "function"
  ) {
    try {
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role, active")
        .eq("id", userId)
        .maybeSingle();
      const role = !profileError ? readProfileRole(profile) : null;
      if (role) {
        resolvedRole = role;
        response.cookies.set(
          VIREAD_ROLE_CACHE_COOKIE,
          signSsrRoleCacheCookie({ userId, role, cookieHash }),
          {
            httpOnly: true,
            sameSite: "lax",
            secure: isHttpsRequest(request),
            path: "/",
            maxAge: ROLE_CACHE_MAX_AGE_SECONDS,
          },
        );
      } else if (hasIncomingRoleCache) {
        clearRoleCacheCookie(response, request);
      }
    } catch {
      // Fail closed and let Server Component authorization inspect profiles directly.
    }
  }

  forwardedHeaders.set(
    VIREAD_SSR_AUTH_HEADER,
    signSsrAuthHeader({
      userId,
      role: resolvedRole,
      cookieHash,
    }),
  );
  response = rebuildNextResponseWithHeaders(response, forwardedHeaders);

  return {
    response,
    userId,
    role: resolvedRole ?? null,
  };
}

export function preserveSupabaseAuthResponse(
  source: NextResponse,
  target: NextResponse,
) {
  source.cookies.getAll().forEach((cookie) => {
    target.cookies.set(cookie);
  });

  refreshResponseHeaders.forEach((name) => {
    const value = source.headers.get(name);
    if (value !== null) target.headers.set(name, value);
  });

  return target;
}
