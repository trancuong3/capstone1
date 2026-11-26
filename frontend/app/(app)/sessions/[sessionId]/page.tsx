import type { Metadata } from "next";
import { z } from "zod";

import { SessionDetailScreen } from "@/components/reports/session-detail-screen";
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
      "reports.sessions.detailTitle",
    ),
  };
}

interface SessionDetailPageProps {
  readonly params: Promise<{ sessionId: string }>;
  readonly searchParams: Promise<{
    childId?: string | string[];
    page?: string | string[];
  }>;
}

export default async function SessionDetailPage({
  params,
  searchParams,
}: SessionDetailPageProps) {
  const { sessionId } = await params;
  const query = await searchParams;
  const childId = z.uuid().safeParse(firstQueryValue(query.childId));
  return (
    <SessionDetailScreen
      sessionId={sessionId}
      requestedChildId={childId.success ? childId.data : undefined}
      page={
        historyPageFromCursor(`page-${firstQueryValue(query.page) ?? "1"}`) ?? 1
      }
    />
  );
}
