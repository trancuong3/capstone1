import type { Metadata } from "next";

import { BookDetailScreen } from "@/components/books/book-detail-screen";
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
      "books.detail.pageTitle",
    ),
  };
}

interface BookDetailPageProps {
  params: Promise<{ bookId: string }>;
}

export default async function BookDetailPage({ params }: BookDetailPageProps) {
  const { bookId } = await params;

  return <BookDetailScreen bookId={bookId} />;
}
