import type { Metadata } from "next";

import { DifficultWordsScreen } from "@/components/reports/difficult-words-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { firstQueryValue } from "@/lib/utils/report-state";
import { viMessages } from "@/messages/vi";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "difficultWords.screen.pageTitle",
    ),
  };
}

interface DifficultWordsPageProps {
  readonly searchParams: Promise<{
    childId?: string | string[];
    word?: string | string[];
  }>;
}

export default async function DifficultWordsPage({
  searchParams,
}: DifficultWordsPageProps) {
  const query = await searchParams;
  return (
    <DifficultWordsScreen
      requestedChildId={firstQueryValue(query.childId)}
      requestedPracticeWord={firstQueryValue(query.word)}
    />
  );
}
