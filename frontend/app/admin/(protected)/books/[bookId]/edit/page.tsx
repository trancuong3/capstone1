import type { Metadata } from "next";

import { AdminBookEditorScreen } from "@/components/admin/admin-book-editor-screen";
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
      "admin.routes.bookEditTitle",
    ),
  };
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<{ returnTo?: string; issue?: string }>;
}) {
  const { bookId } = await params;
  const query = await searchParams;
  return (
    <AdminBookEditorScreen
      bookId={bookId}
      issue={query.issue}
      returnTo={
        query.returnTo === "metadata-quality" ? "metadata-quality" : "detail"
      }
    />
  );
}
