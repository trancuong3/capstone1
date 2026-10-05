import type { Metadata } from "next";
import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { parseAdminScenario } from "@/lib/utils/admin-scenario";
export const metadata: Metadata = { title: "Kho sách quản trị" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const query = await searchParams;
  return (
    <AdminServicesProvider scenario={parseAdminScenario(query.state)}>
      <AdminBooksScreen />
    </AdminServicesProvider>
  );
}
