import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { readPlaywrightAuthFixture } from "@/lib/auth/playwright-auth-fixture";
import { getRoleHome } from "@/lib/auth/route-policy";
import {
  computeSupabaseAuthCookieFingerprint,
  readProfileRole,
  verifySsrAuthHeader,
  verifySsrRoleCacheCookie,
  VIREAD_ROLE_CACHE_COOKIE,
  VIREAD_SSR_AUTH_HEADER,
} from "@/lib/auth/ssr-auth-cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ParentRole, UUID } from "@/types/profile";

export interface AppIdentity {
  readonly id: UUID;
  readonly role: ParentRole;
}

export const getAppIdentity = cache(async (): Promise<AppIdentity | null> => {
  const requestHeaders = await headers();
  const fixtureRole = readPlaywrightAuthFixture(requestHeaders);

  if (fixtureRole) {
    return {
      id:
        fixtureRole === "admin"
          ? "88000000-0000-4000-8000-000000000001"
          : "11111111-1111-4111-8111-111111111111",
      role: fixtureRole,
    };
  }

  const cookieStore = await cookies();
  const cookieHash = computeSupabaseAuthCookieFingerprint(cookieStore.getAll());
  const verifiedHeader = verifySsrAuthHeader(
    requestHeaders.get(VIREAD_SSR_AUTH_HEADER),
    cookieHash,
  );
  if (verifiedHeader?.role) {
    return {
      id: verifiedHeader.userId,
      role: verifiedHeader.role,
    };
  }

  let subject = verifiedHeader?.userId ?? null;
  let supabase: Awaited<ReturnType<typeof createServerSupabaseClient>> | null =
    null;

  if (!subject) {
    supabase = await createServerSupabaseClient();
    const { data: claimsData, error: claimsError } =
      await supabase.auth.getClaims();
    const claimsSubject = claimsData?.claims.sub;

    if (claimsError || typeof claimsSubject !== "string" || !claimsSubject) {
      return null;
    }
    subject = claimsSubject;
  }

  const cachedRole = verifySsrRoleCacheCookie(
    cookieStore.get(VIREAD_ROLE_CACHE_COOKIE)?.value,
    subject,
    cookieHash,
  );
  if (cachedRole) {
    return { id: subject, role: cachedRole };
  }

  const client = supabase ?? (await createServerSupabaseClient());
  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("role, active")
    .eq("id", subject)
    .maybeSingle();
  const role = readProfileRole(profile);

  if (profileError || !role) return null;

  return { id: subject, role };
});

export async function requireAppRole(
  requiredRole: ParentRole,
  nextPath?: string,
) {
  const identity = await getAppIdentity();

  if (!identity) {
    const requestHeaders = await headers();
    const resolvedNext =
      nextPath ?? requestHeaders.get("x-viread-next") ?? undefined;
    const loginPath = requiredRole === "admin" ? "/admin/login" : "/login";
    redirect(buildLoginRedirectPath(loginPath, resolvedNext));
  }

  if (identity.role !== requiredRole) {
    redirect(getRoleHome(identity.role));
  }

  return identity;
}
