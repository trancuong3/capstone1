"use client";

import { Circle } from "lucide-react";

import { useI18n, useTranslations } from "@/hooks/use-i18n";

interface ReadingProgressProps {
  isListening: boolean;
  pageNumber: number;
  wordCount?: number;
  readCount?: number;
  currentWord?: string | null;
}

export function ReadingProgress({
  isListening,
  pageNumber,
  wordCount = 0,
  readCount = 0,
  currentWord,
}: ReadingProgressProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reading");

  return (
    <div
      className="mx-auto flex w-full max-w-[1104px] items-center justify-between gap-2 border-t border-border/60 px-1 pt-1 text-[11px] sm:grid sm:grid-cols-[1fr_auto] sm:items-center sm:gap-2 sm:pt-3 sm:text-sm"
      role="status"
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 font-bold text-ink sm:gap-2">
        <Circle
          aria-hidden="true"
          className="size-2 fill-current text-primary sm:size-2.5"
        />
        {isListening ? t("progress.listening") : t("progress.waiting")}
      </span>
      <span className="min-w-0 truncate text-[11px] tabular-nums text-muted sm:text-sm">
        {t("progress.pageLabel", { page: formatNumber(pageNumber) })}
        {wordCount > 0 &&
          t("progress.wordsReadSummary", {
            read: formatNumber(readCount),
            total: formatNumber(wordCount),
          })}
        {currentWord && isListening && (
          <>
            {t("progress.currentWordPrefix")}
            <span className="viread-learning-content" dir="ltr" lang="vi">
              “{currentWord}”
            </span>
          </>
        )}
      </span>
    </div>
  );
}
