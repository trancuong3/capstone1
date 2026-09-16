import type { Metadata } from "next";
import { AdminLoginScreen } from "@/components/admin/admin-login-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { parseAdminScenario } from "@/lib/utils/admin-scenario";
export const metadata: Metadata = { title: "Đăng nhập quản trị" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const query = await searchParams;
  const scenario = parseAdminScenario(query.state);
  return (
    <AdminServicesProvider scenario={scenario}>
      <AdminLoginScreen scenario={scenario} />
    </AdminServicesProvider>
  );
}
