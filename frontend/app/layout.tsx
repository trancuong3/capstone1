import "@fontsource-variable/nunito/wght.css";
import "@/lib/zod-config";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { ViReadAssistantWidget } from "@/components/assistant/viread-assistant-widget";
import { NavigationFeedbackBar } from "@/components/common/navigation-feedback";
import { PreconnectResources } from "@/components/common/preconnect-resources";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { translateMessage } from "@/lib/i18n/formatter";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import { getServerI18n, stripHeavyUnusedNamespaces } from "@/lib/i18n/server";
import { resolvePreconnectOrigins } from "@/lib/utils/origin";
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
  const preconnectOrigins = resolvePreconnectOrigins([
    process.env.NEXT_PUBLIC_API_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ]);
  let requestPath = "/";
  try {
    const requestHeaders = await headers();
    requestPath = requestHeaders.get("x-viread-next") ?? "/";
  } catch {
    // Outside request scope (static prerender or unit tests).
  }

  // `viMessages` is bundled in the client chunk of I18nProvider. Omitting it
  // from RSC props for the default Vietnamese locale eliminates ~440 KB of
  // duplicated inline JSON from every HTML/RSC payload. For non-default
  // locales, strip the ~200 KB `admin` namespace on non-admin routes.
  const initialMessages =
    locale === DEFAULT_LOCALE
      ? undefined
      : stripHeavyUnusedNamespaces(messages, requestPath);

  return (
    <html lang={locale} dir={dir}>
      <body>
        <PreconnectResources origins={preconnectOrigins} />
        <I18nProvider initialLocale={locale} initialMessages={initialMessages}>
          <NavigationFeedbackBar />
          {children}
          <ViReadAssistantWidget />
        </I18nProvider>
      </body>
    </html>
  );
}
