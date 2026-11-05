import type { Metadata } from "next";

import { BookDetailScreen } from "@/components/books/book-detail-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

export const metadata: Metadata = {
  title: "Chi tiết sách",
};

interface BookDetailPageProps {
  params: Promise<{ bookId: string }>;
}

export default async function BookDetailPage({ params }: BookDetailPageProps) {
  const { bookId } = await params;

  return (
    <AppServicesProvider>
      <BookDetailScreen bookId={bookId} />
    </AppServicesProvider>
  );
}
