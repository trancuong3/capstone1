import type { Metadata } from "next";

import { ChildrenListScreen } from "@/components/children/children-list-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { parseAppMockScenario } from "@/lib/utils/ui-scenario";

export const metadata: Metadata = {
  title: "Hồ sơ bé",
};

interface ChildrenPageProps {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function ChildrenPage({
  searchParams,
}: ChildrenPageProps) {
  const scenario = parseAppMockScenario((await searchParams).state);

  return (
    <AppServicesProvider scenario={scenario}>
      <ChildrenListScreen />
    </AppServicesProvider>
  );
}
