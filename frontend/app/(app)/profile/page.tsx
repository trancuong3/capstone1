import type { Metadata } from "next";

import { ParentProfileScreen } from "@/components/profile/parent-profile-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { parseAppMockScenario } from "@/lib/utils/ui-scenario";

export const metadata: Metadata = {
  title: "Hồ sơ ba mẹ",
};

interface ProfilePageProps {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  const scenario = parseAppMockScenario((await searchParams).state);

  return (
    <AppServicesProvider scenario={scenario}>
      <ParentProfileScreen />
    </AppServicesProvider>
  );
}
