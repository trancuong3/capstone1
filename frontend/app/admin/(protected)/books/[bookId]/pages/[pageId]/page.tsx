import { Suspense } from "react";

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
      <Suspense
        fallback={
          <div
            aria-live="polite"
            className="mx-auto max-w-5xl px-4 py-12 text-sm text-muted"
          >
            Đang mở trang OCR Review…
          </div>
        }
      >
        <AdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </Suspense>
    </AdminServicesProvider>
  );
}
