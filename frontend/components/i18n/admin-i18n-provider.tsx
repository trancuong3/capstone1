"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  I18nContext,
  type I18nContextValue,
} from "@/components/i18n/i18n-provider";
import { translateMessage } from "@/lib/i18n/formatter";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales";
import type { MessageTree, MessagesDictionary } from "@/lib/i18n/types";
import {
  getCachedAdminLocaleMessages,
  loadAdminLocaleMessages,
  seedAdminLocaleCache,
} from "@/messages/admin-loader";
import { viMessages } from "@/messages/vi";

export interface AdminI18nProviderProps {
  readonly children: ReactNode;
  readonly initialLocale: SupportedLocale;
  readonly initialAdminMessages: MessageTree;
  readonly viAdminMessages?: MessageTree;
}

export function AdminI18nProvider({
  children,
  initialLocale,
  initialAdminMessages,
  viAdminMessages,
}: AdminI18nProviderProps) {
  const parent = useContext(I18nContext);
  const resolvedViAdmin = viAdminMessages ?? initialAdminMessages;

  const [adminByLocale, setAdminByLocale] = useState<
    Readonly<Partial<Record<SupportedLocale, MessageTree>>>
  >(() => {
    // Seed synchronously on initial render/SSR (idempotent) so first-render
    // translateRuntime("admin.*") calls never flash raw translation keys.
    seedAdminLocaleCache(initialLocale, initialAdminMessages);
    seedAdminLocaleCache(DEFAULT_LOCALE, resolvedViAdmin);
    return {
      [initialLocale]: initialAdminMessages,
      [DEFAULT_LOCALE]: resolvedViAdmin,
    };
  });

  useEffect(() => {
    seedAdminLocaleCache(initialLocale, initialAdminMessages);
    seedAdminLocaleCache(DEFAULT_LOCALE, resolvedViAdmin);
  }, [initialAdminMessages, initialLocale, resolvedViAdmin]);

  const activeLocale = parent.locale;
  const cachedActive = getCachedAdminLocaleMessages(activeLocale);
  const activeAdminMessages =
    adminByLocale[activeLocale] ??
    cachedActive ??
    (activeLocale === initialLocale ? initialAdminMessages : resolvedViAdmin);

  useEffect(() => {
    if (adminByLocale[activeLocale]) {
      return;
    }
    const cached = getCachedAdminLocaleMessages(activeLocale);
    if (cached) {
      let active = true;
      queueMicrotask(() => {
        if (!active) return;
        setAdminByLocale((prev) =>
          prev[activeLocale] ? prev : { ...prev, [activeLocale]: cached },
        );
      });
      return () => {
        active = false;
      };
    }

    let active = true;
    void loadAdminLocaleMessages(activeLocale).then((loaded) => {
      if (!active) return;
      setAdminByLocale((prev) => ({ ...prev, [activeLocale]: loaded }));
    });
    return () => {
      active = false;
    };
  }, [activeLocale, adminByLocale]);

  const localeRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const latestParentLocaleRef = useRef(parent.locale);

  useEffect(() => {
    latestParentLocaleRef.current = parent.locale;
  }, [parent.locale]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const parentSetLocale = parent.setLocale;

  const setLocale = useCallback(
    async (rawNextLocale: string): Promise<SupportedLocale> => {
      const normalized = normalizeLocale(rawNextLocale);
      if (!normalized) {
        return latestParentLocaleRef.current;
      }

      const requestId = ++localeRequestIdRef.current;
      const loaded = await loadAdminLocaleMessages(normalized);
      if (!mountedRef.current || requestId !== localeRequestIdRef.current) {
        return latestParentLocaleRef.current;
      }

      setAdminByLocale((prev) =>
        prev[normalized] === loaded ? prev : { ...prev, [normalized]: loaded },
      );

      return parentSetLocale(rawNextLocale);
    },
    [parentSetLocale],
  );

  const value = useMemo<I18nContextValue>(() => {
    const mergedMessages: MessagesDictionary = {
      ...parent.messages,
      admin: activeAdminMessages,
    };
    const fallbackMessages: MessagesDictionary = {
      ...viMessages,
      admin: resolvedViAdmin,
    };

    return {
      ...parent,
      messages: mergedMessages,
      setLocale,
      t: (key, params, defaultValue) =>
        translateMessage(
          mergedMessages,
          fallbackMessages,
          parent.locale,
          key,
          params,
          defaultValue,
        ),
    };
  }, [activeAdminMessages, parent, resolvedViAdmin, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
