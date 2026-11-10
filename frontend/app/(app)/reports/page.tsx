import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { ProgressReportScreen } from "@/components/reports/progress-report-screen";

export const metadata: Metadata = { title: "Báo cáo tiến bộ" };

interface ReportsPageProps {
  readonly searchParams: Promise<{
    period_start?: string | string[];
    period_end?: string | string[];
  }>;
}

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const query = await searchParams;
  return (
    <AppServicesProvider>
      <ProgressReportScreen
        requestedPeriodStart={query.period_start}
        requestedPeriodEnd={query.period_end}
      />
    </AppServicesProvider>
  );
}
