import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { ReadingScreen } from "@/components/reading/reading-screen";
import {
  parseReadingUiState,
  parseReconnectDemoMode,
} from "@/lib/utils/reading-state";

export const metadata: Metadata = {
  title: "Bạn nhỏ cùng đọc",
};

interface ReadingPageProps {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{
    pageId?: string | string[];
    reconnect?: string | string[];
    state?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ReadingPage({
  params,
  searchParams,
}: ReadingPageProps) {
  const [{ sessionId }, query] = await Promise.all([params, searchParams]);

  return (
    <AppServicesProvider scenario="default">
      <ReadingScreen
        initialPageId={firstValue(query.pageId)}
        initialUiState={parseReadingUiState(query.state)}
        reconnectMode={parseReconnectDemoMode(query.reconnect)}
        sessionId={sessionId}
      />
    </AppServicesProvider>
  );
}
