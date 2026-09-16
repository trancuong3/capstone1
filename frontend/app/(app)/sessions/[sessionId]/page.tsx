import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SessionDetailScreen } from "@/components/reports/session-detail-screen";
import { parseGroup5DemoState } from "@/lib/utils/report-state";

export const metadata: Metadata = { title: "Chi tiết buổi đọc" };

interface SessionDetailPageProps {
  readonly params: Promise<{ sessionId: string }>;
  readonly searchParams: Promise<{ state?: string | string[] }>;
}

export default async function SessionDetailPage({
  params,
  searchParams,
}: SessionDetailPageProps) {
  const [{ sessionId }, query] = await Promise.all([params, searchParams]);
  return (
    <AppServicesProvider
      scenario="default"
      sessionScenario={parseGroup5DemoState(query.state)}
    >
      <SessionDetailScreen sessionId={sessionId} />
    </AppServicesProvider>
  );
}
