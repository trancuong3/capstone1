export interface LoginRequest {
  email: string;
  password: string;
}

export interface ParentRegistrationInput {
  displayName: string;
  email: string;
  password: string;
}

export interface PasswordRecoveryRequest {
  email: string;
}

export interface PasswordResetRequest {
  newPassword: string;
}

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
