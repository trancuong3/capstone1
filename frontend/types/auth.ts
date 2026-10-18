import type { ParentRole, UUID } from "@/types/profile";

export type LoginRequest =
  | { identifier: string; email?: never; password: string }
  // Kept for service consumers during migration; the UI uses identifier.
  | { email: string; identifier?: never; password: string };

export interface ParentRegistrationInput {
  displayName: string;
  email?: string;
  phone?: string;
  password: string;
}

export interface PasswordRecoveryRequest {
  email: string;
}

export interface PasswordResetRequest {
  newPassword: string;
}

export interface PhoneOtpRequest {
  phone: string;
}

export interface PhoneOtpVerificationRequest extends PhoneOtpRequest {
  token: string;
}

export interface EmailLinkRequest {
  email: string;
}

export interface PhonePasswordResetRequest extends PhoneOtpVerificationRequest {
  newPassword: string;
}

export interface AuthUserSnapshot {
  readonly id: UUID;
  readonly email: string | null;
  readonly display_name: string | null;
}

export interface AuthSessionSnapshot {
  readonly user: AuthUserSnapshot;
  readonly expires_at: number | null;
}

export type ParentRegistrationResult =
  | {
      readonly status: "authenticated";
      readonly session: AuthSessionSnapshot;
    }
  | {
      readonly status: "email-confirmation-required";
      readonly session: null;
    }
  | {
      readonly status: "phone-confirmation-required";
      readonly phone: string;
      readonly session: null;
    };

export type AuthStateEvent =
  | "INITIAL_SESSION"
  | "PASSWORD_RECOVERY"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "MFA_CHALLENGE_VERIFIED";

export type AuthStateChangeListener = (
  event: AuthStateEvent,
  session: AuthSessionSnapshot | null,
) => void;

export type CurrentUserRole = ParentRole | null;

export type AuthServiceMode = "mock" | "supabase";

export type AuthMockScenario =
  | "default"
  | "loading"
  | "email-used"
  | "validation-error"
  | "invalid-credentials"
  | "safe-error"
  | "submitted"
  | "invalid-token"
  | "expired-token"
  | "success";
