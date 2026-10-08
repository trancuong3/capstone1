import type { Metadata } from "next";

import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

export const metadata: Metadata = {
  title: "Tổng quan",
};

export default function DashboardPage() {
  return (
    <AppServicesProvider>
      <DashboardScreen />
    </AppServicesProvider>
  );
}