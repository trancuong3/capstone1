import type { Metadata } from "next";
import { AdminAuditScreen } from "@/components/admin/admin-audit-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
      locale,
      "admin.routes.auditLogsTitle",
    ),
  };
}

export default function Page() {
  return <AdminAuditScreen />;
}
