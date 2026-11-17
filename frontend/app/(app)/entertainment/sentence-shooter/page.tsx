import { SentenceShooterScreen } from "@/components/entertainment/sentence-shooter/sentence-shooter-screen";
import { z } from "zod";

interface SentenceShooterPageProps {
  searchParams: Promise<{
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
      initialBookId={firstValue(query.book_id)}
      readingSessionId={readingSessionId}
    />
  );
}
