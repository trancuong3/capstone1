import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { KaraokeWorkspaceScreen } from "@/components/admin/karaoke/karaoke-workspace-screen";
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
      "admin.routes.karaokeEditTitle",
      undefined,
      "Biên tập bài hát",
    ),
  };
}

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
