"use client";

import { createClient } from "@supabase/supabase-js";
import type {
  AuthError,
  Session,
  SupabaseClient,
  User,
} from "@supabase/supabase-js";

import {
  AuthServiceError,
  type AuthService,
} from "@/lib/api/auth-service";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import type {
  AuthSessionSnapshot,
  AuthUserSnapshot,
  ParentRegistrationResult,
} from "@/types/auth";
import type { ParentRole } from "@/types/profile";

interface SupabaseAuthServiceOptions {
  getOAuthRedirectUrl?: () => string;
  getEmailConfirmationRedirectUrl?: () => string;
  getPasswordResetRedirectUrl?: () => string;
  createReauthenticationClient?: () => SupabaseClient;
}

const registrationValidationCodes = new Set([
  "email_address_invalid",
  "validation_failed",
  "weak_password",
]);

const duplicateRegistrationCodes = new Set([
  "email_exists",
  "user_already_exists",
]);

const invalidCredentialCodes = new Set([
  "email_not_confirmed",
  "invalid_credentials",
  "user_banned",
  "user_not_found",
]);

const expiredRecoveryCodes = new Set([
  "flow_state_expired",
  "otp_expired",
  "session_expired",
]);

const invalidRecoveryCodes = new Set([
  "bad_code_verifier",
  "bad_jwt",
  "flow_state_not_found",
  "no_authorization",
  "refresh_token_already_used",
  "refresh_token_not_found",
  "session_not_found",
]);

const unauthenticatedCodes = new Set([
  "bad_jwt",
  "no_authorization",
  "session_expired",
  "session_not_found",
]);

const invalidRecoveryErrorNames = new Set([
  "AuthPKCECodeVerifierMissingError",
  "AuthPKCEGrantCodeExchangeError",
  "AuthSessionMissingError",
]);

function unexpectedAuthError() {
  return new AuthServiceError(
    "unexpected",
    "The authentication provider could not complete the request.",
  );
}

function invalidRecoveryContextError() {
  return new AuthServiceError(
    "invalid-recovery-context",
    "The password recovery context is invalid.",
  );
}

function mapRegistrationError(error: AuthError) {
  if (registrationValidationCodes.has(error.code ?? "")) {
    return new AuthServiceError(
      "registration-validation",
      "The registration payload was rejected.",
    );
  }

  return unexpectedAuthError();
}

function mapSignInError(error: AuthError) {
  if (invalidCredentialCodes.has(error.code ?? "")) {
    return new AuthServiceError(
      "invalid-credentials",
      "The supplied credentials were rejected.",
    );
  }

  return unexpectedAuthError();
}

function mapRecoveryError(error: AuthError) {
  if (expiredRecoveryCodes.has(error.code ?? "")) {
    return new AuthServiceError(
      "expired-recovery-context",
      "The password recovery context has expired.",
    );
  }

  if (
    invalidRecoveryCodes.has(error.code ?? "") ||
    invalidRecoveryErrorNames.has(error.name)
  ) {
    return invalidRecoveryContextError();
  }

  return unexpectedAuthError();
}

function mapUser(user: User): AuthUserSnapshot {
  const displayName: unknown = user.user_metadata.display_name;
  const metadataProviders = user.app_metadata.providers;
  const identityProviders =
    user.identities?.map((identity) => identity.provider) ?? [];
  const providers = Array.from(
    new Set(
      [
        ...(Array.isArray(metadataProviders) ? metadataProviders : []),
        ...identityProviders,
        ...(typeof user.app_metadata.provider === "string"
          ? [user.app_metadata.provider]
          : []),
      ].filter(
        (provider): provider is string =>
          typeof provider === "string" && provider.trim().length > 0,
      ),
    ),
  );

  return {
    id: user.id,
    email: user.email ?? null,
    display_name:
      typeof displayName === "string" && displayName.trim()
        ? displayName.trim()
        : null,
    providers,
  };
}

