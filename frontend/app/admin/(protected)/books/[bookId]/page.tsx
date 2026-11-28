import type { Metadata } from "next";
import { AdminBookDetailScreen } from "@/components/admin/admin-book-detail-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
      locale,
      "admin.routes.bookDetailTitle",
      undefined,
      "Chi tiết sách",
    ),
  };
}

export default async function Page({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  return <AdminBookDetailScreen bookId={bookId} />;
}
