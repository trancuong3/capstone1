import { AdminBookDetailScreen } from "@/components/admin/admin-book-detail-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { parseAdminScenario } from "@/lib/utils/admin-scenario";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const [{ bookId }, query] = await Promise.all([params, searchParams]);
  return (
    <AdminServicesProvider scenario={parseAdminScenario(query.state)}>
      <AdminBookDetailScreen bookId={bookId} />
    </AdminServicesProvider>
  );
}
