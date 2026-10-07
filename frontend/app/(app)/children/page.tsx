import type { Metadata } from "next";

import { ChildrenListScreen } from "@/components/children/children-list-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

export const metadata: Metadata = {
  title: "Hồ sơ bé",
};

export default function ChildrenPage() {
  return (
    <AppServicesProvider>
      <ChildrenListScreen />
    </AppServicesProvider>
  );
}