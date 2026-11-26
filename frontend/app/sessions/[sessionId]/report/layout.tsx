import type { ReactNode } from "react";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { AppShell } from "@/components/layout/app-shell";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import { requireAppRole } from "@/lib/auth/server-authorization";

export default async function SessionReportLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const identity = await requireAppRole("parent");
  return (
    <AuthServiceProvider
      initialUserId={identity.id}
      mode="supabase"
      scenario="default"
    >
      <AppServicesProvider>
        <AppStoreProvider>
          <AppShell>{children}</AppShell>
        </AppStoreProvider>
      </AppServicesProvider>
    </AuthServiceProvider>
  );
}
