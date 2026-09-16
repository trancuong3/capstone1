import type { Metadata } from "next";

import { BookDetailScreen } from "@/components/books/book-detail-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { parseAppMockScenario } from "@/lib/utils/ui-scenario";

export const metadata: Metadata = {
  title: "Chi tiết sách",
};

interface BookDetailPageProps {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<{
    childId?: string | string[];
    state?: string | string[];
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
  const scenario = parseAppMockScenario(query.state);

  return (
    <AppServicesProvider bookScenario={scenario} scenario="default">
      <BookDetailScreen
        bookId={bookId}
        requestedChildId={firstValue(query.childId)}
      />
    </AppServicesProvider>
  );
}
