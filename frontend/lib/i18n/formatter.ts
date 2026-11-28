import {
  DEFAULT_LOCALE,
  getLocaleMetadata,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import type {
  MessageTree,
  MessagesDictionary,
  TranslationParams,
} from "@/lib/i18n/types";

const MAX_INTERPOLATION_DEPTH = 4;

const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes HTML special characters for non-React HTML sinks if ever needed.
 * React JSX already escapes plain text nodes automatically.
 */
export function escapePlainTextForHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

function resolveKeySegments(key: string): readonly string[] {
  const trimmed = key.trim();
  if (!trimmed) return [];

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const namespace = trimmed.slice(0, colonIndex);
    const rest = trimmed.slice(colonIndex + 1);
    return rest ? [namespace, ...rest.split(".")] : [namespace];
  }

  return trimmed.split(".");
}

function readMessageAtPath(
  dictionary: MessagesDictionary | undefined,
  segments: readonly string[],
): string | null {
  if (!dictionary || segments.length === 0) return null;

  let cursor: MessagesDictionary | MessageTree | string | undefined =
    dictionary;
  for (const segment of segments) {
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      !Object.hasOwn(cursor, segment)
    ) {
      return null;
    }
    cursor = (cursor as Record<string, MessageTree | string>)[segment];
  }

  return typeof cursor === "string" ? cursor : null;
}

function readParamValue(
  params: TranslationParams | undefined,
  key: string,
): string | number | boolean | null {
  if (!params || !Object.hasOwn(params, key)) return null;
  const value = params[key];
  if (value === undefined || value === null) return null;
  return value;
}

function sanitizePlainValue(value: string | number | boolean | null): string {
  if (value === null) return "";
  return String(value).replace(/\0/g, "");
}

interface ParsedPluralClause {
  readonly selector: string;
  readonly body: string;
}

