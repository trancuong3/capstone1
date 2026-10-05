"use client";

import type { AuthError, SupabaseClient } from "@supabase/supabase-js";

import {
  AdminAuthError,
  type AdminAuthService,
} from "@/lib/api/admin-auth-service";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

const invalidCredentialCodes = new Set([
  "email_not_confirmed",
  "invalid_credentials",
  "user_banned",
  "user_not_found",
]);

function mapSignInError(error: AuthError) {
  return new AdminAuthError(
    invalidCredentialCodes.has(error.code ?? "")
      ? "invalid-credentials"
      : "safe-error",
  );
}

function readAdminProfile(profile: unknown) {
  if (typeof profile !== "object" || profile === null) return null;

  const role = "role" in profile ? profile.role : null;
  const displayName = "displayname" in profile ? profile.displayname : null;

  if (role !== "admin") return null;

  return {
    displayName:
      typeof displayName === "string" && displayName.trim()
        ? displayName.trim()
        : "Quản trị viên ReadAlong",
  };
}

export function createSupabaseAdminAuthService(
  supabase: SupabaseClient = createBrowserSupabaseClient(),
): AdminAuthService {
  let initialization: Promise<void> | null = null;

  const ensureInitialized = () => {
    initialization ??= (async () => {
      try {
        const { error } = await supabase.auth.initialize();
        if (error) throw new AdminAuthError("safe-error");
      } catch (error) {
        if (error instanceof AdminAuthError) throw error;
        throw new AdminAuthError("safe-error");
      }
    })();

    return initialization;
  };

  const signOutQuietly = async () => {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // Cleanup must not replace the original authorization failure.
    }
  };

  return {
    async signIn(request) {
      await ensureInitialized();

      let result: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>;
      try {
        result = await supabase.auth.signInWithPassword({
          email: request.email,
          password: request.password,
        });
      } catch {
        throw new AdminAuthError("safe-error");
      }

      if (result.error) throw mapSignInError(result.error);
      if (!result.data.session) throw new AdminAuthError("safe-error");

      let profileData: unknown = null;
      let hasProfileError = false;

      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("role, displayname")
          .eq("id", result.data.session.user.id)
          .maybeSingle();
        profileData = data;
        hasProfileError = Boolean(error);
      } catch {
        await signOutQuietly();
        throw new AdminAuthError("safe-error");
      }

      if (hasProfileError) {
        await signOutQuietly();
        throw new AdminAuthError("safe-error");
      }

      const profile = readAdminProfile(profileData);
      if (!profile) {
        await signOutQuietly();
        throw new AdminAuthError("forbidden");
      }

      return {
        actor_id: result.data.session.user.id,
        display_name: profile.displayName,
        role: "admin",
      };
    },

    async signOut() {
      await ensureInitialized();

      try {
        const { error } = await supabase.auth.signOut({ scope: "local" });
        if (error) throw new AdminAuthError("safe-error");
      } catch (error) {
        if (error instanceof AdminAuthError) throw error;
        throw new AdminAuthError("safe-error");
      }
    },
  };
}
