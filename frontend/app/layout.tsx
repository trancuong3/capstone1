import "@fontsource-variable/nunito/wght.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { NavigationFeedbackBar } from "@/components/common/navigation-feedback";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fffaf0",
};

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  const brand = translateMessage(
    messages,
    viMessages,
    locale,
    "common.brand.name",
  );
  const tagline = translateMessage(
    messages,
    viMessages,
    locale,
    "common.brand.tagline",
  );
  return {
    title: {
      default: brand,
      template: `%s | ${brand}`,
    },
    description: tagline,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { locale, dir, messages } = await getServerI18n();

  return (
    <html lang={locale} dir={dir}>
      <body>
        <I18nProvider initialLocale={locale} initialMessages={messages}>
          <NavigationFeedbackBar />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
