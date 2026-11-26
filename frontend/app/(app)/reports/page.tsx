import type { Metadata } from "next";

import { ProgressReportScreen } from "@/components/reports/progress-report-screen";
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
      "reports.overview.pageTitle",
    ),
  };
}

interface ReportsPageProps {
  readonly searchParams: Promise<{
    childId?: string | string[];
    period_start?: string | string[];
    period_end?: string | string[];
  }>;
}

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const query = await searchParams;
  return (
    <ProgressReportScreen
      requestedChildId={firstQueryValue(query.childId)}
      requestedPeriodStart={query.period_start}
      requestedPeriodEnd={query.period_end}
    />
  );
}
