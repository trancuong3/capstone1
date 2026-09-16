import type { AdminLoginRequest, AdminSessionUI } from "@/types/admin";

export type AdminAuthFailureReason =
  "invalid-credentials" | "forbidden" | "safe-error";

export class AdminAuthError extends Error {
  constructor(readonly reason: AdminAuthFailureReason) {
    super("Admin authentication failed");
    this.name = "AdminAuthError";
  }
}

export function isAdminAuthError(error: unknown): error is AdminAuthError {
  return error instanceof AdminAuthError;
}

export interface AdminAuthService {
  signIn(request: AdminLoginRequest): Promise<AdminSessionUI>;
  signOut(): Promise<void>;
}
