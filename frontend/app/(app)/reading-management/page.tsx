import type { Metadata } from "next";

import { ReadingManagementScreen } from "@/components/reading-management/reading-management-screen";
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
      "reports.readingManagement.pageTitle",
    ),
  };
}

interface PageProps {
  searchParams: Promise<{ childId?: string | string[] }>;
}

export default async function ReadingManagementPage({
  searchParams,
}: PageProps) {
  const query = await searchParams;
  const childId = Array.isArray(query.childId)
    ? query.childId[0]
    : query.childId;
  return <ReadingManagementScreen requestedChildId={childId} />;
}
