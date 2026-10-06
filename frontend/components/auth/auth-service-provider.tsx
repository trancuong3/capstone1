"use client";

import {
  createContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  AuthServiceError,
  type AuthFailureReason,
  type AuthService,
} from "@/lib/api/auth-service";
import { createMockAuthService } from "@/lib/mock/mock-auth-service";
import { createSupabaseAuthService } from "@/lib/supabase/auth-service";
import type {
  AuthMockScenario,
  AuthServiceMode,
  AuthSessionSnapshot,
  AuthStateEvent,
} from "@/types/auth";

export const AuthServiceContext = createContext<AuthService | null>(null);

export interface AuthRuntimeState {
  initializationFailure: AuthFailureReason | null;
  isPasswordRecovery: boolean;
  lastEvent: AuthStateEvent | null;
  mode: AuthServiceMode;
  session: AuthSessionSnapshot | null;
  status: "initializing" | "ready" | "error";
}

const defaultAuthRuntimeState: AuthRuntimeState = {
  initializationFailure: null,
  isPasswordRecovery: false,
  lastEvent: null,
  mode: "mock",
  session: null,
  status: "ready",
};

export const AuthRuntimeContext = createContext<AuthRuntimeState>(
  defaultAuthRuntimeState,
);

interface AuthServiceProviderProps {
  children: ReactNode;
  mode: AuthServiceMode;
  scenario: AuthMockScenario;
}

export function AuthServiceProvider({
  children,
  mode,
  scenario,
}: AuthServiceProviderProps) {
  const service = useMemo(
    () =>
      mode === "supabase"
        ? createSupabaseAuthService()
        : createMockAuthService(scenario),
    [mode, scenario],
  );
  const [runtime, setRuntime] = useState<AuthRuntimeState>(() => ({
    ...defaultAuthRuntimeState,
    mode,
    status: mode === "mock" ? "ready" : "initializing",
  }));

  useEffect(() => {
    let isActive = true;

    const unsubscribe = service.onAuthStateChange((event, session) => {
      if (!isActive) return;

      setRuntime((current) => ({
        ...current,
        isPasswordRecovery:
          event === "PASSWORD_RECOVERY"
            ? Boolean(session)
            : event === "SIGNED_IN" || event === "SIGNED_OUT"
              ? false
              : current.isPasswordRecovery,
        lastEvent: event,
        mode,
        session,
      }));
    });

    void service
      .initialize()
      .then(() => {
        if (!isActive) return;
        setRuntime((current) => ({ ...current, mode, status: "ready" }));
      })
      .catch((error: unknown) => {
        if (!isActive) return;
        setRuntime((current) => ({
          ...current,
          initializationFailure:
            error instanceof AuthServiceError ? error.reason : "unexpected",
          mode,
          status: "error",
        }));
      });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [mode, service]);

  return (
    <AuthRuntimeContext.Provider value={runtime}>
      <AuthServiceContext.Provider value={service}>
        {children}
      </AuthServiceContext.Provider>
    </AuthRuntimeContext.Provider>
  );
}
