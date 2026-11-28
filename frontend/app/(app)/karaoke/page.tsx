import type { Metadata } from "next";

import { KaraokeLibraryScreen } from "@/components/karaoke/karaoke-library-screen";
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

interface KaraokePageProps {
  readonly searchParams?: Promise<{
    autoplay?: string | string[];
    mode?: string | string[];
    focus?: string | string[];
    autopilot?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function Page({ searchParams }: KaraokePageProps = {}) {
  const query = searchParams ? await searchParams : undefined;
  const initialMode =
    firstValue(query?.mode) === "magic-chant" ? "magic-chant" : undefined;
  const autoPlay = firstValue(query?.autoplay) === "1";
  return <KaraokeLibraryScreen autoPlay={autoPlay} initialMode={initialMode} />;
}
