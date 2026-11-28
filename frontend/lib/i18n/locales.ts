export const DEFAULT_LOCALE = "vi" as const;
export const LOCALE_COOKIE_NAME = "viread_locale" as const;
export const LOCALE_USER_STORAGE_PREFIX = "viread:locale:user:" as const;
export const LOCALE_GUEST_STORAGE_KEY = "viread:locale:guest" as const;
export const LOCALE_COOKIE_OWNER_STORAGE_KEY =
  "viread:locale:cookie_owner" as const;

export type TextDirection = "ltr" | "rtl";
export type LocaleTranslationStatus =
  "complete" | "beta" | "needs_review" | "incomplete";

export type LocaleRegionGroup =
  | "southeast-asia"
  | "east-asia"
  | "south-asia"
  | "europe"
  | "middle-east"
  | "global";

export const SUPPORTED_LOCALE_CODES = [
  "vi",
  "en",
  "zh-Hans",
  "zh-Hant",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "pt",
  "it",
  "ru",
  "th",
  "id",
  "ms",
  "fil",
  "hi",
  "bn",
  "ar",
  "tr",
  "nl",
  "sv",
  "pl",
  "uk",
  "el",
  "he",
  "km",
  "lo",
  "my",
  "ne",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALE_CODES)[number];

export interface LocaleMetadata {
  readonly code: SupportedLocale;
  readonly bcp47: string;
  readonly nativeName: string;
  readonly englishName: string;
  readonly dir: TextDirection;
  readonly popular: boolean;
  readonly regionGroup: LocaleRegionGroup;
  readonly status: LocaleTranslationStatus;
  readonly published: boolean;
}

/**
 * Extensible locale registry. Published locales have verified 100% key coverage
 * (`6,186/6,186`) and pass `i18n:check --strict` with zero errors.
 * Unfinished locales remain `status: "incomplete", published: false`.
 */
