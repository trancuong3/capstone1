import type { Metadata } from "next";

import { DynamicAdminBookContentQualityScreen } from "@/components/admin/admin-dynamic-screens";
import { AdminMetadataQualityScreen } from "@/components/admin/admin-metadata-quality-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";

export const metadata: Metadata = {
  title: "Quản lý chất lượng sách",
};

export default function MetadataQualityPage() {
  return (
    <AdminServicesProvider>
      <AdminMetadataQualityScreen />
      <DynamicAdminBookContentQualityScreen />
    </AdminServicesProvider>
  );
}
