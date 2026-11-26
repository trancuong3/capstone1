import { cookies } from "next/headers";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  getLocaleDirection,
  getLocaleMetadata,
  isLocalePublished,
  normalizeLocale,
  type LocaleMetadata,
  type SupportedLocale,
  type TextDirection,
} from "@/lib/i18n/locales";
import type { MessagesDictionary } from "@/lib/i18n/types";
import { loadLocaleMessages } from "@/messages/loader";

export interface ServerLocaleOptions {
  readonly publishedOnly?: boolean;
}

/**
 * Resolves a raw `viread_locale` cookie string to a valid ViRead locale.
 * In SSR production mode (`publishedOnly = true`), unpublished locales
 * safely fall back to `DEFAULT_LOCALE` (`"vi"`).
 */
export function resolveServerLocaleFromCookieValue(
  rawCookie: string | null | undefined,
  options: ServerLocaleOptions = {},
): SupportedLocale {
  const publishedOnly = options.publishedOnly ?? true;
  const normalized = normalizeLocale(rawCookie);
  if (!normalized) return DEFAULT_LOCALE;
  if (publishedOnly && !isLocalePublished(normalized)) {
    return DEFAULT_LOCALE;
  }
  return normalized;
}

/**
 * Reads `viread_locale` using Next.js 16 async `cookies()`.
 * Falls back safely to `DEFAULT_LOCALE` (`"vi"`) when called outside a
 * request scope (e.g. unit tests or static pre-evaluation).
 */
export async function getServerLocale(
  options: ServerLocaleOptions = {},
): Promise<SupportedLocale> {
  try {
    const cookieStore = await cookies();
    const rawCookie = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
    return resolveServerLocaleFromCookieValue(rawCookie, options);
  } catch {
    return DEFAULT_LOCALE;
  }
}

export interface ServerI18nSnapshot {
  readonly locale: SupportedLocale;
  readonly dir: TextDirection;
  readonly metadata: LocaleMetadata;
  readonly messages: MessagesDictionary;
}

/**
 * Loads ONLY the resolved SSR locale's message bundle for RootLayout hydration.
 */
export async function getServerI18n(
  options: ServerLocaleOptions = {},
): Promise<ServerI18nSnapshot> {
  const locale = await getServerLocale(options);
  const messages = await loadLocaleMessages(locale);
  const metadata = getLocaleMetadata(locale);

  return {
    locale,
    dir: getLocaleDirection(locale),
    metadata,
    messages,
  };
}
