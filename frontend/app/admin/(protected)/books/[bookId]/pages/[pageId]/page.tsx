import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
export default async function Page({
  params,
}: {
  params: Promise<{ bookId: string; pageId: string }>;
}) {
  const { bookId, pageId } = await params;
  return (
    <AdminServicesProvider>
      <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
    </AdminServicesProvider>
  );
}