export const LOCALE_REGISTRY: readonly LocaleMetadata[] = [
  {
    code: "vi",
    bcp47: "vi",
    nativeName: "Tiếng Việt",
    englishName: "Vietnamese",
    dir: "ltr",
    popular: true,
    regionGroup: "southeast-asia",
    status: "complete",
    published: true,
  },
  {
    code: "en",
    bcp47: "en",
    nativeName: "English",
    englishName: "English",
    dir: "ltr",
    popular: true,
    regionGroup: "global",
    status: "complete",
    published: true,
  },
  {
    code: "zh-Hans",
    bcp47: "zh-Hans",
    nativeName: "简体中文",
    englishName: "Chinese (Simplified)",
    dir: "ltr",
    popular: true,
    regionGroup: "east-asia",
    status: "beta",
    published: true,
  },
  {
    code: "zh-Hant",
    bcp47: "zh-Hant",
    nativeName: "繁體中文",
    englishName: "Chinese (Traditional)",
    dir: "ltr",
    popular: true,
    regionGroup: "east-asia",
    status: "beta",
    published: true,
  },
  {
    code: "ja",
    bcp47: "ja",
    nativeName: "日本語",
    englishName: "Japanese",
    dir: "ltr",
    popular: true,
    regionGroup: "east-asia",
    status: "beta",
    published: true,
  },
  {
    code: "ko",
    bcp47: "ko",
    nativeName: "한국어",
    englishName: "Korean",
    dir: "ltr",
    popular: true,
    regionGroup: "east-asia",
    status: "beta",
    published: true,
  },
  {
    code: "fr",
    bcp47: "fr",
    nativeName: "Français",
    englishName: "French",
    dir: "ltr",
    popular: true,
    regionGroup: "europe",
    status: "beta",
    published: true,
  },
  {
    code: "de",
    bcp47: "de",
    nativeName: "Deutsch",
    englishName: "German",
    dir: "ltr",
    popular: true,
    regionGroup: "europe",
    status: "beta",
    published: true,
  },
  {
    code: "es",
    bcp47: "es",
    nativeName: "Español",
    englishName: "Spanish",
    dir: "ltr",
    popular: true,
    regionGroup: "global",
    status: "beta",
    published: true,
  },
  {
    code: "pt",
    bcp47: "pt",
    nativeName: "Português",
    englishName: "Portuguese",
    dir: "ltr",
    popular: false,
    regionGroup: "global",
    status: "incomplete",
    published: false,
  },
  {
    code: "it",
    bcp47: "it",
    nativeName: "Italiano",
    englishName: "Italian",
    dir: "ltr",
    popular: false,
    regionGroup: "europe",
    status: "incomplete",
    published: false,
  },
  {
    code: "ru",
    bcp47: "ru",
    nativeName: "Русский",
    englishName: "Russian",
    dir: "ltr",
    popular: false,
    regionGroup: "europe",
    status: "incomplete",
    published: false,
  },
  {
    code: "th",
    bcp47: "th",
    nativeName: "ไทย",
    englishName: "Thai",
    dir: "ltr",
    popular: true,
    regionGroup: "southeast-asia",
    status: "incomplete",
    published: false,
  },
  {
    code: "id",
    bcp47: "id",
    nativeName: "Bahasa Indonesia",
    englishName: "Indonesian",
    dir: "ltr",
    popular: false,
    regionGroup: "southeast-asia",
    status: "incomplete",
    published: false,
  },
  {
    code: "ms",
    bcp47: "ms",
    nativeName: "Bahasa Melayu",
    englishName: "Malay",
    dir: "ltr",
    popular: false,
    regionGroup: "southeast-asia",
    status: "incomplete",
    published: false,
  },
  {
    code: "fil",
    bcp47: "fil",
    nativeName: "Filipino",
    englishName: "Filipino",
    dir: "ltr",
    popular: false,
    regionGroup: "southeast-asia",
    status: "incomplete",
    published: false,
  },
  {
    code: "hi",
    bcp47: "hi",
    nativeName: "हिन्दी",
    englishName: "Hindi",
    dir: "ltr",
    popular: false,
    regionGroup: "south-asia",
    status: "incomplete",
    published: false,
  },
  {
    code: "bn",
    bcp47: "bn",
    nativeName: "বাংলা",
    englishName: "Bengali",
    dir: "ltr",
    popular: false,
    regionGroup: "south-asia",
    status: "incomplete",
    published: false,
  },
  {
    code: "ar",
    bcp47: "ar",
    nativeName: "العربية",
    englishName: "Arabic",
    dir: "rtl",
    popular: true,
    regionGroup: "middle-east",
    status: "beta",
    published: true,
  },
  {
    code: "tr",
    bcp47: "tr",
    nativeName: "Türkçe",
    englishName: "Turkish",
    dir: "ltr",
    popular: false,
    regionGroup: "middle-east",
    status: "incomplete",
    published: false,
  },
  {
    code: "nl",
    bcp47: "nl",
    nativeName: "Nederlands",
    englishName: "Dutch",
    dir: "ltr",
    popular: false,
    regionGroup: "europe",
    status: "incomplete",
    published: false,
  },
  {
    code: "sv",
    bcp47: "sv",
    nativeName: "Svenska",
    englishName: "Swedish",
    dir: "ltr",
    popular: false,
    regionGroup: "europe",
    status: "incomplete",
    published: false,
  },
  {
    code: "pl",
    bcp47: "pl",
    nativeName: "Polski",
    englishName: "Polish",
    dir: "ltr",
    popular: false,
    regionGroup: "europe",
    status: "incomplete",
    published: false,
  },
  {
    code: "uk",
    bcp47: "uk",
    nativeName: "Українська",
    englishName: "Ukrainian",
    dir: "ltr",
    popular: false,
    regionGroup: "europe",
    status: "incomplete",
    published: false,
  },
  {
    code: "el",
    bcp47: "el",
    nativeName: "Ελληνικά",
    englishName: "Greek",
    dir: "ltr",
    popular: false,
    regionGroup: "europe",
    status: "incomplete",
    published: false,
  },
  {
    code: "he",
    bcp47: "he",
    nativeName: "עברית",
    englishName: "Hebrew",
    dir: "rtl",
    popular: false,
    regionGroup: "middle-east",
    status: "beta",
    published: true,
  },
  {
    code: "km",
    bcp47: "km",
    nativeName: "ភាសាខ្មែរ",
    englishName: "Khmer",
    dir: "ltr",
    popular: false,
    regionGroup: "southeast-asia",
    status: "incomplete",
    published: false,
  },
  {
    code: "lo",
    bcp47: "lo",
    nativeName: "ລາວ",
    englishName: "Lao",
    dir: "ltr",
    popular: false,
    regionGroup: "southeast-asia",
    status: "incomplete",
    published: false,
  },
  {
    code: "my",
    bcp47: "my",
    nativeName: "မြန်မာ",
    englishName: "Burmese",
    dir: "ltr",
    popular: false,
    regionGroup: "southeast-asia",
    status: "incomplete",
    published: false,
  },
  {
    code: "ne",
    bcp47: "ne",
    nativeName: "नेपाली",
    englishName: "Nepali",
    dir: "ltr",
    popular: false,
    regionGroup: "south-asia",
    status: "incomplete",
    published: false,
  },
];

const LOCALE_METADATA_MAP: ReadonlyMap<SupportedLocale, LocaleMetadata> =
  new Map(LOCALE_REGISTRY.map((entry) => [entry.code, entry]));

const CANONICAL_LOWERCASE_MAP: ReadonlyMap<string, SupportedLocale> = new Map(
  LOCALE_REGISTRY.map((entry) => [entry.code.toLowerCase(), entry.code]),
);

