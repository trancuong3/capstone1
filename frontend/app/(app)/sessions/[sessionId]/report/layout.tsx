import type { Metadata } from "next";
import type { ReactNode } from "react";

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
      "reports.sessions.readingReports.pageHeading",
    ),
  };
}

export default function SessionReportLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return <>{children}</>;
}
