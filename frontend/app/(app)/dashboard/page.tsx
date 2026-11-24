import type { Metadata } from "next";

import { DashboardScreen } from "@/components/dashboard/dashboard-screen";

export const metadata: Metadata = {
  title: "Tổng quan",
};

export default function DashboardPage() {
  return <DashboardScreen />;
}
