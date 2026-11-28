import type { Metadata } from "next";
import { z } from "zod";

import { SentenceShooterScreen } from "@/components/entertainment/sentence-shooter/sentence-shooter-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";
import type {
  SentenceShooterDifficulty,
  SentenceShooterLearningMode,
} from "@/types/sentence-shooter";

const VALID_DIFFICULTIES: readonly SentenceShooterDifficulty[] = [
  "easy",
  "medium",
  "challenge",
];
const VALID_LEARNING_MODES: readonly SentenceShooterLearningMode[] = [
  "WORD_ORDER",
  "FILL_BLANK",
  "GRAMMAR_FOCUS",
];

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
    bookId?: string | string[];
    pageId?: string | string[];
    childId?: string | string[];
    difficulty?: string | string[];
    reading_session_id?: string | string[];
    source?: string | string[];
    mode?: string | string[];
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
  const rawDifficulty = firstValue(query.difficulty);
  const initialDifficulty =
    rawDifficulty &&
    (VALID_DIFFICULTIES as readonly string[]).includes(rawDifficulty)
      ? (rawDifficulty as SentenceShooterDifficulty)
      : undefined;
  const rawMode = firstValue(query.mode);
  const initialLearningMode =
    rawMode && (VALID_LEARNING_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as SentenceShooterLearningMode)
      : undefined;
  const initialMode = rawMode === "magic-quest" ? "magic-quest" : undefined;
  const candidatePageId = firstValue(query.pageId);
  const initialPageId =
    candidatePageId && z.uuid().safeParse(candidatePageId).success
      ? candidatePageId
      : undefined;

  return (
    <SentenceShooterScreen
      autoPlay={firstValue(query.autoplay) === "1"}
      initialBookId={firstValue(query.bookId) ?? firstValue(query.book_id)}
      initialDifficulty={initialDifficulty}
      initialLearningMode={initialLearningMode}
      initialMode={initialMode}
      initialPageId={initialPageId}
      readingSessionId={readingSessionId}
    />
  );
}