function findMatchingBrace(input: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < input.length; i += 1) {
    const char = input[i];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function parsePluralClauses(block: string): readonly ParsedPluralClause[] {
  const clauses: ParsedPluralClause[] = [];
  let index = 0;

  while (index < block.length) {
    while (index < block.length && /\s/.test(block[index] ?? "")) {
      index += 1;
    }
    if (index >= block.length) break;

    const selectorStart = index;
    while (
      index < block.length &&
      block[index] !== "{" &&
      !/\s/.test(block[index] ?? "")
    ) {
      index += 1;
    }
    const selector = block.slice(selectorStart, index);

    while (index < block.length && /\s/.test(block[index] ?? "")) {
      index += 1;
    }
    if (block[index] !== "{") {
      break;
    }

    const closeIndex = findMatchingBrace(block, index);
    if (closeIndex === -1) {
      break;
    }

    clauses.push({
      selector,
      body: block.slice(index + 1, closeIndex),
    });
    index = closeIndex + 1;
  }

  return clauses;
}

function selectPluralClause(
  clauses: readonly ParsedPluralClause[],
  count: number,
  locale: SupportedLocale,
): string | null {
  if (clauses.length === 0) return null;

  const exactSelector = `=${count}`;
  const exactMatch = clauses.find(
    (clause) => clause.selector === exactSelector,
  );
  if (exactMatch) return exactMatch.body;

  let category = "other";
  try {
    const bcp47 = getLocaleMetadata(locale).bcp47;
    category = new Intl.PluralRules(bcp47).select(count);
  } catch {
    category = count === 1 ? "one" : "other";
  }

  const categoryMatch = clauses.find((clause) => clause.selector === category);
  if (categoryMatch) return categoryMatch.body;

  const otherMatch = clauses.find((clause) => clause.selector === "other");
  return otherMatch ? otherMatch.body : (clauses[0]?.body ?? null);
}

function renderMessageTemplate(
  template: string,
  params: TranslationParams | undefined,
  locale: SupportedLocale,
  depth: number,
): string {
  if (!template.includes("{") || depth > MAX_INTERPOLATION_DEPTH) {
    return template;
  }

  let output = "";
  let index = 0;

  while (index < template.length) {
    const char = template[index];
    if (char !== "{") {
      output += char;
      index += 1;
      continue;
    }

    const closeIndex = findMatchingBrace(template, index);
    if (closeIndex === -1) {
      output += template.slice(index);
      break;
    }

    const inner = template.slice(index + 1, closeIndex);
    const firstComma = inner.indexOf(",");

    if (firstComma === -1) {
      const key = inner.trim();
      const rawValue = readParamValue(params, key);
      output +=
        rawValue !== null ? sanitizePlainValue(rawValue) : `{${key || inner}}`;
      index = closeIndex + 1;
      continue;
    }

    const variableName = inner.slice(0, firstComma).trim();
    const rest = inner.slice(firstComma + 1);
    const secondComma = rest.indexOf(",");
    const formatType =
      secondComma === -1 ? rest.trim() : rest.slice(0, secondComma).trim();

    if (formatType === "plural" && secondComma !== -1) {
      const rawCount = readParamValue(params, variableName);
      const numericCount =
        typeof rawCount === "number"
          ? rawCount
          : typeof rawCount === "string" && rawCount.trim() !== ""
            ? Number(rawCount)
            : NaN;
      const clauses = parsePluralClauses(rest.slice(secondComma + 1));

      if (Number.isFinite(numericCount)) {
        const chosen = selectPluralClause(clauses, numericCount, locale);
        if (chosen !== null) {
          const formattedCount = formatNumber(numericCount, locale);
          const withPound = chosen.replaceAll("#", formattedCount);
          output += renderMessageTemplate(withPound, params, locale, depth + 1);
          index = closeIndex + 1;
          continue;
        }
      }
    }

    const fallbackRaw = readParamValue(params, variableName);
    output +=
      fallbackRaw !== null ? sanitizePlainValue(fallbackRaw) : `{${inner}}`;
    index = closeIndex + 1;
  }

  return output;
}

/**
 * Formats a message template using plain-text interpolation `{name}` and
 * safe ICU-subset pluralization `{count, plural, one {...} other {...}}`.
 * Never parses HTML or uses `eval`.
 */
export function formatMessage(
  template: string,
  params?: TranslationParams,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  return renderMessageTemplate(template, params, locale, 0);
}

/**
 * Resolves a translation key from `messages`, safely falling back to
 * `fallbackMessages` (`vi`), `defaultValue`, or the key itself.
 */
export function translateMessage(
  messages: MessagesDictionary | undefined,
  fallbackMessages: MessagesDictionary,
  locale: SupportedLocale,
  key: string,
  params?: TranslationParams,
  defaultValue?: string,
): string {
  const segments = resolveKeySegments(key);
  const template =
    readMessageAtPath(messages, segments) ??
    readMessageAtPath(fallbackMessages, segments) ??
    defaultValue ??
    key;

  return formatMessage(template, params, locale);
}

function toValidDate(value: Date | string | number): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export interface DateTimeFormatOptionsWithFallback
  extends Intl.DateTimeFormatOptions {
  readonly fallback?: string;
}

function formatWithDateTimeIntl(
  value: Date | string | number,
  locale: SupportedLocale,
  defaults: Intl.DateTimeFormatOptions,
  options?: DateTimeFormatOptionsWithFallback,
): string {
  const date = toValidDate(value);
  if (!date) return options?.fallback ?? "—";

  const bcp47 = getLocaleMetadata(locale).bcp47;
  const { fallback, ...intlOptions } = options ?? {};
  // ECMA-402 throws TypeError if dateStyle/timeStyle is combined with component
  // defaults (year, month, day, hour, minute), which would fall back to toISOString().
  const usesStylePresets =
    intlOptions.dateStyle !== undefined || intlOptions.timeStyle !== undefined;
  const mergedOptions: Intl.DateTimeFormatOptions = usesStylePresets
    ? { ...intlOptions }
    : { ...defaults, ...intlOptions };

  try {
    return new Intl.DateTimeFormat(bcp47, mergedOptions).format(date);
  } catch {
    try {
      const { timeZone: _ignoredTz, ...withoutTz } = mergedOptions;
      void _ignoredTz;
      return new Intl.DateTimeFormat(bcp47, withoutTz).format(date);
    } catch {
      return fallback ?? date.toISOString();
    }
  }
}

export function formatDate(
  value: Date | string | number,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options?: DateTimeFormatOptionsWithFallback,
): string {
  return formatWithDateTimeIntl(
    value,
    locale,
    { year: "numeric", month: "short", day: "numeric" },
    options,
  );
}

export function formatTime(
  value: Date | string | number,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options?: DateTimeFormatOptionsWithFallback,
): string {
  return formatWithDateTimeIntl(
    value,
    locale,
    { hour: "2-digit", minute: "2-digit" },
    options,
  );
}

export function formatDateTime(
  value: Date | string | number,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options?: DateTimeFormatOptionsWithFallback,
): string {
  return formatWithDateTimeIntl(
    value,
    locale,
    {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
    options,
  );
}

export function formatNumber(
  value: number,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) return "—";
  const bcp47 = getLocaleMetadata(locale).bcp47;
  try {
    return new Intl.NumberFormat(bcp47, options).format(value);
  } catch {
    return String(value);
  }
}

export interface PercentFormatOptions extends Intl.NumberFormatOptions {
  /** Set `false` if passing 0-100 percentages instead of 0-1 ratios. */
  readonly isRatio?: boolean;
}

export function formatPercent(
  value: number,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options?: PercentFormatOptions,
): string {
  if (!Number.isFinite(value)) return "—";
  const { isRatio = true, ...intlOptions } = options ?? {};
  const normalized = isRatio ? value : value / 100;
  const bcp47 = getLocaleMetadata(locale).bcp47;
  try {
    return new Intl.NumberFormat(bcp47, {
      style: "percent",
      maximumFractionDigits: 1,
      ...intlOptions,
    }).format(normalized);
  } catch {
    return `${Math.round(normalized * 100)}%`;
  }
}

export function formatList(
  items: readonly string[],
  locale: SupportedLocale = DEFAULT_LOCALE,
  options?: {
    readonly type?: "conjunction" | "disjunction" | "unit";
    readonly style?: "long" | "short" | "narrow";
  },
): string {
  if (items.length === 0) return "";
  const bcp47 = getLocaleMetadata(locale).bcp47;
  try {
    if (typeof Intl.ListFormat === "function") {
      return new Intl.ListFormat(bcp47, {
        type: options?.type ?? "conjunction",
        style: options?.style ?? "long",
      }).format(items);
    }
  } catch {
    // Fall back to standard comma separator below.
  }
  return items.join(", ");
}

function formatDurationUnit(
  value: number,
  unit: "hour" | "minute" | "second",
  locale: SupportedLocale,
  style: "long" | "short" | "narrow",
): string {
  const bcp47 = getLocaleMetadata(locale).bcp47;
  try {
    return new Intl.NumberFormat(bcp47, {
      style: "unit",
      unit,
      unitDisplay: style,
    }).format(value);
  } catch {
    const suffix = unit === "hour" ? "h" : unit === "minute" ? "m" : "s";
    return `${value}${suffix}`;
  }
}

export function formatDuration(
  totalSeconds: number,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options?: { readonly style?: "long" | "short" | "narrow" },
): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const style = options?.style ?? "short";
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(formatDurationUnit(hours, "hour", locale, style));
  if (minutes > 0) {
    parts.push(formatDurationUnit(minutes, "minute", locale, style));
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(formatDurationUnit(seconds, "second", locale, style));
  }

  return formatList(parts, locale, {
    type: "unit",
    style: style === "long" ? "long" : "short",
  });
}

