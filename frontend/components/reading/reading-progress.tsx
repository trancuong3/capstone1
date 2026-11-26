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
      className="mx-auto grid w-full max-w-[1104px] gap-2 border-t border-border px-1 pt-4 sm:grid-cols-[1fr_auto] sm:items-center"
      role="status"
    >
      <span className="inline-flex items-center gap-2 font-bold text-ink">
        <Circle
          aria-hidden="true"
          className="size-2.5 fill-current text-primary"
        />
        {isListening ? t("progress.listening") : t("progress.waiting")}
      </span>
      <span className="text-sm tabular-nums text-muted">
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
