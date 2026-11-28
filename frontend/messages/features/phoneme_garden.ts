"use client";

import { useCallback } from "react";

import { useI18n } from "@/hooks/use-i18n";
import { translateMessage } from "@/lib/i18n/formatter";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import type { TranslationParams } from "@/lib/i18n/types";

import {
  phonemeGardenEn,
  phonemeGardenVi,
  type PhonemeGardenMessageKey,
} from "./phoneme_garden_messages";

export { phonemeGardenEn, phonemeGardenVi, type PhonemeGardenMessageKey };

const fallbackDict = { phonemeGarden: phonemeGardenVi } as const;

export function usePhonemeGardenTranslations() {
  const { t, locale } = useI18n();
  return useCallback(
    (key: PhonemeGardenMessageKey, params?: TranslationParams): string => {
      const fallback = translateMessage(
        fallbackDict,
        fallbackDict,
        locale || DEFAULT_LOCALE,
        `phonemeGarden.${key}`,
        params,
        phonemeGardenVi[key],
      );
      return t(`phonemeGarden.${key}`, params, fallback);
    },
    [locale, t],
  );
}
