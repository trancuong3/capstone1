import { notFound } from "next/navigation";
import { z } from "zod";
import { KaraokeEditorScreen } from "@/components/admin/karaoke/karaoke-editor-screen";

export default async function Page({
  params,
}: {
  params: Promise<{ songId: string }>;
}) {
  const { songId } = await params;
  if (!z.guid().safeParse(songId).success) notFound();
  return <KaraokeEditorScreen key={songId} songId={songId} />;
}
