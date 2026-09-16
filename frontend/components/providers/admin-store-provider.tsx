"use client";

import { createContext, useState, type ReactNode } from "react";
import {
  createMockAdminStore,
  type MockAdminStore,
} from "@/lib/mock/mock-admin-store";

export const AdminStoreContext = createContext<MockAdminStore | null>(null);

export function AdminStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createMockAdminStore);
  return (
    <AdminStoreContext.Provider value={store}>
      {children}
    </AdminStoreContext.Provider>
  );
}
