import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";

import { KaraokePlayerScreen } from "@/components/karaoke/karaoke-player-screen";
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
      "entertainment.karaoke.title",
    ),
    description: translateMessage(
      messages,
      viMessages,
      locale,
      "entertainment.karaoke.subtitle",
    ),
  };
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ songId: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const { songId } = await params;
  const { version } = await searchParams;
  if (
    !z.guid().safeParse(songId).success ||
    (version !== undefined && !z.guid().safeParse(version).success)
  )
    notFound();
  return (
    <KaraokePlayerScreen
      songId={songId}
      expectedVersionId={version as string | undefined}
    />
  );
}