function mapSession(session: Session): AuthSessionSnapshot {
  return {
    user: mapUser(session.user),
    expires_at: session.expires_at ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readParentRole(profile: unknown): ParentRole | null {
  if (!isRecord(profile)) return null;

  return profile.role === "parent" || profile.role === "admin"
    ? profile.role
    : null;
}

function defaultOAuthRedirectUrl() {
  if (typeof window === "undefined") {
    throw unexpectedAuthError();
  }

  return new URL("/auth/callback", window.location.origin).toString();
}

function defaultPasswordResetRedirectUrl() {
  if (typeof window === "undefined") {
    throw unexpectedAuthError();
  }

  return new URL("/reset-password", window.location.origin).toString();
}

function defaultEmailConfirmationRedirectUrl() {
  if (typeof window === "undefined") {
    throw unexpectedAuthError();
  }

  return new URL(
    "/login?auth_callback=signup",
    window.location.origin,
  ).toString();
}

function createIsolatedReauthenticationClient(): SupabaseClient {
  const { url, publishableKey } = getSupabasePublicConfig();

  // Reauthenticate without replacing the currently active browser session.
  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

async function runProviderOperation<T>(
  operation: () => PromiseLike<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    throw unexpectedAuthError();
  }
}

export function createSupabaseAuthService(
  supabase: SupabaseClient = createBrowserSupabaseClient(),
  options: SupabaseAuthServiceOptions = {},
): AuthService {
  const getOAuthRedirectUrl =
    options.getOAuthRedirectUrl ?? defaultOAuthRedirectUrl;
  const getPasswordResetRedirectUrl =
    options.getPasswordResetRedirectUrl ?? defaultPasswordResetRedirectUrl;
  const getEmailConfirmationRedirectUrl =
    options.getEmailConfirmationRedirectUrl ??
    defaultEmailConfirmationRedirectUrl;
  const createReauthenticationClient =
    options.createReauthenticationClient ??
    createIsolatedReauthenticationClient;
  let recoveryUserId: string | null = null;

  const signOutQuietly = async () => {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // A failed cleanup must not replace the original authorization failure.
    }
  };

  return {
    async initialize() {
      const { error } = await runProviderOperation(() =>
        supabase.auth.initialize(),
      );

      if (error) throw mapRecoveryError(error);
    },

    async registerParent(input): Promise<ParentRegistrationResult> {
      let emailRedirectTo: string;

      try {
        emailRedirectTo = getEmailConfirmationRedirectUrl();
      } catch {
        throw unexpectedAuthError();
      }

      const { data, error } = await runProviderOperation(() =>
        supabase.auth.signUp({
          email: input.email,
          password: input.password,
          options: {
            data: {
              display_name: input.displayName,
            },
            emailRedirectTo,
          },
        }),
      );

      if (error) {
        if (duplicateRegistrationCodes.has(error.code ?? "")) {
          throw unexpectedAuthError();
        }

        throw mapRegistrationError(error);
      }

      if (!data.user || data.user.identities?.length === 0) {
        throw unexpectedAuthError();
      }

      if (!data.session) {
        return {
          status: "email-confirmation-required",
          session: null,
        };
      }

      return {
        status: "authenticated",
        session: mapSession(data.session),
      };
    },

    async signIn(request) {
      const { data, error } = await runProviderOperation(() =>
        supabase.auth.signInWithPassword({
          email: request.email,
          password: request.password,
        }),
      );

      if (error) throw mapSignInError(error);
      if (!data.session) throw unexpectedAuthError();

      return mapSession(data.session);
    },

    async signInWithOAuth(provider) {
      let redirectTo: string;

      try {
        redirectTo = getOAuthRedirectUrl();
      } catch {
        throw unexpectedAuthError();
      }

      const scopes =
        provider === "facebook" ? "email" : "openid email profile";
      const { error } = await runProviderOperation(() =>
        supabase.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo,
            scopes,
          },
        }),
      );

      if (error) throw unexpectedAuthError();
    },

    async requestPasswordReset(request) {
      let redirectTo: string;

      try {
        redirectTo = getPasswordResetRedirectUrl();
      } catch {
        throw unexpectedAuthError();
      }

      const { error } = await runProviderOperation(() =>
        supabase.auth.resetPasswordForEmail(request.email, { redirectTo }),
      );

      if (error) throw unexpectedAuthError();
    },

    async changePassword(request) {
      const { data: activeUserData, error: activeUserError } =
        await runProviderOperation(() => supabase.auth.getUser());

      if (
        activeUserError ||
        !activeUserData.user?.id ||
        !activeUserData.user.email
      ) {
        throw new AuthServiceError(
          "invalid-credentials",
          "The supplied credentials were rejected.",
        );
      }

      const activeUserId = activeUserData.user.id;
      const activeEmail = activeUserData.user.email;
      let isolatedClient: SupabaseClient | null = null;

      try {
        try {
          isolatedClient = createReauthenticationClient();
        } catch {
          throw unexpectedAuthError();
        }

        const { data: reauthenticatedData, error: reauthenticationError } =
          await runProviderOperation(() =>
            isolatedClient!.auth.signInWithPassword({
              email: activeEmail,
              password: request.currentPassword,
            }),
          );

        if (reauthenticationError) {
          throw mapSignInError(reauthenticationError);
        }

        if (reauthenticatedData.user?.id !== activeUserId) {
          throw new AuthServiceError(
            "invalid-credentials",
            "The supplied credentials were rejected.",
          );
        }

        // Verify that the active browser session is still the original account.
        const { data: currentUserData, error: currentUserError } =
          await runProviderOperation(() => supabase.auth.getUser());

        if (currentUserError || currentUserData.user?.id !== activeUserId) {
          throw unexpectedAuthError();
        }

        const { error: updateError } = await runProviderOperation(() =>
          supabase.auth.updateUser({ password: request.newPassword }),
        );

        if (updateError) throw unexpectedAuthError();
      } finally {
        if (isolatedClient) {
          try {
            await isolatedClient.auth.signOut({ scope: "local" });
          } catch {
            // Clean up only the isolated reauthentication session.
          }
        }
      }
    },

    async resetPassword(request) {
      if (!recoveryUserId) throw invalidRecoveryContextError();

      const { data: userData, error: userError } = await runProviderOperation(
        () => supabase.auth.getUser(),
      );

      if (userError) {
        recoveryUserId = null;
        throw mapRecoveryError(userError);
      }

      if (userData.user?.id !== recoveryUserId) {
        recoveryUserId = null;
        throw invalidRecoveryContextError();
      }

      const { error } = await runProviderOperation(() =>
        supabase.auth.updateUser({ password: request.newPassword }),
      );

      if (error) {
        recoveryUserId = null;
        throw mapRecoveryError(error);
      }
      recoveryUserId = null;
      await signOutQuietly();
    },

    async getSession() {
      const { data, error } = await runProviderOperation(() =>
        supabase.auth.getSession(),
      );

      if (error) throw unexpectedAuthError();
      return data.session ? mapSession(data.session) : null;
    },

    async getCurrentUser() {
      const { data, error } = await runProviderOperation(() =>
        supabase.auth.getUser(),
      );

      if (error) {
        if (
          unauthenticatedCodes.has(error.code ?? "") ||
          error.name === "AuthSessionMissingError"
        ) {
          return null;
        }

        throw unexpectedAuthError();
      }

      return data.user ? mapUser(data.user) : null;
    },

    async getCurrentRole() {
      const { data: userData, error: userError } = await runProviderOperation(
        () => supabase.auth.getUser(),
      );

      if (userError) {
        if (
          unauthenticatedCodes.has(userError.code ?? "") ||
          userError.name === "AuthSessionMissingError"
        ) {
          return null;
        }

        throw unexpectedAuthError();
      }

      if (!userData.user) return null;

      const { data, error } = await runProviderOperation(() =>
        supabase
          .from("profiles")
          .select("role")
          .eq("id", userData.user.id)
          .maybeSingle(),
      );

      if (error) throw unexpectedAuthError();

      const role = readParentRole(data);
      if (!role) {
        await signOutQuietly();
        throw unexpectedAuthError();
      }

      return role;
    },

    async signOut() {
      recoveryUserId = null;
      const { error } = await runProviderOperation(() =>
        supabase.auth.signOut({ scope: "local" }),
      );

      if (error) throw unexpectedAuthError();
    },

    onAuthStateChange(listener) {
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === "PASSWORD_RECOVERY" && session) {
          recoveryUserId = session.user.id;
        } else if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
          recoveryUserId = null;
        }

        listener(event, session ? mapSession(session) : null);
      });

      return () => {
        data.subscription.unsubscribe();
      };
    },
  };
}
