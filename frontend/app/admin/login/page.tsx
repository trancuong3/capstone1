import type { Metadata } from "next";
import { AdminLoginScreen } from "@/components/admin/admin-login-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";
import { resolveAdminAuthRuntime } from "@/lib/utils/admin-scenario";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
      locale,
      "admin.routes.loginTitle",
    ),
  };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string | string[];
    state?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const { mode, scenario } = resolveAdminAuthRuntime(query.state);
  const nextPath = Array.isArray(query.next) ? query.next[0] : query.next;

  return (
    <AdminServicesProvider authMode={mode} scenario={scenario}>
      <AdminLoginScreen nextPath={nextPath ?? null} scenario={scenario} />
    </AdminServicesProvider>
  );
}