function resolveRelativeDelta(
  target: Date,
  now: Date,
): { readonly value: number; readonly unit: Intl.RelativeTimeFormatUnit } {
  const diffSeconds = Math.round((target.getTime() - now.getTime()) / 1000);
  const absSeconds = Math.abs(diffSeconds);

  if (absSeconds < 60) {
    return { value: diffSeconds, unit: "second" };
  }
  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) {
    return { value: diffMinutes, unit: "minute" };
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return { value: diffHours, unit: "hour" };
  }
  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 30) {
    return { value: diffDays, unit: "day" };
  }
  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 12) {
    return { value: diffMonths, unit: "month" };
  }
  return { value: Math.round(diffDays / 365), unit: "year" };
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale?: SupportedLocale,
  options?: Intl.RelativeTimeFormatOptions,
): string;
export function formatRelativeTime(
  date: Date,
  locale?: SupportedLocale,
  options?: Intl.RelativeTimeFormatOptions & { readonly now?: Date },
): string;
export function formatRelativeTime(
  valueOrDate: number | Date,
  unitOrLocale?: Intl.RelativeTimeFormatUnit | SupportedLocale,
  localeOrOptions?:
    | SupportedLocale
    | (Intl.RelativeTimeFormatOptions & { readonly now?: Date }),
  maybeOptions?: Intl.RelativeTimeFormatOptions,
): string {
  if (valueOrDate instanceof Date) {
    if (Number.isNaN(valueOrDate.getTime())) return "—";
    const resolvedLocale =
      typeof unitOrLocale === "string"
        ? (unitOrLocale as SupportedLocale)
        : DEFAULT_LOCALE;
    const opts =
      typeof localeOrOptions === "object" && localeOrOptions !== null
        ? localeOrOptions
        : undefined;
    const now = opts?.now ?? new Date();
    const { now: _ignoredNow, ...intlOpts } = opts ?? {};
    void _ignoredNow;
    const delta = resolveRelativeDelta(valueOrDate, now);
    return formatRelativeTime(
      delta.value,
      delta.unit,
      resolvedLocale,
      intlOpts,
    );
  }

  if (!Number.isFinite(valueOrDate)) return "—";
  const unit = (unitOrLocale as Intl.RelativeTimeFormatUnit) ?? "second";
  const resolvedLocale =
    typeof localeOrOptions === "string" ? localeOrOptions : DEFAULT_LOCALE;
  const bcp47 = getLocaleMetadata(resolvedLocale).bcp47;

  try {
    return new Intl.RelativeTimeFormat(bcp47, {
      numeric: "auto",
      ...maybeOptions,
    }).format(valueOrDate, unit);
  } catch {
    return `${valueOrDate} ${unit}`;
  }
}

