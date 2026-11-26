"use client";

import { useCallback, useContext } from "react";

import {
  I18nContext,
  type I18nContextValue,
} from "@/components/i18n/i18n-provider";
import type {
  I18nNamespace,
  TranslateFn,
  TranslationParams,
} from "@/lib/i18n/types";

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function useTranslations(namespace?: I18nNamespace): TranslateFn {
  const { t } = useI18n();

  return useCallback(
    (key: string, params?: TranslationParams, defaultValue?: string) => {
      if (!namespace) {
        return t(key, params, defaultValue);
      }
      const qualifiedKey = key.includes(":")
        ? key
        : key.startsWith(`${namespace}.`)
          ? key
          : `${namespace}.${key}`;
      return t(qualifiedKey, params, defaultValue);
    },
    [namespace, t],
  );
}
