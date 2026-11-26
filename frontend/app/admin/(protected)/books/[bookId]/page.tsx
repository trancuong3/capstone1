import type { Metadata } from "next";
import { AdminBookDetailScreen } from "@/components/admin/admin-book-detail-screen";
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
