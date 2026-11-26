import type { Metadata } from "next";

import { AdminQualityHubScreen } from "@/components/admin/admin-quality-hub-screen";
import { parseQualityHubTab } from "@/lib/admin/quality-hub-tab";
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
      "admin.routes.metadataQualityTitle",
    ),
  };
}

export default async function MetadataQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const query = await searchParams;
  const initialTab = parseQualityHubTab(query.tab);
  return <AdminQualityHubScreen initialTab={initialTab} />;
}
