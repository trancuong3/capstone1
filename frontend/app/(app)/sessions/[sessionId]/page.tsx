import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SessionDetailScreen } from "@/components/reports/session-detail-screen";

export const metadata: Metadata = { title: "Chi tiết buổi đọc" };

interface SessionDetailPageProps {
  readonly params: Promise<{ sessionId: string }>;
}

export default async function SessionDetailPage({
  params,
}: SessionDetailPageProps) {
  const { sessionId } = await params;
  return (
    <AppServicesProvider>
      <SessionDetailScreen sessionId={sessionId} />
    </AppServicesProvider>
  );
}
