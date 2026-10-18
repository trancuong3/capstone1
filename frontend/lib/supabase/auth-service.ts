"use client";

import type {
  AuthError,
  Session,
  SupabaseClient,
  User,
} from "@supabase/supabase-js";

import { AuthServiceError, type AuthService } from "@/lib/api/auth-service";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  isEmailAddress,
  normalizeEmail,
  normalizePhoneNumber,
  parseLoginIdentifier,
} from "@/lib/auth/phone";
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
}

const registrationValidationCodes = new Set([
  "email_address_invalid",
  "validation_failed",
  "weak_password",
]);

const duplicateRegistrationCodes = new Set([
  "email_exists",
  "phone_exists",
  "user_already_exists",
]);

const invalidCredentialCodes = new Set([
  "email_not_confirmed",
  "invalid_credentials",
  "user_banned",
  "user_not_found",
  "phone_not_confirmed",
]);

const expiredOtpCodes = new Set(["otp_expired", "token_expired"]);
const invalidOtpCodes = new Set([
  "invalid_otp",
  "invalid_token",
  "otp_disabled",
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

function mapOtpError(error: AuthError) {
  if (expiredOtpCodes.has(error.code ?? "")) {
    return new AuthServiceError(
      "expired-otp",
      "The verification code has expired.",
    );
  }
  if (invalidOtpCodes.has(error.code ?? "")) {
    return new AuthServiceError(
      "invalid-otp",
      "The verification code is invalid.",
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

  return {
    id: user.id,
    email: user.email ?? null,
    display_name:
      typeof displayName === "string" && displayName.trim()
        ? displayName.trim()
        : null,
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
      const email =
        typeof input.email === "string" && input.email.trim()
          ? normalizeEmail(input.email)
          : null;
      const phone =
        typeof input.phone === "string" && input.phone.trim()
          ? normalizePhoneNumber(input.phone)
          : null;

      if (!email && !phone) {
        throw new AuthServiceError(
          "registration-validation",
          "An email address or phone number is required.",
        );
      }
      if (email && !isEmailAddress(email)) {
        throw new AuthServiceError(
          "registration-validation",
          "The email address is invalid.",
        );
      }
      if (input.phone?.trim() && !phone) {
        throw new AuthServiceError(
          "phone-validation",
          "The phone number is invalid.",
        );
      }

      if (phone) {
        const { data, error } = await runProviderOperation(() =>
          supabase.auth.signUp({
            phone,
            password: input.password,
            options: {
              data: { display_name: input.displayName },
              channel: "sms",
            },
          }),
        );

        if (error) {
          if (duplicateRegistrationCodes.has(error.code ?? "")) {
            throw unexpectedAuthError();
          }
          if (registrationValidationCodes.has(error.code ?? "")) {
            throw mapRegistrationError(error);
          }
          throw unexpectedAuthError();
        }

        if (!data.user || data.user.identities?.length === 0) {
          throw unexpectedAuthError();
        }

        // Phone signup must remain pending until a real Supabase SMS OTP is verified.
        // A session at this point usually means Confirm phone is disabled in Dashboard.
        if (data.session) {
          await signOutQuietly();
          throw new AuthServiceError(
            "unexpected",
            "Phone confirmation must be enabled in Supabase Auth before phone signup can be used.",
          );
        }

        return {
          status: "phone-confirmation-required",
          phone,
          session: null,
        };
      }

      let emailRedirectTo: string;
      try {
        emailRedirectTo = getEmailConfirmationRedirectUrl();
      } catch {
        throw unexpectedAuthError();
      }

      const { data, error } = await runProviderOperation(() =>
        supabase.auth.signUp({
          email: email!,
          password: input.password,
          options: {
            data: { display_name: input.displayName },
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

      // A confirmed account may be returned as an obfuscated user. Never mistake it
      // for a newly created pending identity.
      if (!data.user || data.user.identities?.length === 0) {
        throw unexpectedAuthError();
      }

      if (!data.session) {
        return { status: "email-confirmation-required", session: null };
      }

      return { status: "authenticated", session: mapSession(data.session) };
    },

    async verifyPhoneSignup(request) {
      const phone = normalizePhoneNumber(request.phone);
      const token = request.token.trim();
      if (!phone)
        throw new AuthServiceError(
          "phone-validation",
          "The phone number is invalid.",
        );
      if (!/^\d{4,8}$/.test(token)) {
        throw new AuthServiceError(
          "invalid-otp",
          "The verification code is invalid.",
        );
      }

      const { data, error } = await runProviderOperation(() =>
        supabase.auth.verifyOtp({ phone, token, type: "sms" }),
      );
      if (error) throw mapOtpError(error);
      if (!data.session || !data.user || !data.user.phone_confirmed_at) {
        await signOutQuietly();
        throw unexpectedAuthError();
      }
      return mapSession(data.session);
    },

    async resendPhoneSignupConfirmation(request) {
      const phone = normalizePhoneNumber(request.phone);
      if (!phone)
        throw new AuthServiceError(
          "phone-validation",
          "The phone number is invalid.",
        );
      const { error } = await runProviderOperation(() =>
        supabase.auth.resend({ type: "sms", phone }),
      );
      if (error) throw unexpectedAuthError();
    },

    async addEmailToCurrentUser(request) {
      const email = normalizeEmail(request.email);
      if (!isEmailAddress(email)) {
        throw new AuthServiceError(
          "registration-validation",
          "The email address is invalid.",
        );
      }

      const { data: userData, error: userError } = await runProviderOperation(
        () => supabase.auth.getUser(),
      );
      const user = userData.user;
      if (userError || !user || !user.phone || !user.phone_confirmed_at) {
        throw new AuthServiceError(
          "invalid-recovery-context",
          "A verified phone session is required to add an email address.",
        );
      }

      let emailRedirectTo: string;
      try {
        emailRedirectTo = getEmailConfirmationRedirectUrl();
      } catch {
        throw unexpectedAuthError();
      }

      const { error } = await runProviderOperation(() =>
        supabase.auth.updateUser({ email }, { emailRedirectTo }),
      );
      if (error) {
        if (duplicateRegistrationCodes.has(error.code ?? "")) {
          throw unexpectedAuthError();
        }
        throw mapRegistrationError(error);
      }
    },

    async signIn(request) {
      const identifier =
        typeof request.identifier === "string"
          ? request.identifier
          : typeof request.email === "string"
            ? request.email
            : "";
      const parsed = parseLoginIdentifier(identifier);
      if (!parsed) {
        throw new AuthServiceError(
          "invalid-credentials",
          "The supplied credentials were rejected.",
        );
      }

      const credentials =
        parsed.kind === "email"
          ? { email: parsed.value, password: request.password }
          : { phone: parsed.value, password: request.password };

      const { data, error } = await runProviderOperation(() =>
        supabase.auth.signInWithPassword(credentials),
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

      const scopes = provider === "facebook" ? "email" : "openid email profile";
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

    async requestPhonePasswordReset(request) {
      const phone = normalizePhoneNumber(request.phone);
      if (!phone)
        throw new AuthServiceError(
          "phone-validation",
          "The phone number is invalid.",
        );

      const { error } = await runProviderOperation(() =>
        supabase.auth.signInWithOtp({
          phone,
          options: { shouldCreateUser: false, channel: "sms" },
        }),
      );
      if (error) throw unexpectedAuthError();
    },

    async resendPhonePasswordReset(request) {
      const phone = normalizePhoneNumber(request.phone);
      if (!phone) {
        throw new AuthServiceError(
          "phone-validation",
          "The phone number is invalid.",
        );
      }

      // Auth owns delivery limits; this request cannot create a user.
      const { error } = await runProviderOperation(() =>
        supabase.auth.signInWithOtp({
          phone,
          options: { shouldCreateUser: false, channel: "sms" },
        }),
      );
      if (error) throw unexpectedAuthError();
    },

    async resetPasswordByPhone(request) {
      const phone = normalizePhoneNumber(request.phone);
      const token = request.token.trim();
      if (!phone)
        throw new AuthServiceError(
          "phone-validation",
          "The phone number is invalid.",
        );
      if (!/^\d{4,8}$/.test(token)) {
        throw new AuthServiceError(
          "invalid-otp",
          "The verification code is invalid.",
        );
      }
      if (request.newPassword.length < 8) {
        throw new AuthServiceError(
          "registration-validation",
          "The new password is too short.",
        );
      }

      const { data, error } = await runProviderOperation(() =>
        supabase.auth.verifyOtp({ phone, token, type: "sms" }),
      );
      if (error) throw mapOtpError(error);
      if (
        !data.session ||
        !data.user ||
        normalizePhoneNumber(data.user.phone ?? "") !== phone ||
        !data.user.phone_confirmed_at
      ) {
        await signOutQuietly();
        throw invalidRecoveryContextError();
      }

      const { error: updateError } = await runProviderOperation(() =>
        supabase.auth.updateUser({ password: request.newPassword }),
      );
      if (updateError) {
        await signOutQuietly();
        throw mapRecoveryError(updateError);
      }
      await signOutQuietly();
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
