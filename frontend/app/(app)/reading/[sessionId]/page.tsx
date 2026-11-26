import type { Metadata } from "next";

import { ReadingScreen } from "@/components/reading/reading-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import {
  parseReadingUiState,
  parseReconnectDemoMode,
} from "@/lib/utils/reading-state";
import { viMessages } from "@/messages/vi";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "reading.session.pageTitle",
    ),
  };
}

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
    <ReadingScreen
      initialPageId={firstValue(query.pageId)}
      initialUiState={parseReadingUiState(query.state)}
      reconnectMode={parseReconnectDemoMode(query.reconnect)}
      sessionId={sessionId}
    />
  );
}
