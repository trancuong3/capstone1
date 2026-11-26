import type { Metadata } from "next";

import { ReadingPreparationScreen } from "@/components/reading/reading-preparation-screen";
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
      "reading.preparation.pageTitle",
    ),
  };
}

interface ReadingPreparationPageProps {
  searchParams: Promise<{
    bookId?: string | string[];
    pageId?: string | string[];
    endPageId?: string | string[];
    confidence?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ReadingPreparationPage({
  searchParams,
}: ReadingPreparationPageProps) {
  const query = await searchParams;
  return (
    <ReadingPreparationScreen
      bookId={firstValue(query.bookId)}
      pageId={firstValue(query.pageId)}
      endPageId={firstValue(query.endPageId)}
      confidence={firstValue(query.confidence)}
    />
  );
}
