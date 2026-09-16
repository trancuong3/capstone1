import type { Metadata } from "next";
import { AdminHealthScreen } from "@/components/admin/admin-health-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { parseAdminScenario } from "@/lib/utils/admin-scenario";
export const metadata: Metadata = { title: "Tình trạng vận hành" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const query = await searchParams;
  return (
    <AdminServicesProvider scenario={parseAdminScenario(query.state)}>
      <AdminHealthScreen />
    </AdminServicesProvider>
  );
}
