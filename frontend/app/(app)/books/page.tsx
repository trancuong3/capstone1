import type { Metadata } from "next";

import { BookLibraryScreen } from "@/components/books/book-library-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { parseAppMockScenario } from "@/lib/utils/ui-scenario";

export const metadata: Metadata = {
  title: "Thư viện sách",
};

interface BooksPageProps {
  searchParams: Promise<{
    childId?: string | string[];
    state?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BooksPage({ searchParams }: BooksPageProps) {
  const query = await searchParams;
  const scenario = parseAppMockScenario(query.state);

  return (
    <AppServicesProvider bookScenario={scenario} scenario="default">
      <BookLibraryScreen requestedChildId={firstValue(query.childId)} />
    </AppServicesProvider>
  );
}
