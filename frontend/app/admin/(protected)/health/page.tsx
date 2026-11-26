import type { Metadata } from "next";
import { AdminHealthScreen } from "@/components/admin/admin-health-screen";
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
      "admin.routes.healthTitle",
    ),
  };
}
export default function Page() {
  return (
    <AdminServicesProvider>
      <AdminHealthScreen />
    </AdminServicesProvider>
  );
}
