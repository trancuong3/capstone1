import type { Metadata } from "next";
import { Suspense } from "react";

import { DynamicAdminOcrReviewScreen } from "@/components/admin/admin-dynamic-screens";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
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
  const [{ bookId, pageId }, { locale, messages, fallbackMessages }] =
    await Promise.all([params, getServerAdminI18n()]);
  return (
    <Suspense
      fallback={
        <div
          aria-live="polite"
          className="mx-auto max-w-5xl px-4 py-12 text-sm text-muted"
        >
          {translateMessage(
            messages,
            fallbackMessages,
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
