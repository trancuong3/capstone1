import type {
  LoginRequest,
  ParentRegistrationInput,
  PasswordRecoveryRequest,
  PasswordResetRequest,
} from "@/types/auth";

export type AuthFailureReason =
  | "email-already-used"
  | "registration-validation"
  | "invalid-credentials"
  | "invalid-recovery-context"
  | "expired-recovery-context"
  | "unexpected";

export class AuthServiceError extends Error {
  constructor(
    public readonly reason: AuthFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export interface AuthService {
  registerParent(input: ParentRegistrationInput): Promise<void>;
  signIn(request: LoginRequest): Promise<void>;
  requestPasswordReset(request: PasswordRecoveryRequest): Promise<void>;
  resetPassword(request: PasswordResetRequest): Promise<void>;
}
