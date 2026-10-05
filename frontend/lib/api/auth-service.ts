import type {
  AuthSessionSnapshot,
  AuthStateChangeListener,
  AuthUserSnapshot,
  CurrentUserRole,
  LoginRequest,
  ParentRegistrationInput,
  ParentRegistrationResult,
  PasswordRecoveryRequest,
  PasswordResetRequest,
} from "@/types/auth";

export type AuthFailureReason =
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
  initialize(): Promise<void>;
  registerParent(
    input: ParentRegistrationInput,
  ): Promise<ParentRegistrationResult>;
  signIn(request: LoginRequest): Promise<AuthSessionSnapshot>;
  requestPasswordReset(request: PasswordRecoveryRequest): Promise<void>;
  resetPassword(request: PasswordResetRequest): Promise<void>;
  getSession(): Promise<AuthSessionSnapshot | null>;
  getCurrentUser(): Promise<AuthUserSnapshot | null>;
  getCurrentRole(): Promise<CurrentUserRole>;
  signOut(): Promise<void>;
  onAuthStateChange(listener: AuthStateChangeListener): () => void;
}
