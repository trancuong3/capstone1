import type { ReactNode } from "react";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { AdminStoreProvider } from "@/components/providers/admin-store-provider";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AdminStoreProvider>
      <AdminServicesProvider authMode="supabase">
        {children}
      </AdminServicesProvider>
    </AdminStoreProvider>
  );
}
