// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createServerClientMock = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...args),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

import { cookies, headers } from "next/headers";

import { getAppIdentity } from "@/lib/auth/server-authorization";
import {
  computeSupabaseAuthCookieFingerprint,
  ROLE_CACHE_MAX_AGE_SECONDS,
  ROLE_CACHE_TTL_MS,
  signSsrAuthHeader,
  signSsrRoleCacheCookie,
  stripUntrustedSsrAuthHeaders,
  verifySsrAuthHeader,
  verifySsrRoleCacheCookie,
  VIREAD_ROLE_CACHE_COOKIE,
  VIREAD_SSR_AUTH_HEADER,
} from "@/lib/auth/ssr-auth-cache";
import { refreshSupabaseAuth } from "@/lib/supabase/proxy";

describe("SSR auth cache and proxy handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  });

  it("strips unsigned or client-forged x-viread headers before downstream verification", () => {
    const incoming = new Headers({
      "x-viread-ssr-auth": "forged.payload",
      "x-viread-role": "admin",
      "x-email-relay-timestamp": "1795753436",
      "x-email-relay-signature": "email-hmac-signature",
      accept: "text/html",
    });

    const cleaned = stripUntrustedSsrAuthHeaders(incoming);
    expect(cleaned.get("x-viread-ssr-auth")).toBeNull();
    expect(cleaned.get("x-viread-role")).toBeNull();
    expect(cleaned.get("x-email-relay-timestamp")).toBe("1795753436");
    expect(cleaned.get("x-email-relay-signature")).toBe("email-hmac-signature");
    expect(cleaned.get("accept")).toBe("text/html");
  });

  it("invalidates signed role cookies on tampering, expiry, user change, or cookie change", () => {
    const cookieHash = computeSupabaseAuthCookieFingerprint([
      { name: "sb-proj-auth-token", value: "token-a" },
    ]);
    const signed = signSsrRoleCacheCookie({
      userId: "user-1",
      role: "parent",
      cookieHash,
      now: 1_000,
    });

    expect(
      verifySsrRoleCacheCookie(
        signed,
        "user-1",
        cookieHash,
        1_000 + ROLE_CACHE_TTL_MS - 1,
      ),
    ).toBe("parent");
    // Tampered payload/signature rejected
    expect(
      verifySsrRoleCacheCookie(`${signed}x`, "user-1", cookieHash, 5_000),
    ).toBeNull();
    // Expired TTL rejected
    expect(
      verifySsrRoleCacheCookie(
        signed,
        "user-1",
        cookieHash,
        1_000 + ROLE_CACHE_TTL_MS,
      ),
    ).toBeNull();
    // Different user rejected
    expect(
      verifySsrRoleCacheCookie(signed, "user-2", cookieHash, 5_000),
    ).toBeNull();
    // Cookie fingerprint change (logout / account switch) rejected
    const switchedHash = computeSupabaseAuthCookieFingerprint([
      { name: "sb-proj-auth-token", value: "token-b" },
    ]);
    expect(
      verifySsrRoleCacheCookie(signed, "user-1", switchedHash, 5_000),
    ).toBeNull();
    expect(verifySsrRoleCacheCookie(signed, "user-1", "", 5_000)).toBeNull();
  });

  it("caches verified role cookie in proxy on protected routes and skips redundant getClaims/profiles in getAppIdentity", async () => {
    const profileQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { role: "admin", active: true },
        error: null,
      }),
    };
    const supabaseClient = {
      auth: {
        getClaims: vi.fn().mockResolvedValue({
          data: { claims: { sub: "admin-1" } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue(profileQuery),
    };
    createServerClientMock.mockReturnValue(supabaseClient);

    const request = new NextRequest("https://app.example.com/admin/books", {
      headers: {
        cookie: "sb-proj-auth-token=session-123",
        "x-viread-ssr-auth": "spoofed-by-client",
      },
    });

    const result = await refreshSupabaseAuth(request);
    expect(result.userId).toBe("admin-1");
    expect(profileQuery.maybeSingle).toHaveBeenCalledOnce();

    const cachedCookie = result.response.cookies.get(VIREAD_ROLE_CACHE_COOKIE);
    expect(cachedCookie?.value).toBeTruthy();
    expect(cachedCookie?.httpOnly).toBe(true);
    expect(cachedCookie?.maxAge).toBe(ROLE_CACHE_MAX_AGE_SECONDS);

    const forwardedSignedHeader = result.response.headers.get(
      `x-middleware-request-${VIREAD_SSR_AUTH_HEADER}`,
    );
    expect(forwardedSignedHeader).toBeTruthy();
    expect(forwardedSignedHeader).not.toBe("spoofed-by-client");

    // Second navigation with the signed role cookie skips profiles DB query in proxy
    profileQuery.maybeSingle.mockClear();
    const nextRequest = new NextRequest(
      "https://app.example.com/admin/books/1",
      {
        headers: {
          cookie: `sb-proj-auth-token=session-123; ${VIREAD_ROLE_CACHE_COOKIE}=${cachedCookie!.value}`,
        },
      },
    );
    const nextResult = await refreshSupabaseAuth(nextRequest);
    expect(nextResult.userId).toBe("admin-1");
    expect(profileQuery.maybeSingle).not.toHaveBeenCalled();

    // Server Component getAppIdentity accepts the verified header without any Supabase call
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        [VIREAD_SSR_AUTH_HEADER]: nextResult.response.headers.get(
          `x-middleware-request-${VIREAD_SSR_AUTH_HEADER}`,
        )!,
      }),
    );
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [
        { name: "sb-proj-auth-token", value: "session-123" },
        { name: VIREAD_ROLE_CACHE_COOKIE, value: cachedCookie!.value },
      ],
      get: (name: string) =>
        name === VIREAD_ROLE_CACHE_COOKIE
          ? { name, value: cachedCookie!.value }
          : undefined,
    } as never);

    createServerClientMock.mockClear();
    const identity = await getAppIdentity();
    expect(identity).toEqual({ id: "admin-1", role: "admin" });
    expect(createServerClientMock).not.toHaveBeenCalled();
  });

  it("clears cached role cookie immediately when session is logged out / unauthenticated", async () => {
    createServerClientMock.mockReturnValue({
      auth: {
        getClaims: vi.fn().mockResolvedValue({
          data: { claims: {} },
          error: null,
        }),
      },
    });

    const staleCookie = signSsrRoleCacheCookie({
      userId: "user-1",
      role: "parent",
      cookieHash: "old-hash",
    });
    const request = new NextRequest("https://app.example.com/dashboard", {
      headers: {
        cookie: `${VIREAD_ROLE_CACHE_COOKIE}=${staleCookie}`,
      },
    });

    const result = await refreshSupabaseAuth(request);
    expect(result.userId).toBeNull();
    const cleared = result.response.cookies.get(VIREAD_ROLE_CACHE_COOKIE);
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);

    // Unsigned / forged header in RSC fails closed back to Supabase verification
    const validHeaderForDifferentCookie = signSsrAuthHeader({
      userId: "admin-1",
      role: "admin",
      cookieHash: "stale-hash",
    });
    expect(verifySsrAuthHeader(validHeaderForDifferentCookie, "")).toBeNull();
  });
});
