import { NextResponse, type NextRequest } from "next/server";

import {
  AUTH_NEXT_COOKIE,
  isSafeRelativeNextCandidate,
  sanitizeNextPath,
} from "@/lib/auth/route-policy";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const SAFE_HOST_HEADER_RE = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

function parseConfiguredOrigin(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function isLoopbackOrPrivateLanHost(hostHeader: string): boolean {
  const hostname = hostHeader.replace(/:\d+$/, "").toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return true;
  }
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (
    octets.some(
      (value, idx) =>
        !Number.isInteger(value) ||
        String(value) !== parts[idx] ||
        value < 0 ||
        value > 255,
    )
  ) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function resolvePublicOrigin(request: NextRequest): string {
  const configuredSiteOrigin = parseConfiguredOrigin(
    process.env.NEXT_PUBLIC_SITE_URL,
  );
  const extraAllowedOrigins = (
    process.env.VIREAD_ALLOWED_CALLBACK_ORIGINS ?? ""
  )
    .split(",")
    .map((entry) => parseConfiguredOrigin(entry))
    .filter((entry): entry is string => entry !== null);

  const allowedOrigins = new Set<string>([
    ...(configuredSiteOrigin ? [configuredSiteOrigin] : []),
    ...extraAllowedOrigins,
  ]);
  const requestOrigin = new URL(request.url).origin;

  const rawHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ??
    request.headers.get("host")?.split(",")[0]?.trim() ??
    "";
  if (rawHost && SAFE_HOST_HEADER_RE.test(rawHost)) {
    const rawProto = request.headers
      .get("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim()
      .toLowerCase();
    const proto =
      rawProto === "https" || rawProto === "http"
        ? rawProto
        : request.nextUrl.protocol === "http:"
          ? "http"
          : "https";
    const candidateOrigin = `${proto}://${rawHost}`;
    if (
      allowedOrigins.has(candidateOrigin) ||
      (allowedOrigins.size === 0 &&
        (candidateOrigin === requestOrigin ||
          isLoopbackOrPrivateLanHost(rawHost))) ||
      (!configuredSiteOrigin && isLoopbackOrPrivateLanHost(rawHost))
    ) {
      return candidateOrigin;
    }
  }

  return configuredSiteOrigin ?? requestOrigin;
}

function readRequestedNext(request: NextRequest): string | null {
  const queryNext = request.nextUrl.searchParams.get("next");
  if (queryNext !== null) {
    return queryNext;
  }
  const cookieNext = request.cookies.get(AUTH_NEXT_COOKIE)?.value;
  if (!cookieNext) return null;
  try {
    return decodeURIComponent(cookieNext);
  } catch {
    return cookieNext;
  }
}

function redirectToLogin(
  request: NextRequest,
  oauthError: "email_required" | "oauth_failed",
  requestedNext: string | null,
) {
  const url = new URL("/login", resolvePublicOrigin(request));
  url.searchParams.set("oauth_error", oauthError);
  const safeNext = isSafeRelativeNextCandidate(requestedNext);
  if (safeNext) {
    url.searchParams.set("next", safeNext);
  }
  const response = NextResponse.redirect(url);
  response.cookies.delete(AUTH_NEXT_COOKIE);
  return response;
}

async function signOutQuietly(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
) {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // The callback must keep its safe failure even if cookie cleanup fails.
  }
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const providerError = request.nextUrl.searchParams.get("error");
  const appShell = request.nextUrl.searchParams.get("app_shell");
  const userAgent = request.headers.get("user-agent") ?? "";
  const requestedNext = readRequestedNext(request);

  // When OAuth finishes in Android's external browser, hand the untouched PKCE
  // code back into the ViRead Android WebView (which owns the PKCE code_verifier)
  // before attempting exchangeCodeForSession.
  if (appShell === "android" && !/ViReadAndroid\//i.test(userAgent)) {
    const deepLinkParams = new URLSearchParams();
    if (providerError && /^[A-Za-z0-9._~-]{1,128}$/.test(providerError)) {
      deepLinkParams.set("error", providerError);
    } else if (code && /^[A-Za-z0-9._~-]{1,512}$/.test(code)) {
      deepLinkParams.set("code", code);
    } else {
      deepLinkParams.set("error", "oauth_failed");
    }
    const safeNext = isSafeRelativeNextCandidate(requestedNext);
    if (safeNext) {
      deepLinkParams.set("next", safeNext);
    }
    return NextResponse.redirect(
      `viread://auth/callback?${deepLinkParams.toString()}`,
    );
  }

  // Providers can redirect back with an OAuth error instead of an auth code.
  // Never reflect the provider's raw error text or details into the UI.
  if (providerError || !code) {
    return redirectToLogin(request, "oauth_failed", requestedNext);
  }

  const supabase = await createServerSupabaseClient();
  const { error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    await signOutQuietly(supabase);
    return redirectToLogin(request, "oauth_failed", requestedNext);
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const email = userData.user?.email?.trim();

  // Facebook may omit email if the account has no confirmed email or the app
  // has not been granted the email permission. Do not keep such a session.
  if (!userData.user || userError || !email) {
    await signOutQuietly(supabase);
    return redirectToLogin(request, "email_required", requestedNext);
  }

  // The role comes only from the active database profile, never provider metadata.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role, active")
    .eq("id", userData.user.id)
    .maybeSingle();

  const isInactive =
    profile !== null &&
    typeof profile === "object" &&
    "active" in profile &&
    (profile.active === 0 || profile.active === false);
  const role =
    !isInactive && (profile?.role === "parent" || profile?.role === "admin")
      ? profile.role
      : null;

  if (profileError || !role) {
    await signOutQuietly(supabase);
    return redirectToLogin(request, "oauth_failed", requestedNext);
  }

  const destination = sanitizeNextPath(requestedNext, role);
  const response = NextResponse.redirect(
    new URL(destination, resolvePublicOrigin(request)),
  );
  response.cookies.delete(AUTH_NEXT_COOKIE);
  return response;
}
