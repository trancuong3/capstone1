import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SessionDetailScreen } from "@/components/reports/session-detail-screen";
import { firstQueryValue } from "@/lib/utils/report-state";
import { historyPageFromCursor } from "@/lib/utils/report-mappers";

export const metadata: Metadata = { title: "Chi tiết buổi đọc" };

interface SessionDetailPageProps {
  readonly params: Promise<{ sessionId: string }>;
  readonly searchParams: Promise<{
    page?: string | string[];
  }>;
}

export default async function SessionDetailPage({
  params,
  searchParams,
}: SessionDetailPageProps) {
  const { sessionId } = await params;
  const query = await searchParams;
  return (
    <AppServicesProvider>
      <SessionDetailScreen
        sessionId={sessionId}
        page={
          historyPageFromCursor(`page-${firstQueryValue(query.page) ?? "1"}`) ??
          1
        }
      />
    </AppServicesProvider>
  );
}
