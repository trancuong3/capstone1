import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { BookScannerScreen } from "@/components/reading/book-scanner-screen";

export const metadata: Metadata = {
  title: "Quét trang sách",
};

interface BookScannerPageProps {
  searchParams: Promise<{
    flow?: string | string[];
    childId?: string | string[];
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

  return (
    <AppServicesProvider scenario="default">
      <BookScannerScreen
        flow={firstValue(query.flow)}
        childId={firstValue(query.childId)}
        bookId={firstValue(query.bookId)}
      />
    </AppServicesProvider>
  );
}
