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

  // The role comes only from the database profile, never provider metadata.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();

  const role =
    profile?.role === "parent" || profile?.role === "admin"
      ? profile.role
      : null;

  if (profileError || !role) {
    await signOutQuietly(supabase);
    return redirectToLogin(request, "oauth_failed");
  }

  return NextResponse.redirect(
    new URL(role === "admin" ? "/admin/books" : "/dashboard", request.url),
  );
}
