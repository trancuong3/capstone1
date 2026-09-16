import type { Metadata } from "next";

import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { parseAppMockScenario } from "@/lib/utils/ui-scenario";

export const metadata: Metadata = {
  title: "Tổng quan",
};

interface DashboardPageProps {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps) {
  const scenario = parseAppMockScenario((await searchParams).state);

  return (
    <AppServicesProvider scenario={scenario}>
      <DashboardScreen />
    </AppServicesProvider>
  );
}
