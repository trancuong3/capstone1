import type { Metadata } from "next";

import { DifficultWordsScreen } from "@/components/reports/difficult-words-screen";
import { firstQueryValue } from "@/lib/utils/report-state";

export const metadata: Metadata = { title: "Từ cần luyện" };

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
