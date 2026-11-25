import type { Metadata } from "next";

import { BookDetailScreen } from "@/components/books/book-detail-screen";

export const metadata: Metadata = {
  title: "Chi tiết sách",
};

interface BookDetailPageProps {
  params: Promise<{ bookId: string }>;
}

export default async function BookDetailPage({ params }: BookDetailPageProps) {
  const { bookId } = await params;

  return <BookDetailScreen bookId={bookId} />;
}
