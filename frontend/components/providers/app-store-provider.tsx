"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { clearApiReadCache } from "@/lib/api/read-cache";
import type { ChildProfileDTO } from "@/types/child";

export interface AppStore {
  selectedChildId: string | null;
  validatedSelectedChild: ChildProfileDTO | null;
  selectChild(childId: string): void;
  clearSelectedChild(): void;
  setValidatedSelectedChild(child: ChildProfileDTO): void;
}

export const AppStoreContext = createContext<AppStore | null>(null);

interface AppStoreProviderProps {
  children: ReactNode;
}

export function AppStoreProvider({ children }: AppStoreProviderProps) {
  const [selection, setSelection] = useState<{
    childId: string | null;
    child: ChildProfileDTO | null;
  }>({ childId: null, child: null });

  const selectChild = useCallback((childId: string) => {
    if (!childId) return;
    setSelection((current) => {
      if (current.childId === childId) return current;
      clearApiReadCache();
      return { childId, child: null };
    });
  }, []);

  const clearSelectedChild = useCallback(() => {
    clearApiReadCache();
    setSelection({ childId: null, child: null });
  }, []);

  const setValidatedSelectedChild = useCallback((child: ChildProfileDTO) => {
    setSelection((current) =>
      current.childId === child.id ? { ...current, child } : current,
    );
  }, []);

  const value = useMemo<AppStore>(
    () => ({
      selectedChildId: selection.childId,
      validatedSelectedChild: selection.child,
      selectChild,
      clearSelectedChild,
      setValidatedSelectedChild,
    }),
    [
      clearSelectedChild,
      selectChild,
      selection.child,
      selection.childId,
      setValidatedSelectedChild,
    ],
  );

  return (
    <AppStoreContext.Provider value={value}>
      {children}
    </AppStoreContext.Provider>
  );
}

export function useAppStore(): AppStore {
  const store = useContext(AppStoreContext);
  if (!store) {
    throw new Error("useAppStore must be used inside AppStoreProvider.");
  }
  return store;
}
