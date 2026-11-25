import type { Metadata } from "next";

import { BookScannerScreen } from "@/components/reading/book-scanner-screen";

export const metadata: Metadata = {
  title: "Quét trang sách",
};

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
