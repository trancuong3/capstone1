import type { Metadata } from "next";

import { AdminParentDetailScreen } from "@/components/admin/admin-parent-detail-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
      locale,
      "admin.routes.parentDetailTitle",
    ),
  };
}

export default async function Page({
  params,
}: {
  params: Promise<{ parentId: string }>;
}) {
  const { parentId } = await params;
  return <AdminParentDetailScreen parentId={parentId} />;
}
