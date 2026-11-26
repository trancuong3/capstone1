import { Suspense } from "react";

import { DynamicAdminOcrReviewScreen } from "@/components/admin/admin-dynamic-screens";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";

export default async function Page({
  params,
}: {
  params: Promise<{ bookId: string; pageId: string }>;
}) {
  const [{ bookId, pageId }, { locale, messages }] = await Promise.all([
    params,
    getServerI18n(),
  ]);
  return (
    <AdminServicesProvider>
      <Suspense
        fallback={
          <div
            aria-live="polite"
            className="mx-auto max-w-5xl px-4 py-12 text-sm text-muted"
          >
            {translateMessage(
              messages,
              viMessages,
              locale,
              "admin.routes.ocrReviewLoading",
            )}
          </div>
        }
      >
        <DynamicAdminOcrReviewScreen bookId={bookId} pageId={pageId} />
      </Suspense>
    </AdminServicesProvider>
  );
}
