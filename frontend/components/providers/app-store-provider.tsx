"use client";

import { createContext, useState, type ReactNode } from "react";

import {
  createMockAppStore,
  type MockAppStore,
} from "@/lib/mock/mock-app-store";

export const AppStoreContext = createContext<MockAppStore | null>(null);

interface AppStoreProviderProps {
  children: ReactNode;
  initialStore?: MockAppStore;
}

export function AppStoreProvider({
  children,
  initialStore,
}: AppStoreProviderProps) {
  const [store] = useState(() => initialStore ?? createMockAppStore());

  return (
    <AppStoreContext.Provider value={store}>
      {children}
    </AppStoreContext.Provider>
  );
}
