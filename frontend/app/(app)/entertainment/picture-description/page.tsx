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

export default function PictureDescriptionPage() {
  return <PictureDescriptionScreen />;
}
