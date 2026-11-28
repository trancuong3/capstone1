import type { Metadata } from "next";
import { KaraokeWorkspaceScreen } from "@/components/admin/karaoke/karaoke-workspace-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
      locale,
      "admin.routes.karaokeNewTitle",
      undefined,
      "Tạo bài hát mới",
    ),
  };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const { mode } = await searchParams;
  return <KaraokeWorkspaceScreen key="new" advanced={mode === "advanced"} />;
}
