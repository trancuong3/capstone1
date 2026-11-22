import { NextResponse, type NextRequest } from "next/server";

import { createServerSupabaseClient } from "@/lib/supabase/server";

function redirectToLogin(
  request: NextRequest,
  oauthError: "email_required" | "oauth_failed",
) {
  const url = new URL("/login", request.url);
  url.searchParams.set("oauth_error", oauthError);
  return NextResponse.redirect(url);
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
    if (request.nextUrl.searchParams.get("next") === "/profile") {
      deepLinkParams.set("next", "/profile");
    }
    return NextResponse.redirect(
      `viread://auth/callback?${deepLinkParams.toString()}`,
    );
  }

  // Providers can redirect back with an OAuth error instead of an auth code.
  // Never reflect the provider's raw error text or details into the UI.
  if (providerError || !code) {
    return redirectToLogin(request, "oauth_failed");
  }

  const supabase = await createServerSupabaseClient();
  const { error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    await signOutQuietly(supabase);
    return redirectToLogin(request, "oauth_failed");
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const email = userData.user?.email?.trim();

  // Facebook may omit email if the account has no confirmed email or the app
  // has not been granted the email permission. Do not keep such a session.
  if (!userData.user || userError || !email) {
    await signOutQuietly(supabase);
    return redirectToLogin(request, "email_required");
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
    return redirectToLogin(request, "oauth_failed");
  }

  // Email-change confirmations can safely return to the Profile page.
  // Other Auth/OAuth flows retain their established role-based destination.
  const requestedNext = request.nextUrl.searchParams.get("next");
  const destination =
    requestedNext === "/profile"
      ? "/profile"
      : role === "admin"
        ? "/admin/books"
        : "/dashboard";

  return NextResponse.redirect(new URL(destination, request.url));
}
