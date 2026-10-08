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
import { createSupabaseAuthService } from "@/lib/supabase/auth-service";
import type {
  AuthSessionSnapshot,
  AuthStateEvent,
} from "@/types/auth";

export const AuthServiceContext =
  createContext<AuthService | null>(null);

export interface AuthRuntimeState {
  initializationFailure: AuthFailureReason | null;
  isPasswordRecovery: boolean;
  lastEvent: AuthStateEvent | null;
  mode: "supabase";
  session: AuthSessionSnapshot | null;
  status: "initializing" | "ready" | "error";
}

const defaultAuthRuntimeState: AuthRuntimeState = {
  initializationFailure: null,
  isPasswordRecovery: false,
  lastEvent: null,
  mode: "supabase",
  session: null,
  status: "initializing",
};

export const AuthRuntimeContext =
  createContext<AuthRuntimeState>(
    defaultAuthRuntimeState,
  );

interface AuthServiceProviderProps {
  children: ReactNode;

  /*
   * Giữ lại các props này để tương thích
   * với các page hiện tại của project.
   *
   * Auth hiện tại luôn sử dụng Supabase,
   * không sử dụng Mock Auth nữa.
   */
  mode: "mock" | "supabase";
  scenario: string;
}

export function AuthServiceProvider({
  children,
}: AuthServiceProviderProps) {
  const service = useMemo<AuthService>(
    () => createSupabaseAuthService(),
    [],
  );

  const [runtime, setRuntime] =
    useState<AuthRuntimeState>(() => ({
      ...defaultAuthRuntimeState,
      mode: "supabase",
      status: "initializing",
    }));

  useEffect(() => {
    let isActive = true;

    const unsubscribe =
      service.onAuthStateChange(
        (event, session) => {
          if (!isActive) return;

          setRuntime((current) => ({
            ...current,

            isPasswordRecovery:
              event === "PASSWORD_RECOVERY"
                ? Boolean(session)
                : event === "SIGNED_IN" ||
                    event === "SIGNED_OUT"
                  ? false
                  : current.isPasswordRecovery,

            lastEvent: event,
            mode: "supabase",
            session,
          }));
        },
      );

    void service
      .initialize()
      .then(() => {
        if (!isActive) return;

        setRuntime((current) => ({
          ...current,
          mode: "supabase",
          status: "ready",
        }));
      })
      .catch((error: unknown) => {
        if (!isActive) return;

        setRuntime((current) => ({
          ...current,
          initializationFailure:
            error instanceof AuthServiceError
              ? error.reason
              : "unexpected",
          mode: "supabase",
          status: "error",
        }));
      });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [service]);

  return (
    <AuthRuntimeContext.Provider value={runtime}>
      <AuthServiceContext.Provider value={service}>
        {children}
      </AuthServiceContext.Provider>
    </AuthRuntimeContext.Provider>
  );
}