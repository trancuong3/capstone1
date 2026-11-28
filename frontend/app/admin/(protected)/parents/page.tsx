import type { Metadata } from "next";
import { AdminParentsScreen } from "@/components/admin/admin-parents-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
      locale,
      "admin.routes.parentsTitle",
    ),
  };
}

export default function Page() {
  return <AdminParentsScreen />;
}
