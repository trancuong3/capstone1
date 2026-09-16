import type { Metadata } from "next";
import { AdminNewBookScreen } from "@/components/admin/admin-new-book-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { parseAdminScenario } from "@/lib/utils/admin-scenario";
export const metadata: Metadata = { title: "Tạo sách mới" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const query = await searchParams;
  return (
    <AdminServicesProvider scenario={parseAdminScenario(query.state)}>
      <AdminNewBookScreen />
    </AdminServicesProvider>
  );
}
