import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { DevicePermissionScreen } from "@/components/reading/device-permission-screen";

export const metadata: Metadata = {
  title: "Xác minh camera và microphone",
};

interface DevicePermissionsPageProps {
  searchParams: Promise<{
    flow?: string | string[];
    childId?: string | string[];
    bookId?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DevicePermissionsPage({
  searchParams,
}: DevicePermissionsPageProps) {
  const query = await searchParams;

  return (
    <AppServicesProvider scenario="default">
      <DevicePermissionScreen
        flow={firstValue(query.flow)}
        childId={firstValue(query.childId)}
        bookId={firstValue(query.bookId)}
      />
    </AppServicesProvider>
  );
}
