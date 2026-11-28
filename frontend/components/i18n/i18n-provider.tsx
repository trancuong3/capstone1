"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import {
  createI18nFormatter,
  translateMessage,
  type BoundI18nFormatters,
} from "@/lib/i18n/formatter";
import {
  DEFAULT_LOCALE,
  getAllLocales,
  getLocaleDirection,
  getLocaleMetadata,
  getPublishedLocales,
  normalizeLocale,
  type LocaleMetadata,
  type SupportedLocale,
  type TextDirection,
} from "@/lib/i18n/locales";
import {
  hasSupabaseClientConfig,
  persistLocalePreference,
  resolveAccountClientLocale,
} from "@/lib/i18n/persistence";
import type {
  MessagesDictionary,
  TranslateFn,
  TranslationParams,
} from "@/lib/i18n/types";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  getCachedLocaleMessages,
  loadLocaleMessages,
  withCachedRuntimeNamespaces,
  type LocaleBundleLoader,
} from "@/messages/loader";
import { viMessages } from "@/messages/vi";

export const VIREAD_AUTH_SYNC_EVENT = "viread:i18n-auth-sync" as const;

export interface I18nAuthSyncDetail {
  readonly userId: string | null;
  readonly preferredLocale?: string | null;
}

export function dispatchI18nAuthSync(detail: I18nAuthSyncDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<I18nAuthSyncDetail>(VIREAD_AUTH_SYNC_EVENT, { detail }),
  );
}

export interface I18nContextValue extends BoundI18nFormatters {
  readonly locale: SupportedLocale;
  readonly dir: TextDirection;
  readonly metadata: LocaleMetadata;
  readonly messages: MessagesDictionary;
  readonly isLoadingLocale: boolean;
  readonly t: TranslateFn;
  readonly setLocale: (nextLocale: string) => Promise<SupportedLocale>;
  readonly availableLocales: readonly LocaleMetadata[];
  readonly publishedLocales: readonly LocaleMetadata[];
}

const defaultFormatter = createI18nFormatter(DEFAULT_LOCALE);

const defaultI18nContextValue: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  dir: getLocaleDirection(DEFAULT_LOCALE),
  metadata: getLocaleMetadata(DEFAULT_LOCALE),
  messages: viMessages,
  isLoadingLocale: false,
  t: (
    key: string,
    params?: TranslationParams,
    defaultValue?: string,
  ): string => {
    const dictionary = withCachedRuntimeNamespaces(DEFAULT_LOCALE, viMessages);
    return translateMessage(
      dictionary,
      dictionary,
      DEFAULT_LOCALE,
      key,
      params,
      defaultValue,
    );
  },
  setLocale: async (nextLocale: string) =>
    normalizeLocale(nextLocale) ?? DEFAULT_LOCALE,
  ...defaultFormatter,
  availableLocales: getAllLocales(),
  publishedLocales: getPublishedLocales(),
};

export const I18nContext = createContext<I18nContextValue>(
  defaultI18nContextValue,
);

export interface I18nProviderProps {
  readonly children: ReactNode;
  readonly initialLocale?: SupportedLocale;
  readonly initialMessages?: MessagesDictionary;
  readonly userId?: string | null;
  readonly accountLocale?: string | null;
  readonly loadMessages?: (
    locale: SupportedLocale,
  ) => Promise<MessagesDictionary>;
  readonly onPersistUserLocale?: (
    locale: SupportedLocale,
  ) => Promise<void> | void;
}

function syncDocumentAttributes(locale: SupportedLocale): void {
  if (typeof document === "undefined") return;
  const meta = getLocaleMetadata(locale);
  document.documentElement.lang = meta.bcp47;
  document.documentElement.dir = meta.dir;
}

function readSupabaseUserPreferredLocale(
  user: { readonly user_metadata?: Record<string, unknown> } | null | undefined,
): string | null {
  const value = user?.user_metadata?.preferred_locale;
  return typeof value === "string" ? value : null;
}

