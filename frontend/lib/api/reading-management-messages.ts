import { translateMessage } from "@/lib/i18n/formatter";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import { readLocaleCookie } from "@/lib/i18n/persistence";
import type { MessagesDictionary } from "@/lib/i18n/types";
import { getCachedLocaleMessages } from "@/messages/loader";
import { viMessages } from "@/messages/vi";

/**
 * Backend `detail` strings of Reading Management conflicts (HTTP 409) mapped to
 * parent-facing i18n keys. Only these authored strings may reach the UI.
 */
export const readingManagementMessageKeys: Readonly<Record<string, string>> = {
  "An active goal with the same metric and period already overlaps these dates":
    "errors.readingManagement.overlappingGoal",
  "The end date is already in the past": "errors.readingManagement.endDatePast",
  "The end date must not be before the start date":
    "errors.readingManagement.endDateBeforeStart",
  "The plan end date is already in the past":
    "errors.readingManagement.planEndDatePast",
  "The plan has no reading day between its start and end dates":
    "errors.readingManagement.noReadingDayInRange",
  "The selected book is not available to read":
    "errors.readingManagement.bookUnavailable",
  "A reminder with the same time and overlapping days already exists":
    "errors.readingManagement.duplicateReminder",
  "The requested state transition is not allowed":
    "errors.readingManagement.invalidTransition",
};

export const readingManagementMessages: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(readingManagementMessageKeys).map(([detail, key]) => [
      detail,
      translateMessage(viMessages, viMessages, DEFAULT_LOCALE, key),
    ]),
  );

const knownDefaultMessages = new Set(Object.values(readingManagementMessages));

function resolveRuntimeLocale(): SupportedLocale {
  const cookieLocale = readLocaleCookie();
  if (cookieLocale) return cookieLocale;
  if (typeof document !== "undefined") {
    return normalizeLocale(document.documentElement?.lang) ?? DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

function getKnownConflictMessages(locale: SupportedLocale): Set<string> {
  const activeMessages: MessagesDictionary =
    getCachedLocaleMessages(locale) ?? viMessages;
  const set = new Set(knownDefaultMessages);
  for (const key of Object.values(readingManagementMessageKeys)) {
    set.add(translateMessage(activeMessages, viMessages, locale, key));
  }
  return set;
}

/**
 * The specific, parent-facing reason when a mutation was refused by a business
 * rule (409); `null` for anything else so callers keep their generic wording.
 */
export function conflictMessage(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 409 &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const locale = resolveRuntimeLocale();
    if (getKnownConflictMessages(locale).has(error.message)) {
      return error.message;
    }
  }
  return null;
}
