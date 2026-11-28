import type { Metadata } from "next";

import ParentAppLayout from "@/app/(app)/layout";
import { FiveMinuteReadingTrain } from "@/components/adaptive/five-minute-reading-train";
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
      "fiveMinTrain.pageTitle",
    ),
    description: translateMessage(
      messages,
      viMessages,
      locale,
      "fiveMinTrain.pageDescription",
    ),
  };
}

interface LearningTrainPageProps {
  readonly searchParams: Promise<{
    childId?: string | string[];
    from?: string | string[];
  }>;
}

export default async function LearningTrainPage({
  searchParams,
}: LearningTrainPageProps) {
  const query = await searchParams;
  return (
    <ParentAppLayout>
      <FiveMinuteReadingTrain
        initialChildId={firstQueryValue(query.childId)}
        sourceSurface={firstQueryValue(query.from)}
      />
    </ParentAppLayout>
  );
}
