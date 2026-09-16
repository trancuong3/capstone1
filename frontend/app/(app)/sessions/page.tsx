import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SessionHistoryScreen } from "@/components/reports/session-history-screen";
import {
  firstQueryValue,
  parseGroup5DemoState,
  parseHistoryPage,
} from "@/lib/utils/report-state";

export const metadata: Metadata = { title: "Lịch sử đọc" };

interface SessionsPageProps {
  readonly searchParams: Promise<{
    childId?: string | string[];
    page?: string | string[];
    state?: string | string[];
  }>;
}

export default async function SessionsPage({
  searchParams,
}: SessionsPageProps) {
  const query = await searchParams;
  const scenario = parseGroup5DemoState(query.state);
  return (
    <AppServicesProvider scenario="default" sessionScenario={scenario}>
      <SessionHistoryScreen
        page={parseHistoryPage(query.page)}
        requestedChildId={firstQueryValue(query.childId)}
      />
    </AppServicesProvider>
  );
}
