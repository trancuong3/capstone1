import type { Metadata } from "next";
import { AdminAuditScreen } from "@/components/admin/admin-audit-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
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
      "admin.routes.auditLogsTitle",
    ),
  };
}
export default function Page() {
  return (
    <AdminServicesProvider>
      <AdminAuditScreen />
    </AdminServicesProvider>
  );
}
