import { AdminBookDetailScreen } from "@/components/admin/admin-book-detail-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
export default async function Page({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  return (
    <AdminServicesProvider>
      <AdminBookDetailScreen bookId={bookId} />
    </AdminServicesProvider>
  );
}
