import type { Metadata } from "next";
import { DynamicAdminVireadTrainingScreen } from "@/components/admin/admin-dynamic-screens";
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
      "admin.routes.vireadTrainingTitle",
      undefined,
      "Huấn luyện OCR",
    ),
  };
}

export default function AdminVireadTrainingPage() {
  return <DynamicAdminVireadTrainingScreen />;
}
