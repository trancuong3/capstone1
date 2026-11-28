import type { Metadata } from "next";

import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";
import type { PictureTeachingMode } from "@/types/picture-description";

const VALID_TEACHING_MODES: readonly PictureTeachingMode[] = [
  "OBSERVE",
  "VOCABULARY",
  "SENTENCE",
  "STORY",
  "INFER",
  "CREATE",
];

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "entertainment.pictureDescription.title",
    ),
    description: translateMessage(
      messages,
      viMessages,
      locale,
      "entertainment.pictureDescription.subtitle",
    ),
  };
}

interface PictureDescriptionPageProps {
  readonly searchParams: Promise<{
    autoplay?: string | string[];
    mode?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PictureDescriptionPage({
  searchParams,
}: PictureDescriptionPageProps) {
  const query = await searchParams;
  const rawMode = firstValue(query.mode);
  const initialTeachingMode =
    rawMode && (VALID_TEACHING_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as PictureTeachingMode)
      : undefined;
  return (
    <PictureDescriptionScreen
      autoPlay={firstValue(query.autoplay) === "1"}
      initialTeachingMode={initialTeachingMode}
    />
  );
}
