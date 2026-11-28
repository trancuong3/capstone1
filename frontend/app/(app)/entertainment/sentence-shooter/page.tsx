import type { Metadata } from "next";
import { z } from "zod";

import { SentenceShooterScreen } from "@/components/entertainment/sentence-shooter/sentence-shooter-screen";
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
      "games.sentenceShooter.title",
    ),
    description: translateMessage(
      messages,
      viMessages,
      locale,
      "games.sentenceShooter.subtitle",
    ),
  };
}

interface SentenceShooterPageProps {
  searchParams: Promise<{
    autoplay?: string | string[];
    book_id?: string | string[];
    reading_session_id?: string | string[];
    source?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SentenceShooterPage({
  searchParams,
}: SentenceShooterPageProps) {
  const query = await searchParams;
  const candidateSessionId = firstValue(query.reading_session_id);
  const readingSessionId =
    firstValue(query.source) === "reading-completion" &&
    candidateSessionId &&
    z.uuid().safeParse(candidateSessionId).success
      ? candidateSessionId
      : undefined;

  return (
    <SentenceShooterScreen
      autoPlay={firstValue(query.autoplay) === "1"}
      initialBookId={firstValue(query.book_id)}
      readingSessionId={readingSessionId}
    />
  );
}
