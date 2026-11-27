"use client";

import {
  createContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  AuthServiceError,
  type AuthFailureReason,
  type AuthService,
} from "@/lib/api/auth-service";
import { dispatchI18nAuthSync } from "@/components/i18n/i18n-provider";
import { clearPrivateMediaMemoryCache } from "@/lib/api/api-client";
import {
  broadcastActorSwitch,
  clearGlobalTasksMemoryCache,
} from "@/lib/api/global-tasks-service";
import { resetApiReadCacheForActorSwitch } from "@/lib/api/read-cache";
import { clearStoredScanJobIds } from "@/lib/cache/scan-job-storage";
import { clearPersistedSelectedChild } from "@/lib/cache/selected-child-storage";
import { clearUserCache } from "@/lib/cache/user-query-cache";
import { createSupabaseAuthService } from "@/lib/supabase/auth-service";
import type { AuthSessionSnapshot, AuthStateEvent } from "@/types/auth";

export const AuthServiceContext = createContext<AuthService | null>(null);

export interface AuthRuntimeState {
  hasProvider?: boolean;
  initialUserId?: string | null;
  initializationFailure: AuthFailureReason | null;
  isPasswordRecovery: boolean;
  lastEvent: AuthStateEvent | null;
  mode: "supabase";
  session: AuthSessionSnapshot | null;
  status: "initializing" | "ready" | "error";
}

const defaultAuthRuntimeState: AuthRuntimeState = {
  hasProvider: false,
  initialUserId: null,
  initializationFailure: null,
  isPasswordRecovery: false,
  lastEvent: null,
  mode: "supabase",
  session: null,
  status: "initializing",
};

export const AuthRuntimeContext = createContext<AuthRuntimeState>(
  defaultAuthRuntimeState,
);

interface AuthServiceProviderProps {
  children: ReactNode;
  initialUserId?: string | null;

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
  initialUserId = null,
}: AuthServiceProviderProps) {
  const service = useMemo<AuthService>(() => createSupabaseAuthService(), []);
  const lastUserIdRef = useRef<string | null>(initialUserId);

  const [runtime, setRuntime] = useState<AuthRuntimeState>(() => ({
    ...defaultAuthRuntimeState,
    hasProvider: true,
    initialUserId,
    mode: "supabase",
    status: "initializing",
  }));

  useEffect(() => {
    let isActive = true;

    const unsubscribe = service.onAuthStateChange((event, session) => {
      if (!isActive) return;

      const nextUserId = session?.user?.id ?? null;
      if (event === "SIGNED_OUT" || !nextUserId) {
        const hadPreviousUser = lastUserIdRef.current !== null;
        clearUserCache();
        clearPersistedSelectedChild();
        clearStoredScanJobIds();
        clearGlobalTasksMemoryCache();
        clearPrivateMediaMemoryCache();
        resetApiReadCacheForActorSwitch();
        if (hadPreviousUser || event === "SIGNED_OUT") {
          broadcastActorSwitch();
        }
        lastUserIdRef.current = null;
        if (event === "SIGNED_OUT") {
          dispatchI18nAuthSync({ userId: null, preferredLocale: null });
        }
      } else if (
        lastUserIdRef.current &&
        lastUserIdRef.current !== nextUserId
      ) {
        clearUserCache(lastUserIdRef.current);
        clearPersistedSelectedChild(nextUserId);
        clearStoredScanJobIds(nextUserId);
        clearGlobalTasksMemoryCache();
        clearPrivateMediaMemoryCache();
        resetApiReadCacheForActorSwitch();
        broadcastActorSwitch();
        lastUserIdRef.current = nextUserId;
      } else {
        lastUserIdRef.current = nextUserId;
      }

      setRuntime((current) => ({
        ...current,
        initialUserId: nextUserId,

        isPasswordRecovery:
          event === "PASSWORD_RECOVERY"
            ? Boolean(session)
            : event === "SIGNED_IN" || event === "SIGNED_OUT"
              ? false
              : current.isPasswordRecovery,

        lastEvent: event,
        mode: "supabase",
        session,
      }));
    });

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
            error instanceof AuthServiceError ? error.reason : "unexpected",
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
