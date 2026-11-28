import type { Metadata } from "next";

import { AdminQualityHubScreen } from "@/components/admin/admin-quality-hub-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";
import { parseQualityHubTab } from "@/lib/utils/quality-hub-tab";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
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
