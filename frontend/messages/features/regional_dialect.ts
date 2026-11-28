"use client";

import { useCallback } from "react";

import { useI18n } from "@/hooks/use-i18n";
import type { TranslationParams } from "@/lib/i18n/types";

import {
  regionalDialectEn,
  regionalDialectVi,
  type RegionalDialectMessageKey,
} from "./regional_dialect_messages";

export { regionalDialectEn, regionalDialectVi, type RegionalDialectMessageKey };

function interpolateFallback(
  template: string,
  params?: TranslationParams,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, token: string) => {
    const val = params[token];
    return val === undefined || val === null ? "" : String(val);
  });
}

export function useRegionalDialectTranslations() {
  const { t, locale } = useI18n();
  return useCallback(
    (key: RegionalDialectMessageKey, params?: TranslationParams): string => {
      const baseDict = locale === "en" ? regionalDialectEn : regionalDialectVi;
      const fallback = interpolateFallback(baseDict[key], params);
      return t(`regionalDialect.${key}`, params, fallback);
    },
    [locale, t],
  );
}