export function I18nProvider({
  children,
  initialLocale = DEFAULT_LOCALE,
  initialMessages = viMessages,
  userId: propUserId,
  accountLocale: propAccountLocale,
  loadMessages: customLoadMessages,
  onPersistUserLocale,
}: I18nProviderProps) {
  const authRuntime = useContext(AuthRuntimeContext);
  const router = useRouter();
  const [supabaseIdentity, setSupabaseIdentity] = useState<{
    readonly userId: string | null;
    readonly accountLocale: string | null;
  } | null>(null);

  const effectiveUserId =
    propUserId !== undefined
      ? propUserId
      : authRuntime.hasProvider
        ? (authRuntime.session?.user?.id ?? null)
        : (supabaseIdentity?.userId ?? null);

  const effectiveAccountLocale =
    propAccountLocale !== undefined
      ? propAccountLocale
      : (supabaseIdentity?.accountLocale ?? null);

  const [localeState, setLocaleState] = useState<{
    readonly locale: SupportedLocale;
    readonly messages: MessagesDictionary;
  }>(() => ({
    locale: initialLocale,
    messages: initialMessages,
  }));
  const [isLoadingLocale, setIsLoadingLocale] = useState(false);

  const localeRef = useRef<SupportedLocale>(initialLocale);
  const requestIdRef = useRef(0);
  const previousUserIdRef = useRef<string | null | undefined>(undefined);
  const mountedRef = useRef(true);

  const resolveBundle = useCallback(
    async (targetLocale: SupportedLocale): Promise<MessagesDictionary> => {
      if (customLoadMessages) {
        try {
          return await customLoadMessages(targetLocale);
        } catch {
          return viMessages;
        }
      }
      const loader: LocaleBundleLoader = () => loadLocaleMessages(targetLocale);
      return loader();
    },
    [customLoadMessages],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    syncDocumentAttributes(localeState.locale);
    localeRef.current = localeState.locale;
  }, [localeState.locale]);

  // If SSR trimmed the heavy `admin` namespace for a non-default locale on a
  // parent/public page, hydrate the full client locale chunk lazily in the
  // background so admin or GlobalTaskCenter labels remain localized.
  useEffect(() => {
    if (
      customLoadMessages ||
      localeState.locale === DEFAULT_LOCALE ||
      "admin" in localeState.messages
    ) {
      return;
    }
    let active = true;
    const targetLocale = localeState.locale;
    void loadLocaleMessages(targetLocale).then((fullBundle) => {
      if (
        !active ||
        !mountedRef.current ||
        localeRef.current !== targetLocale
      ) {
        return;
      }
      setLocaleState((prev) =>
        prev.locale === targetLocale && !("admin" in prev.messages)
          ? { locale: targetLocale, messages: fullBundle }
          : prev,
      );
    });
    return () => {
      active = false;
    };
  }, [customLoadMessages, localeState.locale, localeState.messages]);

  useEffect(() => {
    function handleAuthSyncEvent(event: Event) {
      const detail = (event as CustomEvent<I18nAuthSyncDetail>).detail;
      if (!detail || typeof detail !== "object") return;
      setSupabaseIdentity({
        userId: detail.userId ?? null,
        accountLocale: detail.preferredLocale ?? null,
      });
    }

    window.addEventListener(VIREAD_AUTH_SYNC_EVENT, handleAuthSyncEvent);

    let unsubscribe: (() => void) | undefined;
    if (
      propUserId === undefined &&
      !authRuntime.hasProvider &&
      hasSupabaseClientConfig()
    ) {
      try {
        const supabase = createBrowserSupabaseClient();
        if (typeof supabase?.auth?.onAuthStateChange === "function") {
          const { data } = supabase.auth.onAuthStateChange(
            (_event, session) => {
              if (!mountedRef.current) return;
              setSupabaseIdentity({
                userId: session?.user?.id ?? null,
                accountLocale: readSupabaseUserPreferredLocale(session?.user),
              });
            },
          );
          unsubscribe = () => data.subscription.unsubscribe();
        }
        if (typeof supabase?.auth?.getSession === "function") {
          void supabase.auth
            .getSession()
            .then(({ data }) => {
              if (!mountedRef.current) return;
              const session = data?.session;
              if (session?.user?.id) {
                setSupabaseIdentity({
                  userId: session.user.id,
                  accountLocale: readSupabaseUserPreferredLocale(session.user),
                });
              }
            })
            .catch(() => {
              // Ignore passive session check failures.
            });
        }
      } catch {
        // Ignore unconfigured Supabase client environments.
      }
    }

    return () => {
      window.removeEventListener(VIREAD_AUTH_SYNC_EVENT, handleAuthSyncEvent);
      unsubscribe?.();
    };
  }, [authRuntime.hasProvider, propUserId]);

  useEffect(() => {
    const previousUserId = previousUserIdRef.current;
    const normalizedUserId = effectiveUserId?.trim() || null;

    if (previousUserId === undefined) {
      previousUserIdRef.current = normalizedUserId;
      if (!normalizedUserId && !effectiveAccountLocale) {
        return;
      }
    } else if (previousUserId === normalizedUserId && !effectiveAccountLocale) {
      return;
    }

    previousUserIdRef.current = normalizedUserId;

    const targetLocale = resolveAccountClientLocale({
      userId: normalizedUserId,
      accountLocale: effectiveAccountLocale,
      accountUserId: normalizedUserId,
      fallbackLocale: DEFAULT_LOCALE,
    });

    if (targetLocale === localeRef.current) {
      return;
    }

    const requestId = ++requestIdRef.current;
    const cached = !customLoadMessages
      ? getCachedLocaleMessages(targetLocale)
      : null;

    let active = true;
    async function applyAccountLocale() {
      const nextMessages = cached ?? (await resolveBundle(targetLocale));
      if (
        !active ||
        !mountedRef.current ||
        requestId !== requestIdRef.current
      ) {
        return;
      }
      localeRef.current = targetLocale;
      syncDocumentAttributes(targetLocale);
      setLocaleState({ locale: targetLocale, messages: nextMessages });
    }

    void applyAccountLocale();
    return () => {
      active = false;
    };
  }, [
    customLoadMessages,
    effectiveAccountLocale,
    effectiveUserId,
    resolveBundle,
  ]);

  const setLocale = useCallback(
    async (rawNextLocale: string): Promise<SupportedLocale> => {
      const normalized = normalizeLocale(rawNextLocale);
      if (!normalized) {
        return localeRef.current;
      }

      const previousLocale = localeRef.current;
      const requestId = ++requestIdRef.current;
      const cached = !customLoadMessages
        ? getCachedLocaleMessages(normalized)
        : null;

      if (cached) {
        localeRef.current = normalized;
        syncDocumentAttributes(normalized);
        setLocaleState({ locale: normalized, messages: cached });
        setIsLoadingLocale(false);
        await persistLocalePreference(normalized, {
          userId: effectiveUserId,
          onPersistUserLocale,
        });
        if (previousLocale !== normalized && typeof window !== "undefined") {
          router.refresh();
        }
        return normalized;
      }

      setIsLoadingLocale(true);
      try {
        const nextMessages = await resolveBundle(normalized);
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return localeRef.current;
        }
        localeRef.current = normalized;
        syncDocumentAttributes(normalized);
        setLocaleState({ locale: normalized, messages: nextMessages });
        await persistLocalePreference(normalized, {
          userId: effectiveUserId,
          onPersistUserLocale,
        });
        if (previousLocale !== normalized && typeof window !== "undefined") {
          router.refresh();
        }
        return normalized;
      } finally {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setIsLoadingLocale(false);
        }
      }
    },
    [
      customLoadMessages,
      effectiveUserId,
      onPersistUserLocale,
      resolveBundle,
      router,
    ],
  );

  const value = useMemo<I18nContextValue>(() => {
    const metadata = getLocaleMetadata(localeState.locale);
    const formatter = createI18nFormatter(localeState.locale);

    return {
      locale: localeState.locale,
      dir: metadata.dir,
      metadata,
      messages: localeState.messages,
      isLoadingLocale,
      t: (key, params, defaultValue) =>
        translateMessage(
          withCachedRuntimeNamespaces(localeState.locale, localeState.messages),
          withCachedRuntimeNamespaces(DEFAULT_LOCALE, viMessages),
          localeState.locale,
          key,
          params,
          defaultValue,
        ),
      setLocale,
      ...formatter,
      availableLocales: getAllLocales(),
      publishedLocales: getPublishedLocales(),
    };
  }, [isLoadingLocale, localeState.locale, localeState.messages, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
