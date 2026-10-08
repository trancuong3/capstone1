import type { Metadata } from "next";
import { AdminHealthScreen } from "@/components/admin/admin-health-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
export const metadata: Metadata = { title: "Tình trạng vận hành" };
export default function Page() {
  return (
    <AdminServicesProvider>
      <AdminHealthScreen />
    </AdminServicesProvider>
  );
}
