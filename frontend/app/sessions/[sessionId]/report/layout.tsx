import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { AppShell } from "@/components/layout/app-shell";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import { requireAppRole } from "@/lib/auth/server-authorization";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "reports.sessions.readingReports.pageHeading",
    ),
  };
}

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
