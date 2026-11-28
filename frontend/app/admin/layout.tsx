import type { ReactNode } from "react";
import { AdminI18nProvider } from "@/components/i18n/admin-i18n-provider";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";
import { getServerAdminI18n } from "@/lib/i18n/server";

export default async function Layout({ children }: { children: ReactNode }) {
  const { locale, adminMessages, viAdminMessages } = await getServerAdminI18n();

  return (
    <AdminI18nProvider
      initialAdminMessages={adminMessages}
      initialLocale={locale}
      viAdminMessages={viAdminMessages}
    >
      <AdminServicesProvider>
        <AiTaskCenterProvider
          actorRole="admin"
          autoSyncOnMount={false}
          resolveSessionActor
        >
          {children}
        </AiTaskCenterProvider>
      </AdminServicesProvider>
    </AdminI18nProvider>
  );
}
