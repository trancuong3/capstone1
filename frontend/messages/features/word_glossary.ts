"use client";

import { useCallback } from "react";

import { useI18n } from "@/hooks/use-i18n";
import { translateMessage } from "@/lib/i18n/formatter";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import type { TranslationParams } from "@/lib/i18n/types";

import {
  wordGlossaryEn,
  wordGlossaryVi,
  type WordGlossaryMessageKey,
} from "./word_glossary_messages";

export { wordGlossaryEn, wordGlossaryVi, type WordGlossaryMessageKey };

const fallbackDict = { wordGlossary: wordGlossaryVi } as const;

export function useWordGlossaryTranslations() {
  const { t, locale } = useI18n();
  return useCallback(
    (key: WordGlossaryMessageKey, params?: TranslationParams): string => {
      const fallback = translateMessage(
        fallbackDict,
        fallbackDict,
        locale || DEFAULT_LOCALE,
        `wordGlossary.${key}`,
        params,
        wordGlossaryVi[key],
      );
      return t(`wordGlossary.${key}`, params, fallback);
    },
    [locale, t],
  );
}
