import type { Metadata } from "next";
import { AdminAuditScreen } from "@/components/admin/admin-audit-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { parseAdminScenario } from "@/lib/utils/admin-scenario";
export const metadata: Metadata = { title: "Nhật ký kiểm toán" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const query = await searchParams;
  return (
    <AdminServicesProvider scenario={parseAdminScenario(query.state)}>
      <AdminAuditScreen />
    </AdminServicesProvider>
  );
}
