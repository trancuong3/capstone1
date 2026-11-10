import type { Metadata } from "next";

import { ReadingManagementScreen } from "@/components/reading-management/reading-management-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

export const metadata: Metadata = { title: "Quản lý đọc sách" };

export default function ReadingManagementPage() {
  return (
    <AppServicesProvider>
      <ReadingManagementScreen />
    </AppServicesProvider>
  );
}
