import type { Metadata } from "next";
import { KaraokeLibraryScreen } from "@/components/admin/karaoke/karaoke-library-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerAdminI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages, fallbackMessages } = await getServerAdminI18n();
  return {
    title: translateMessage(
      messages,
      fallbackMessages,
      locale,
      "admin.routes.karaokeTitle",
      undefined,
      "Quản lý bài hát",
    ),
  };
}

export default function Page() {
  return <KaraokeLibraryScreen />;
}
