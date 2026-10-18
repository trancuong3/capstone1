import type {
  AuthSessionSnapshot,
  AuthStateChangeListener,
  AuthUserSnapshot,
  CurrentUserRole,
  EmailLinkRequest,
  LoginRequest,
  ParentRegistrationInput,
  ParentRegistrationResult,
  PasswordRecoveryRequest,
  PasswordResetRequest,
  PhoneOtpRequest,
  PhoneOtpVerificationRequest,
  PhonePasswordResetRequest,
} from "@/types/auth";

export type AuthFailureReason =
  | "registration-validation"
  | "invalid-credentials"
  | "invalid-otp"
  | "expired-otp"
  | "phone-validation"
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

export type OAuthProvider = "google" | "facebook";

export interface AuthService {
  initialize(): Promise<void>;
  registerParent(input: ParentRegistrationInput): Promise<ParentRegistrationResult>;
  verifyPhoneSignup(request: PhoneOtpVerificationRequest): Promise<AuthSessionSnapshot>;
  resendPhoneSignupConfirmation(request: PhoneOtpRequest): Promise<void>;
  addEmailToCurrentUser(request: EmailLinkRequest): Promise<void>;
  signIn(request: LoginRequest): Promise<AuthSessionSnapshot>;
  signInWithOAuth(provider: OAuthProvider): Promise<void>;
  requestPasswordReset(request: PasswordRecoveryRequest): Promise<void>;
  requestPhonePasswordReset(request: PhoneOtpRequest): Promise<void>;
  resendPhonePasswordReset(request: PhoneOtpRequest): Promise<void>;
  resetPasswordByPhone(request: PhonePasswordResetRequest): Promise<void>;
  resetPassword(request: PasswordResetRequest): Promise<void>;
  getSession(): Promise<AuthSessionSnapshot | null>;
  getCurrentUser(): Promise<AuthUserSnapshot | null>;
  getCurrentRole(): Promise<CurrentUserRole>;
  signOut(): Promise<void>;
  onAuthStateChange(listener: AuthStateChangeListener): () => void;
}
