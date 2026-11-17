import { notFound } from "next/navigation";
import { z } from "zod";
import { KaraokePlayerScreen } from "@/components/karaoke/karaoke-player-screen";

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
