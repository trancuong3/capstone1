import type { Metadata } from "next";

import { AchievementsScreen } from "@/components/achievements/achievements-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { firstQueryValue } from "@/lib/utils/report-state";
import { viMessages } from "@/messages/vi";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "phonemeGarden.pageTitle",
    ),
  };
}

interface AchievementsPageProps {
  readonly searchParams: Promise<{
    childId?: string | string[];
  }>;
}

export default async function AchievementsPage({
  searchParams,
}: AchievementsPageProps) {
  const query = await searchParams;
  return (
    <AchievementsScreen requestedChildId={firstQueryValue(query.childId)} />
  );
}
