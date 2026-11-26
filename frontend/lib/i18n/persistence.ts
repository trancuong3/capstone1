import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  LOCALE_COOKIE_OWNER_STORAGE_KEY,
  LOCALE_GUEST_STORAGE_KEY,
  LOCALE_USER_STORAGE_PREFIX,
  normalizeLocale,
  resolveLocalePriority,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function getUserLocaleStorageKey(userId: string): string {
  return `${LOCALE_USER_STORAGE_PREFIX}${userId}`;
}

export function readLocaleCookie(): SupportedLocale | null {
  if (typeof document === "undefined") return null;
  const rawCookie = document.cookie ?? "";
  if (!rawCookie) return null;

  const segments = rawCookie.split(";");
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = trimmed.slice(0, eqIndex).trim();
    if (name !== LOCALE_COOKIE_NAME) continue;
    const rawValue = trimmed.slice(eqIndex + 1).trim();
    try {
      return normalizeLocale(decodeURIComponent(rawValue));
    } catch {
      return normalizeLocale(rawValue);
    }
  }
  return null;
}

export function writeLocaleCookie(locale: SupportedLocale): void {
  if (typeof document === "undefined") return;
  const isHttps =
    typeof window !== "undefined" && window.location?.protocol === "https:";
  const secureFlag = isHttps ? "; Secure" : "";
  document.cookie = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secureFlag}`;
}

function safeReadLocalStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWriteLocalStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota or private-browsing failures.
  }
}

function safeRemoveLocalStorage(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage restrictions.
  }
}

export function readUserLocalePreference(
  userId: string | null | undefined,
): SupportedLocale | null {
  const normalizedUserId = userId?.trim();
  if (!normalizedUserId) return null;
  return normalizeLocale(
    safeReadLocalStorage(getUserLocaleStorageKey(normalizedUserId)),
  );
}

export function writeUserLocalePreference(
  userId: string,
  locale: SupportedLocale,
): void {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return;
  safeWriteLocalStorage(getUserLocaleStorageKey(normalizedUserId), locale);
}

export function readGuestLocalePreference(): SupportedLocale | null {
  return normalizeLocale(safeReadLocalStorage(LOCALE_GUEST_STORAGE_KEY));
}

export function writeGuestLocalePreference(locale: SupportedLocale): void {
  safeWriteLocalStorage(LOCALE_GUEST_STORAGE_KEY, locale);
}

export function hasSupabaseClientConfig(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
  );
}

export interface PersistLocaleOptions {
  readonly userId?: string | null;
  readonly onPersistUserLocale?: (
    locale: SupportedLocale,
  ) => Promise<void> | void;
}

export async function persistLocalePreference(
  locale: SupportedLocale,
  options: PersistLocaleOptions = {},
): Promise<void> {
  const normalizedUserId = options.userId?.trim() || null;

  writeLocaleCookie(locale);

  if (normalizedUserId) {
    writeUserLocalePreference(normalizedUserId, locale);
    safeWriteLocalStorage(LOCALE_COOKIE_OWNER_STORAGE_KEY, normalizedUserId);
  } else {
    writeGuestLocalePreference(locale);
    safeRemoveLocalStorage(LOCALE_COOKIE_OWNER_STORAGE_KEY);
  }

  if (normalizedUserId && options.onPersistUserLocale) {
    try {
      await options.onPersistUserLocale(locale);
    } catch {
      // Local persistence already succeeded; remote sync failure must not crash UI.
    }
    return;
  }

  if (normalizedUserId && hasSupabaseClientConfig()) {
    try {
      const supabase = createBrowserSupabaseClient();
      if (typeof supabase?.auth?.updateUser === "function") {
        await supabase.auth.updateUser({
          data: { preferred_locale: locale },
        });
      }
    } catch {
      // Never throw if Supabase client is mocked or offline.
    }
  }
}

export interface ResolveAccountClientLocaleInput {
  readonly userId?: string | null;
  readonly accountLocale?: unknown;
  readonly accountUserId?: string | null;
  readonly fallbackLocale?: SupportedLocale;
}

/**
 * Resolves the effective locale on the client during mount/account switches,
 * strictly isolating Account A's persisted choice from Account B or guest state.
 */
export function resolveAccountClientLocale(
  input: ResolveAccountClientLocaleInput,
): SupportedLocale {
  const normalizedUserId = input.userId?.trim() || null;
  const savedUserStorageLocale = readUserLocalePreference(normalizedUserId);
  const metadataAccountLocale = normalizeLocale(input.accountLocale);
  const matchingAccountUserId =
    input.accountUserId === undefined
      ? normalizedUserId
      : input.accountUserId?.trim() || null;

  const accountLocale =
    savedUserStorageLocale ??
    (normalizedUserId &&
    matchingAccountUserId &&
    normalizedUserId === matchingAccountUserId
      ? metadataAccountLocale
      : null);

  const cookieOwner = safeReadLocalStorage(LOCALE_COOKIE_OWNER_STORAGE_KEY);
  const rawCookieLocale = readLocaleCookie();

  // Do not let another authenticated account's cookie bleed into a new account
  // or signed-out state when that account has no saved preference yet.
  const isolatedDeviceLocale =
    cookieOwner && cookieOwner !== normalizedUserId
      ? readGuestLocalePreference()
      : (rawCookieLocale ?? readGuestLocalePreference());

  return resolveLocalePriority({
    accountLocale,
    accountUserId: normalizedUserId,
    activeUserId: normalizedUserId,
    deviceLocale:
      isolatedDeviceLocale ?? input.fallbackLocale ?? DEFAULT_LOCALE,
  });
}
