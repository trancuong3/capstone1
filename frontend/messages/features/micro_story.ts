"use client";

import { useCallback } from "react";

import { useI18n } from "@/hooks/use-i18n";
import type { TranslationParams } from "@/lib/i18n/types";

import {
  microStoryEn,
  microStoryVi,
  type MicroStoryMessageKey,
} from "./micro_story_messages";

export { microStoryEn, microStoryVi, type MicroStoryMessageKey };

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

export function useMicroStoryTranslations() {
  const { t } = useI18n();
  return useCallback(
    (key: MicroStoryMessageKey, params?: TranslationParams): string => {
      const fallback = interpolateFallback(microStoryVi[key], params);
      return t(`microStory.${key}`, params, fallback);
    },
    [t],
  );
}
