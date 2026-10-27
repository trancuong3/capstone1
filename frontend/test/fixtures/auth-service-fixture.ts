import { createElement, type ReactNode } from "react";
import { vi } from "vitest";
import {
  AuthRuntimeContext,
  AuthServiceContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import type { AuthService } from "@/lib/api/auth-service";
import type { AuthSessionSnapshot } from "@/types/auth";

// Test-only responses, never selected by the application provider.
export const authSessionFixture: AuthSessionSnapshot = {
  expires_at: null,
  user: {
    id: "10000000-0000-4000-8000-000000000001",
    email: "parent@example.com",
    display_name: "Test Parent",
  },
};

export function createAuthServiceFixture() {
  return {
    initialize: vi.fn<AuthService["initialize"]>().mockResolvedValue(undefined),
    registerParent: vi.fn<AuthService["registerParent"]>().mockResolvedValue({
      status: "authenticated",
      session: authSessionFixture,
    }),
    signIn: vi
      .fn<AuthService["signIn"]>()
      .mockResolvedValue(authSessionFixture),
    signInWithOAuth: vi
      .fn<AuthService["signInWithOAuth"]>()
      .mockResolvedValue(undefined),
    requestPasswordReset: vi
      .fn<AuthService["requestPasswordReset"]>()
      .mockResolvedValue(undefined),
    resetPassword: vi
      .fn<AuthService["resetPassword"]>()
      .mockResolvedValue(undefined),
    getSession: vi
      .fn<AuthService["getSession"]>()
      .mockResolvedValue(authSessionFixture),
    getCurrentUser: vi
      .fn<AuthService["getCurrentUser"]>()
      .mockResolvedValue(authSessionFixture.user),
    getCurrentRole: vi
      .fn<AuthService["getCurrentRole"]>()
      .mockResolvedValue("parent"),
    signOut: vi.fn<AuthService["signOut"]>().mockResolvedValue(undefined),
    onAuthStateChange: vi
      .fn<AuthService["onAuthStateChange"]>()
      .mockReturnValue(vi.fn()),
  } satisfies AuthService;
}

export function withAuthFixture(
  children: ReactNode,
  service: AuthService,
  runtime: Partial<AuthRuntimeState> = {},
) {
  const value: AuthRuntimeState = {
    initializationFailure: null,
    isPasswordRecovery: false,
    lastEvent: null,
    mode: "supabase",
    session: null,
    status: "ready",
    ...runtime,
  };
  return createElement(
    AuthRuntimeContext.Provider,
    { value },
    createElement(AuthServiceContext.Provider, { value: service }, children),
  );
}
