import type { Metadata } from "next";
import { Suspense } from "react";

import { DynamicAdminOcrReviewScreen } from "@/components/admin/admin-dynamic-screens";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "admin.routes.ocrReviewTitle",
      undefined,
      "Kiểm tra OCR trang sách",
    ),
  };
}

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
  );
}
