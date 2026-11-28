"use client";

import { useCallback } from "react";

import { useI18n } from "@/hooks/use-i18n";
import type { TranslationParams } from "@/lib/i18n/types";

import {
  prosodyCoachEn,
  prosodyCoachVi,
  type ProsodyCoachMessageKey,
} from "./prosody_coach_messages";

export { prosodyCoachEn, prosodyCoachVi, type ProsodyCoachMessageKey };

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

export function useProsodyCoachTranslations() {
  const { t } = useI18n();
  return useCallback(
    (key: ProsodyCoachMessageKey, params?: TranslationParams): string => {
      const fallback = interpolateFallback(prosodyCoachVi[key], params);
      return t(`prosodyCoach.${key}`, params, fallback);
    },
    [t],
  );
}
