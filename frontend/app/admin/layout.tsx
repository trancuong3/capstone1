import type { ReactNode } from "react";
import { AdminLayout } from "@/components/admin/admin-layout";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { AdminStoreProvider } from "@/components/providers/admin-store-provider";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AdminStoreProvider>
      <AdminServicesProvider>
        <AdminLayout>{children}</AdminLayout>
      </AdminServicesProvider>
    </AdminStoreProvider>
  );
}
