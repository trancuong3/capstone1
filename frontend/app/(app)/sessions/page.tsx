import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SessionHistoryScreen } from "@/components/reports/session-history-screen";
import { firstQueryValue } from "@/lib/utils/report-state";
import { historyPageFromCursor } from "@/lib/utils/report-mappers";

export const metadata: Metadata = { title: "Lịch sử đọc" };

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
    <AppServicesProvider>
      <SessionHistoryScreen
        page={
          historyPageFromCursor(`page-${firstQueryValue(query.page) ?? "1"}`) ??
          1
        }
        requestedChildId={firstQueryValue(query.childId)}
      />
    </AppServicesProvider>
  );
}
