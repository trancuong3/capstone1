import type { Metadata } from "next";
import { AdminNewBookScreen } from "@/components/admin/admin-new-book-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
      locale,
      "admin.routes.newBookTitle",
    ),
  };
}

export default function Page() {
  return <AdminNewBookScreen />;
}
