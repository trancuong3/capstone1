import type { Metadata } from "next";
import { DynamicAdminVireadTrainingScreen } from "@/components/admin/admin-dynamic-screens";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
      locale,
      "admin.routes.vireadTrainingTitle",
      undefined,
      "Huấn luyện OCR",
    ),
  };
}

export default function AdminVireadTrainingPage() {
  return <DynamicAdminVireadTrainingScreen />;
}
