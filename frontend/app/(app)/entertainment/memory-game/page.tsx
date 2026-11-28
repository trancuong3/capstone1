import type { Metadata } from "next";

import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
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
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MemoryGamePage({
  searchParams,
}: MemoryGamePageProps) {
  const query = await searchParams;
  return <MemoryGameScreen autoPlay={firstValue(query.autoplay) === "1"} />;
}
