"use client";

import { createContext, useMemo, type ReactNode } from "react";

import type { AuthService } from "@/lib/api/auth-service";
import { createMockAuthService } from "@/lib/mock/mock-auth-service";
import type { AuthMockScenario } from "@/types/auth";

export const AuthServiceContext = createContext<AuthService | null>(null);

interface AuthServiceProviderProps {
  children: ReactNode;
  scenario: AuthMockScenario;
}

export function AuthServiceProvider({
  children,
  scenario,
}: AuthServiceProviderProps) {
  const service = useMemo(() => createMockAuthService(scenario), [scenario]);

  return (
    <AuthServiceContext.Provider value={service}>
      {children}
    </AuthServiceContext.Provider>
  );
}
