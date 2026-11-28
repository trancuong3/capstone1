import type { Metadata } from "next";

import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
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
  readonly searchParams?: Promise<{
    childId?: string | string[];
    bookId?: string | string[];
    pageId?: string | string[];
  }>;
}

function firstQueryValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PictureDescriptionPage({
  searchParams,
}: PictureDescriptionPageProps = {}) {
  const query = searchParams ? await searchParams : {};
  return (
    <PictureDescriptionScreen
      initialBookId={firstQueryValue(query.bookId)}
      initialChildId={firstQueryValue(query.childId)}
      initialPageId={firstQueryValue(query.pageId)}
    />
  );
}
