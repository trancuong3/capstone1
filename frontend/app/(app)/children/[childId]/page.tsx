import type { Metadata } from "next";

import { ChildProfileScreen } from "@/components/children/child-profile-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { parseAppMockScenario } from "@/lib/utils/ui-scenario";

export const metadata: Metadata = {
  title: "Chi tiết hồ sơ bé",
};

interface ChildDetailsPageProps {
  params: Promise<{ childId: string }>;
  searchParams: Promise<{
    created?: string | string[];
    state?: string | string[];
  }>;
}

export default async function ChildDetailsPage({
  params,
  searchParams,
}: ChildDetailsPageProps) {
  const [{ childId }, query] = await Promise.all([params, searchParams]);
  const created = Array.isArray(query.created)
    ? query.created[0]
    : query.created;
  const scenario = parseAppMockScenario(query.state);

  return (
    <AppServicesProvider scenario={scenario}>
      <ChildProfileScreen
        childId={childId}
        hasCreatedNotice={created === "1"}
        mode="edit"
      />
    </AppServicesProvider>
  );
}