const LOCALE_ALIAS_MAP: ReadonlyMap<string, SupportedLocale> = new Map([
  ["zh", "zh-Hans"],
  ["zh-cn", "zh-Hans"],
  ["zh-sg", "zh-Hans"],
  ["zh-hans", "zh-Hans"],
  ["zh-hans-cn", "zh-Hans"],
  ["zh-hans-sg", "zh-Hans"],
  ["zh-tw", "zh-Hant"],
  ["zh-hk", "zh-Hant"],
  ["zh-mo", "zh-Hant"],
  ["zh-hant", "zh-Hant"],
  ["zh-hant-tw", "zh-Hant"],
  ["zh-hant-hk", "zh-Hant"],
  ["zh-hant-mo", "zh-Hant"],
  ["iw", "he"],
  ["iw-il", "he"],
  ["he-il", "he"],
  ["in", "id"],
  ["in-id", "id"],
  ["tl", "fil"],
  ["tl-ph", "fil"],
]);

const SAFE_LOCALE_INPUT_PATTERN = /^[A-Za-z0-9_-]{2,32}$/;
const STRICT_BCP47_SUBTAG_PATTERN =
  /^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?$/;

/**
 * Strictly normalizes a raw locale value against the ViRead allowlist.
 * Rejects path traversal, XSS payloads, control characters, and unsupported
 * tags by returning `null`.
 */
export function normalizeLocale(raw: unknown): SupportedLocale | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 32) return null;
  if (!SAFE_LOCALE_INPUT_PATTERN.test(trimmed)) return null;

  const lower = trimmed.replaceAll("_", "-").toLowerCase();

  const exact = CANONICAL_LOWERCASE_MAP.get(lower);
  if (exact) return exact;

  const aliased = LOCALE_ALIAS_MAP.get(lower);
  if (aliased) return aliased;

  if (!STRICT_BCP47_SUBTAG_PATTERN.test(lower)) {
    return null;
  }

  const segments = lower.split("-");
  if (segments.length >= 2) {
    const langScript = `${segments[0]}-${segments[1]}`;
    const matchedScript =
      CANONICAL_LOWERCASE_MAP.get(langScript) ??
      LOCALE_ALIAS_MAP.get(langScript);
    if (matchedScript) return matchedScript;
  }

  const baseLang = segments[0];
  if (baseLang === "zh") {
    return null;
  }
  return (
    CANONICAL_LOWERCASE_MAP.get(baseLang) ??
    LOCALE_ALIAS_MAP.get(baseLang) ??
    null
  );
}

export function isSupportedLocale(raw: unknown): raw is SupportedLocale {
  const normalized = normalizeLocale(raw);
  return normalized !== null && normalized === raw;
}

export function getLocaleMetadata(locale: SupportedLocale): LocaleMetadata {
  return (
    LOCALE_METADATA_MAP.get(locale) ?? LOCALE_METADATA_MAP.get(DEFAULT_LOCALE)!
  );
}

export function isLocalePublished(locale: SupportedLocale): boolean {
  return getLocaleMetadata(locale).published;
}

export function getLocaleDirection(locale: SupportedLocale): TextDirection {
  return getLocaleMetadata(locale).dir;
}

export function getAllLocales(options?: {
  readonly publishedOnly?: boolean;
}): readonly LocaleMetadata[] {
  if (options?.publishedOnly) {
    return LOCALE_REGISTRY.filter((entry) => entry.published);
  }
  return LOCALE_REGISTRY;
}

export function getPublishedLocales(): readonly LocaleMetadata[] {
  return getAllLocales({ publishedOnly: true });
}

export function getPopularLocales(options?: {
  readonly publishedOnly?: boolean;
}): readonly LocaleMetadata[] {
  return getAllLocales(options).filter((entry) => entry.popular);
}

export interface LocaleResolutionInput {
  readonly explicitLocale?: unknown;
  readonly accountLocale?: unknown;
  readonly accountUserId?: string | null;
  readonly activeUserId?: string | null;
  readonly deviceLocale?: unknown;
  readonly publishedOnly?: boolean;
}

function acceptCandidate(
  raw: unknown,
  publishedOnly: boolean,
): SupportedLocale | null {
  const normalized = normalizeLocale(raw);
  if (!normalized) return null;
  if (publishedOnly && !isLocalePublished(normalized)) return null;
  return normalized;
}

/**
 * Resolves the effective locale using ViRead's strict priority order:
 * 1. Explicit user selection
 * 2. Saved account preference (only when `accountUserId` matches `activeUserId`)
 * 3. Valid device cookie / preference
 * 4. `DEFAULT_LOCALE` (`"vi"`)
 *
 * Browser `navigator.language`, `Accept-Language`, and IP geolocation are never used.
 */
export function resolveLocalePriority(
  input: LocaleResolutionInput = {},
): SupportedLocale {
  const publishedOnly = input.publishedOnly ?? false;

  const explicit = acceptCandidate(input.explicitLocale, publishedOnly);
  if (explicit) return explicit;

  const normalizedActiveId = input.activeUserId?.trim() || null;
  const normalizedAccountId = input.accountUserId?.trim() || null;
  if (
    normalizedActiveId &&
    normalizedAccountId &&
    normalizedActiveId === normalizedAccountId
  ) {
    const account = acceptCandidate(input.accountLocale, publishedOnly);
    if (account) return account;
  }

  const device = acceptCandidate(input.deviceLocale, publishedOnly);
  if (device) return device;

  return DEFAULT_LOCALE;
}
