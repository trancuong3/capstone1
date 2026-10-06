import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { readPlaywrightAuthFixture } from "@/lib/auth/playwright-auth-fixture";
import { getRoleHome } from "@/lib/auth/route-policy";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ParentRole, UUID } from "@/types/profile";

export interface AppIdentity {
  readonly id: UUID;
  readonly role: ParentRole;
}

function readProfileRole(profile: unknown): ParentRole | null {
  if (typeof profile !== "object" || profile === null || !("role" in profile)) {
    return null;
  }

  return profile.role === "parent" || profile.role === "admin"
    ? profile.role
    : null;
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

  const supabase = await createServerSupabaseClient();
  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();
  const subject = claimsData?.claims.sub;

  if (claimsError || typeof subject !== "string" || !subject) {
    return null;
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", subject)
    .maybeSingle();
  const role = readProfileRole(profile);

  if (profileError || !role) return null;

  return { id: subject, role };
});

export async function requireAppRole(requiredRole: ParentRole) {
  const identity = await getAppIdentity();

  if (!identity) {
    redirect(requiredRole === "admin" ? "/admin/login" : "/login");
  }

  if (identity.role !== requiredRole) {
    redirect(getRoleHome(identity.role));
  }

  return identity;
}
