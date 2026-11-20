import { notFound } from "next/navigation";
import { z } from "zod";
import { KaraokeWorkspaceScreen } from "@/components/admin/karaoke/karaoke-workspace-screen";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ songId: string }>;
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const { songId } = await params;
  if (!z.guid().safeParse(songId).success) notFound();
  const { mode } = await searchParams;
  return (
    <KaraokeWorkspaceScreen
      key={songId}
      songId={songId}
      advanced={mode === "advanced"}
    />
  );
}
