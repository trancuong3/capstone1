import type { Metadata } from "next";

import { ChildProfileScreen } from "@/components/children/child-profile-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { parseAppMockScenario } from "@/lib/utils/ui-scenario";

export const metadata: Metadata = {
  title: "Tạo hồ sơ bé",
};

interface NewChildPageProps {
  searchParams: Promise<{
    from?: string | string[];
    state?: string | string[];
  }>;
}

export default async function NewChildPage({
  searchParams,
}: NewChildPageProps) {
  const query = await searchParams;
  const from = Array.isArray(query.from) ? query.from[0] : query.from;
  const scenario = parseAppMockScenario(query.state);

  return (
    <AppServicesProvider scenario={scenario}>
      <ChildProfileScreen
        fromRegistration={from === "register"}
        mode="create"
      />
    </AppServicesProvider>
  );
}
