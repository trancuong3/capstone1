import type { Metadata } from "next";

import { BookDetailScreen } from "@/components/books/book-detail-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

export const metadata: Metadata = {
  title: "Chi tiết sách",
};

interface BookDetailPageProps {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<{
    childId?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BookDetailPage({
  params,
  searchParams,
}: BookDetailPageProps) {
  const [{ bookId }, query] = await Promise.all([params, searchParams]);

  return (
    <AppServicesProvider>
      <BookDetailScreen
        bookId={bookId}
        requestedChildId={firstValue(query.childId)}
      />
    </AppServicesProvider>
  );
}
