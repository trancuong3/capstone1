"use client";

import { useEffect, useState } from "react";

import { translateMessage } from "@/lib/i18n/formatter";
import {
  DEFAULT_LOCALE,
  getLocaleMetadata,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import {
  readGuestLocalePreference,
  readLocaleCookie,
} from "@/lib/i18n/persistence";
import type { MessagesDictionary } from "@/lib/i18n/types";
import { loadLocaleMessages } from "@/messages/loader";
import { viMessages } from "@/messages/vi";
import "./globals.css";

export default function GlobalErrorPage({
  error,
  reset,
  retry,
}: {
  readonly error: unknown;
  readonly reset?: () => void;
  readonly retry?: () => void;
}) {
  const [localeState, setLocaleState] = useState<{
    readonly locale: SupportedLocale;
    readonly messages: MessagesDictionary;
  }>({
    locale: DEFAULT_LOCALE,
    messages: viMessages,
  });

  useEffect(() => {
    console.error(error);
  }, [error]);

  useEffect(() => {
    let active = true;
    const clientLocale =
      readLocaleCookie() ?? readGuestLocalePreference() ?? DEFAULT_LOCALE;
    if (clientLocale === DEFAULT_LOCALE) {
      return;
    }

    void loadLocaleMessages(clientLocale).then((messages) => {
      if (!active) return;
      setLocaleState({ locale: clientLocale, messages });
    });

    return () => {
      active = false;
    };
  }, []);

  const meta = getLocaleMetadata(localeState.locale);
  const title = translateMessage(
    localeState.messages,
    viMessages,
    localeState.locale,
    "common.errorPage.globalTitle",
  );
  const description = translateMessage(
    localeState.messages,
    viMessages,
    localeState.locale,
    "common.errorPage.globalDescription",
  );
  const retryLabel = translateMessage(
    localeState.messages,
    viMessages,
    localeState.locale,
    "common.actions.retry",
  );
  const homeLabel = translateMessage(
    localeState.messages,
    viMessages,
    localeState.locale,
    "common.errorPage.backHome",
  );

  return (
    <html lang={meta.bcp47} dir={meta.dir}>
      <body className="min-h-dvh bg-canvas text-ink">
        <title>{title}</title>
        <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col justify-center gap-4 px-4 py-12">
          <div className="rounded-card border border-border bg-white p-6 shadow-sm">
            <h1 className="text-heading font-extrabold text-ink">{title}</h1>
            <p className="mt-3 text-body text-muted">{description}</p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <button
                className="inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 py-2.5 text-button font-bold text-white hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
                onClick={() => (retry ?? reset)?.()}
                type="button"
              >
                {retryLabel}
              </button>
              <a
                className="inline-flex min-h-12 items-center justify-center rounded-control bg-sky px-6 py-2.5 text-button font-bold text-primary-hover hover:bg-border focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
                href="/dashboard"
              >
                {homeLabel}
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
