import type { Metadata } from "next";

import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";
import type { MemoryRecallMode } from "@/types/memory-game";

const VALID_RECALL_MODES: readonly MemoryRecallMode[] = [
  "FREE_RECALL",
  "GUIDED_RECALL",
];

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "games.memoryGame.title",
    ),
    description: translateMessage(
      messages,
      viMessages,
      locale,
      "games.memoryGame.subtitle",
    ),
  };
}

interface MemoryGamePageProps {
  readonly searchParams: Promise<{
    autoplay?: string | string[];
    recall_mode?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MemoryGamePage({
  searchParams,
}: MemoryGamePageProps) {
  const query = await searchParams;
  const rawRecallMode = firstValue(query.recall_mode);
  const initialRecallMode =
    rawRecallMode &&
    (VALID_RECALL_MODES as readonly string[]).includes(rawRecallMode)
      ? (rawRecallMode as MemoryRecallMode)
      : undefined;
  return (
    <MemoryGameScreen
      autoPlay={firstValue(query.autoplay) === "1"}
      initialRecallMode={initialRecallMode}
    />
  );
}
