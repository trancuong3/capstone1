import type { Metadata } from "next";

import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
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
      "ocr.scanner.pageTitle",
    ),
  };
}

interface BookScannerPageProps {
  searchParams: Promise<{
    bookId?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BookScannerPage({
  searchParams,
}: BookScannerPageProps) {
  const query = await searchParams;
  return <BookScannerScreen bookId={firstValue(query.bookId)} />;
}
