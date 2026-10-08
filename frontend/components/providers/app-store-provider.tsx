"use client";

import {
  createContext,
  type ReactNode,
} from "react";

export type AppStore = Record<string, never>;

export const AppStoreContext =
  createContext<AppStore | null>(null);

interface AppStoreProviderProps {
  children: ReactNode;
}

export function AppStoreProvider({
  children,
}: AppStoreProviderProps) {
  return (
    <AppStoreContext.Provider value={null}>
      {children}
    </AppStoreContext.Provider>
  );
}