import { cache } from "react";
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
import type { MessageTree, MessagesDictionary } from "@/lib/i18n/types";
import { loadAdminLocaleMessages } from "@/messages/admin-loader";
import { loadLocaleMessages } from "@/messages/loader";
import { viMessages } from "@/messages/vi";

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

const getMemoizedPublishedServerLocale = cache(
  async (): Promise<SupportedLocale> => {
    try {
      const cookieStore = await cookies();
      const rawCookie = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
      return resolveServerLocaleFromCookieValue(rawCookie, {
        publishedOnly: true,
      });
    } catch {
      return DEFAULT_LOCALE;
    }
  },
);

/**
 * Reads `viread_locale` using Next.js 16 async `cookies()`.
 * Falls back safely to `DEFAULT_LOCALE` (`"vi"`) when called outside a
 * request scope (e.g. unit tests or static pre-evaluation).
 */
export async function getServerLocale(
  options: ServerLocaleOptions = {},
): Promise<SupportedLocale> {
  if (options.publishedOnly === false) {
    try {
      const cookieStore = await cookies();
      const rawCookie = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
      return resolveServerLocaleFromCookieValue(rawCookie, options);
    } catch {
      return DEFAULT_LOCALE;
    }
  }
  return getMemoizedPublishedServerLocale();
}

export interface ServerI18nSnapshot {
  readonly locale: SupportedLocale;
  readonly dir: TextDirection;
  readonly metadata: LocaleMetadata;
  readonly messages: MessagesDictionary;
}

export interface ServerAdminI18nSnapshot extends ServerI18nSnapshot {
  readonly adminMessages: MessageTree;
  readonly viAdminMessages: MessageTree;
  readonly fallbackMessages: MessagesDictionary;
}

/**
 * Omits the large (~170-240 KB) `admin` i18n namespace from RSC serialization
 * on non-admin routes. Client navigation into `/admin` lazily hydrates the
 * full locale bundle via `I18nProvider`.
 */
export function stripHeavyUnusedNamespaces(
  messages: MessagesDictionary,
  requestPath: string,
): MessagesDictionary {
  const normalizedPath = requestPath.split("?")[0] ?? "/";
  if (
    normalizedPath === "/admin" ||
    normalizedPath.startsWith("/admin/") ||
    !("admin" in messages)
  ) {
    return messages;
  }
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(messages)) {
    if (key === "admin") continue;
    trimmed[key] = value;
  }
  return trimmed as MessagesDictionary;
}

const getMemoizedPublishedServerI18n = cache(
  async (): Promise<ServerI18nSnapshot> => {
    const locale = await getMemoizedPublishedServerLocale();
    const messages = await loadLocaleMessages(locale);
    const metadata = getLocaleMetadata(locale);

    return {
      locale,
      dir: getLocaleDirection(locale),
      metadata,
      messages,
    };
  },
);

/**
 * Loads ONLY the resolved SSR locale's core message bundle (excluding `admin`)
 * for RootLayout hydration.
 */
export async function getServerI18n(
  options: ServerLocaleOptions = {},
): Promise<ServerI18nSnapshot> {
  if (options.publishedOnly === false) {
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
  return getMemoizedPublishedServerI18n();
}

/**
 * Loads the resolved SSR locale's core messages PLUS the route-scoped `admin`
 * namespace (and `vi` admin fallback) exclusively for `/admin/**` layouts and
 * metadata/loading boundaries.
 */
export async function getServerAdminI18n(
  options: ServerLocaleOptions = {},
): Promise<ServerAdminI18nSnapshot> {
  const locale = await getServerLocale(options);
  const [coreMessages, adminMessages, viAdminMessages] = await Promise.all([
    loadLocaleMessages(locale),
    loadAdminLocaleMessages(locale),
    locale === DEFAULT_LOCALE
      ? Promise.resolve<MessageTree | null>(null)
      : loadAdminLocaleMessages(DEFAULT_LOCALE),
  ]);
  const resolvedViAdmin = viAdminMessages ?? adminMessages;
  const metadata = getLocaleMetadata(locale);

  return {
    locale,
    dir: getLocaleDirection(locale),
    metadata,
    messages: {
      ...coreMessages,
      admin: adminMessages,
    },
    adminMessages,
    viAdminMessages: resolvedViAdmin,
    fallbackMessages: {
      ...viMessages,
      admin: resolvedViAdmin,
    },
  };
}
