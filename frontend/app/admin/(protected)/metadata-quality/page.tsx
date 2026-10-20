import type { Metadata } from "next";

import { AdminMetadataQualityScreen } from "@/components/admin/admin-metadata-quality-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";

export const metadata: Metadata = { title: "Chất lượng metadata sách" };

export default function Page() {
  return (
    <AdminServicesProvider>
      <AdminMetadataQualityScreen />
    </AdminServicesProvider>
  );
}
