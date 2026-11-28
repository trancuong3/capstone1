import { translateMessage } from "@/lib/i18n/formatter";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import { readLocaleCookie } from "@/lib/i18n/persistence";
import type { MessagesDictionary, TranslationParams } from "@/lib/i18n/types";
import {
  getCachedLocaleMessages,
  withCachedRuntimeNamespaces,
} from "@/messages/loader";
import { viMessages } from "@/messages/vi";

/**
 * Resolves the active client UI locale for non-React service, mapper, and
 * hook helpers without violating React Hook rules.
 */
export function getActiveClientLocale(): SupportedLocale {
  const cookieLocale = readLocaleCookie();
  if (cookieLocale) return cookieLocale;
  if (typeof document !== "undefined") {
    return normalizeLocale(document.documentElement?.lang) ?? DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

/**
 * Translates a UI key synchronously from cached active messages with safe
 * fallback to `viMessages` and any lazy-loaded runtime namespaces (e.g. `admin`).
 */
export function translateRuntime(
  key: string,
  params?: TranslationParams,
  defaultValue?: string,
): string {
  const locale = getActiveClientLocale();
  const activeMessages: MessagesDictionary = withCachedRuntimeNamespaces(
    locale,
    getCachedLocaleMessages(locale) ?? viMessages,
  );
  const fallbackMessages: MessagesDictionary = withCachedRuntimeNamespaces(
    DEFAULT_LOCALE,
    viMessages,
  );
  return translateMessage(
    activeMessages,
    fallbackMessages,
    locale,
    key,
    params,
    defaultValue,
  );
}
