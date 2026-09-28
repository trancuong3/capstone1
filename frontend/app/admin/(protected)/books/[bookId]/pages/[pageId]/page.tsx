import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { parseAdminScenario } from "@/lib/utils/admin-scenario";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string; pageId: string }>;
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const [{ bookId, pageId }, query] = await Promise.all([params, searchParams]);
  return (
    <AdminServicesProvider scenario={parseAdminScenario(query.state)}>
      <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
    </AdminServicesProvider>
  );
}