export interface BoundI18nFormatters {
  readonly formatDate: (
    value: Date | string | number,
    options?: DateTimeFormatOptionsWithFallback,
  ) => string;
  readonly formatTime: (
    value: Date | string | number,
    options?: DateTimeFormatOptionsWithFallback,
  ) => string;
  readonly formatDateTime: (
    value: Date | string | number,
    options?: DateTimeFormatOptionsWithFallback,
  ) => string;
  readonly formatNumber: (
    value: number,
    options?: Intl.NumberFormatOptions,
  ) => string;
  readonly formatPercent: (
    value: number,
    options?: PercentFormatOptions,
  ) => string;
  readonly formatDuration: (
    totalSeconds: number,
    options?: { readonly style?: "long" | "short" | "narrow" },
  ) => string;
  readonly formatRelativeTime: (
    value: number | Date,
    unitOrOptions?:
      | Intl.RelativeTimeFormatUnit
      | (Intl.RelativeTimeFormatOptions & { readonly now?: Date }),
    options?: Intl.RelativeTimeFormatOptions,
  ) => string;
  readonly formatList: (
    items: readonly string[],
    options?: {
      readonly type?: "conjunction" | "disjunction" | "unit";
      readonly style?: "long" | "short" | "narrow";
    },
  ) => string;
}

export function createI18nFormatter(
  locale: SupportedLocale,
): BoundI18nFormatters {
  return {
    formatDate: (value, options) => formatDate(value, locale, options),
    formatTime: (value, options) => formatTime(value, locale, options),
    formatDateTime: (value, options) => formatDateTime(value, locale, options),
    formatNumber: (value, options) => formatNumber(value, locale, options),
    formatPercent: (value, options) => formatPercent(value, locale, options),
    formatDuration: (totalSeconds, options) =>
      formatDuration(totalSeconds, locale, options),
    formatRelativeTime: (value, unitOrOptions, options) => {
      if (value instanceof Date) {
        const opts =
          typeof unitOrOptions === "object" && unitOrOptions !== null
            ? unitOrOptions
            : undefined;
        return formatRelativeTime(value, locale, opts);
      }
      const unit = typeof unitOrOptions === "string" ? unitOrOptions : "second";
      return formatRelativeTime(value, unit, locale, options);
    },
    formatList: (items, options) => formatList(items, locale, options),
  };
}
