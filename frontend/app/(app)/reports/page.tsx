import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { ProgressReportScreen } from "@/components/reports/progress-report-screen";
import {
  firstQueryValue,
  parseGroup5DemoState,
} from "@/lib/utils/report-state";

export const metadata: Metadata = { title: "Báo cáo tiến bộ" };

interface ReportsPageProps {
  readonly searchParams: Promise<{
    childId?: string | string[];
    state?: string | string[];
  }>;
}

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const query = await searchParams;
  return (
    <AppServicesProvider
      reportScenario={parseGroup5DemoState(query.state)}
      scenario="default"
    >
      <ProgressReportScreen requestedChildId={firstQueryValue(query.childId)} />
    </AppServicesProvider>
  );
}
