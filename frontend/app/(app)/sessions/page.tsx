import type { Metadata } from "next";

import { SessionHistoryScreen } from "@/components/reports/session-history-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { historyPageFromCursor } from "@/lib/utils/report-mappers";
import { firstQueryValue } from "@/lib/utils/report-state";
import { viMessages } from "@/messages/vi";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "reports.sessions.title",
    ),
  };
}

interface SessionsPageProps {
  readonly searchParams: Promise<{
    childId?: string | string[];
    page?: string | string[];
  }>;
}

export default async function SessionsPage({
  searchParams,
}: SessionsPageProps) {
  const query = await searchParams;
  return (
    <SessionHistoryScreen
      page={
        historyPageFromCursor(`page-${firstQueryValue(query.page) ?? "1"}`) ?? 1
      }
      requestedChildId={firstQueryValue(query.childId)}
    />
  );
}
