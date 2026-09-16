import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { DifficultWordsScreen } from "@/components/reports/difficult-words-screen";
import {
  firstQueryValue,
  parseGroup5DemoState,
} from "@/lib/utils/report-state";

export const metadata: Metadata = { title: "Từ cần luyện" };

interface DifficultWordsPageProps {
  readonly searchParams: Promise<{
    childId?: string | string[];
    state?: string | string[];
  }>;
}

export default async function DifficultWordsPage({
  searchParams,
}: DifficultWordsPageProps) {
  const query = await searchParams;
  return (
    <AppServicesProvider
      difficultWordScenario={parseGroup5DemoState(query.state)}
      scenario="default"
    >
      <DifficultWordsScreen requestedChildId={firstQueryValue(query.childId)} />
    </AppServicesProvider>
  );
}
