"use client";

import { createContext, type ReactNode } from "react";

export const AdminStoreContext = createContext<null>(null);

export function AdminStoreProvider({ children }: { children: ReactNode }) {
  return (
    <AdminStoreContext.Provider value={null}>
      {children}
    </AdminStoreContext.Provider>
  );
}
