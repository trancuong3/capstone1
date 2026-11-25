import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { ParentRole } from "@/types/profile";

export const VIREAD_ROLE_CACHE_COOKIE = "viread_role_cache";
export const VIREAD_SSR_AUTH_HEADER = "x-viread-ssr-auth";

export const ROLE_CACHE_TTL_MS = 30_000;
export const ROLE_CACHE_MAX_AGE_SECONDS = 30;
const REQUEST_HANDOFF_TTL_MS = 10_000;

export interface CookieNameValue {
  readonly name: string;
  readonly value: string;
}

export interface SignedSsrRoleCachePayload {
  readonly v: 1;
  readonly sub: string;
  readonly role: ParentRole;
  readonly ch: string;
  readonly exp: number;
}

export interface SignedSsrAuthHeaderPayload {
  readonly v: 1;
  readonly sub: string;
  readonly role?: ParentRole;
  readonly ch: string;
  readonly exp: number;
}

const globalForAuthCache = globalThis as typeof globalThis & {
  __vireadSsrAuthHmacKey?: Buffer;
};

function getSigningKey(): Buffer {
  const configured =
    process.env.VIREAD_SSR_AUTH_SIGNING_KEY?.trim() ||
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY?.trim();

  if (configured) {
    return createHash("sha256")
      .update(`viread-ssr-auth-v1:${configured}`)
      .digest();
  }

  if (!globalForAuthCache.__vireadSsrAuthHmacKey) {
    globalForAuthCache.__vireadSsrAuthHmacKey = randomBytes(32);
  }
  return globalForAuthCache.__vireadSsrAuthHmacKey;
}

function isSupabaseAuthCookieName(name: string): boolean {
  return (
    (name.startsWith("sb-") && name.includes("-auth-token")) ||
    name === "supabase-auth-token"
  );
}

/**
 * Bind cached SSR auth claims/role to the exact Supabase auth session cookies
 * so sign-out, token clearing, or account switches invalidate cache at once.
 */
export function computeSupabaseAuthCookieFingerprint(
  cookies: readonly CookieNameValue[],
): string {
  const authCookies = cookies
    .filter((cookie) => isSupabaseAuthCookieName(cookie.name) && cookie.value)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (authCookies.length === 0) {
    return "";
  }

  const hash = createHash("sha256");
  for (const cookie of authCookies) {
    hash.update(cookie.name);
    hash.update("=");
    hash.update(cookie.value);
    hash.update(";");
  }
  return hash.digest("base64url");
}

function signPayload(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const sig = createHmac("sha256", getSigningKey())
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyToken(
  token: string | null | undefined,
): Record<string, unknown> | null {
  if (!token || typeof token !== "string") {
    return null;
  }

  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex === token.length - 1) {
    return null;
  }

  const encoded = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);
  if (!encoded || !providedSig) {
    return null;
  }

  const expectedSig = createHmac("sha256", getSigningKey())
    .update(encoded)
    .digest("base64url");

  const providedBuf = Buffer.from(providedSig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isValidRole(value: unknown): value is ParentRole {
  return value === "parent" || value === "admin";
}

export function readProfileRole(profile: unknown): ParentRole | null {
  if (typeof profile !== "object" || profile === null || !("role" in profile)) {
    return null;
  }
  if (
    "active" in profile &&
    (profile.active === 0 || profile.active === false)
  ) {
    return null;
  }

  return isValidRole(profile.role) ? profile.role : null;
}

export function stripUntrustedSsrAuthHeaders(headers: Headers): Headers {
  const cleaned = new Headers(headers);
  for (const key of Array.from(cleaned.keys())) {
    if (key.toLowerCase().startsWith("x-viread-")) {
      cleaned.delete(key);
    }
  }
  return cleaned;
}

export function signSsrRoleCacheCookie(params: {
  userId: string;
  role: ParentRole;
  cookieHash: string;
  now?: number;
}): string {
  const now = params.now ?? Date.now();
  const payload: SignedSsrRoleCachePayload = {
    v: 1,
    sub: params.userId,
    role: params.role,
    ch: params.cookieHash,
    exp: now + ROLE_CACHE_TTL_MS,
  };
  return signPayload(payload);
}

export function verifySsrRoleCacheCookie(
  rawValue: string | null | undefined,
  expectedUserId: string,
  expectedCookieHash: string,
  now: number = Date.now(),
): ParentRole | null {
  const parsed = verifyToken(rawValue);
  if (!parsed) {
    return null;
  }

  if (
    parsed.v !== 1 ||
    typeof parsed.sub !== "string" ||
    parsed.sub !== expectedUserId ||
    !isValidRole(parsed.role) ||
    typeof parsed.ch !== "string" ||
    parsed.ch !== expectedCookieHash ||
    typeof parsed.exp !== "number" ||
    !Number.isFinite(parsed.exp) ||
    parsed.exp <= now
  ) {
    return null;
  }

  return parsed.role;
}

export function signSsrAuthHeader(params: {
  userId: string;
  role?: ParentRole;
  cookieHash: string;
  now?: number;
}): string {
  const now = params.now ?? Date.now();
  const payload: SignedSsrAuthHeaderPayload = {
    v: 1,
    sub: params.userId,
    ...(params.role ? { role: params.role } : {}),
    ch: params.cookieHash,
    exp: now + REQUEST_HANDOFF_TTL_MS,
  };
  return signPayload(payload);
}

export function verifySsrAuthHeader(
  rawHeader: string | null | undefined,
  expectedCookieHash: string,
  now: number = Date.now(),
): { userId: string; role?: ParentRole } | null {
  const parsed = verifyToken(rawHeader);
  if (!parsed) {
    return null;
  }

  if (
    parsed.v !== 1 ||
    typeof parsed.sub !== "string" ||
    !parsed.sub ||
    typeof parsed.ch !== "string" ||
    parsed.ch !== expectedCookieHash ||
    typeof parsed.exp !== "number" ||
    !Number.isFinite(parsed.exp) ||
    parsed.exp <= now
  ) {
    return null;
  }

  if (parsed.role !== undefined && !isValidRole(parsed.role)) {
    return null;
  }

  return {
    userId: parsed.sub,
    ...(isValidRole(parsed.role) ? { role: parsed.role } : {}),
  };
}
