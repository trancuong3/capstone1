"use client";

import { Circle } from "lucide-react";

import { useI18n, useTranslations } from "@/hooks/use-i18n";

interface ReadingProgressProps {
  isListening: boolean;
  pageNumber: number;
  wordCount?: number;
  readCount?: number;
  currentWord?: string | null;
  latestTranscript?: string | null;
}

export function ReadingProgress({
  isListening,
  pageNumber,
  wordCount = 0,
  readCount = 0,
  currentWord,
  latestTranscript,
}: ReadingProgressProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reading");

  return (
    <div
      className="mx-auto flex w-full max-w-[1104px] flex-wrap items-center justify-between gap-x-2 gap-y-0.5 border-t border-border/60 px-1 pt-1.5 text-xs"
      role="status"
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 font-bold text-ink">
        <Circle
          aria-hidden="true"
          className="size-2 fill-current text-primary"
        />
        {isListening ? t("progress.listening") : t("progress.waiting")}
      </span>
      {latestTranscript ? (
        <span
          className="viread-learning-content min-w-0 max-w-full flex-1 truncate text-center text-xs text-muted"
          data-reading-live-transcript="true"
          dir="ltr"
          lang="vi"
        >
          “{latestTranscript}”
        </span>
      ) : null}
      <span className="shrink-0 text-xs tabular-nums text-muted">
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
